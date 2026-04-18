import { encodeSseEvent, parseSseStream } from "./sse.ts"
import { createLogger } from "../log.ts"

const log = createLogger("translate.stream")

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface TextBlockState {
  kind: "text"
  index: number
}

interface ToolBlockState {
  kind: "tool"
  index: number
  itemId: string
  callId: string
  name: string
  argsAccum: string
  hadDelta: boolean
}

type BlockState = TextBlockState | ToolBlockState

export interface StreamTranslateOptions {
  messageId: string
  model: string
  // If provided, writes translated events here; otherwise returns a ReadableStream
  onEvent?: (event: string, data: unknown) => void
}

/**
 * Translate a Codex Responses SSE stream into Anthropic SSE events.
 * Returns a ReadableStream<Uint8Array> of Anthropic SSE ready to pipe to client.
 */
export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  opts: { messageId: string; model: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)))
      }
      try {
        await runStream(upstream, opts, emit)
      } catch (err) {
        log.error("stream translation error", { err: String(err) })
        emit("error", { type: "error", error: { type: "api_error", message: String(err) } })
      } finally {
        controller.close()
      }
    },
  })
}

async function runStream(
  upstream: ReadableStream<Uint8Array>,
  opts: { messageId: string; model: string },
  emit: (event: string, data: unknown) => void,
): Promise<void> {
  let messageStarted = false
  let anthropicIndex = 0
  // Keyed by output_index
  const blocksByIndex = new Map<number, BlockState>()
  // Map item_id → output_index for text deltas
  const itemToOutputIndex = new Map<string, number>()
  let sawToolUse = false
  let finalUsage: CodexUsage | undefined
  let incomplete = false
  let rateLimitReached = false
  let rateLimitResetSeconds: number | undefined

  const ensureMessageStart = () => {
    if (messageStarted) return
    messageStarted = true
    emit("message_start", {
      type: "message_start",
      message: {
        id: opts.messageId,
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })
    emit("ping", { type: "ping" })
  }

  for await (const evt of parseSseStream(upstream)) {
    if (!evt.data) continue
    let payload: any
    try {
      payload = JSON.parse(evt.data)
    } catch {
      log.warn("invalid json in sse data", { data: evt.data.slice(0, 200) })
      continue
    }
    const type: string = payload.type || evt.event || ""

    if (type === "codex.rate_limits") {
      if (payload.rate_limits?.limit_reached) {
        rateLimitReached = true
        rateLimitResetSeconds = payload.rate_limits?.primary?.reset_after_seconds
      }
      continue
    }

    if (type === "response.created" || type === "response.in_progress") {
      ensureMessageStart()
      continue
    }

    if (type === "response.output_item.added") {
      const item = payload.item
      const outputIndex: number = payload.output_index
      if (!item) continue
      if (item.type === "reasoning") {
        // drop
        continue
      }
      if (item.type === "message") {
        ensureMessageStart()
        const idx = anthropicIndex++
        const state: TextBlockState = { kind: "text", index: idx }
        blocksByIndex.set(outputIndex, state)
        if (item.id) itemToOutputIndex.set(item.id, outputIndex)
        emit("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "text", text: "" },
        })
        continue
      }
      if (item.type === "function_call") {
        ensureMessageStart()
        sawToolUse = true
        const idx = anthropicIndex++
        const state: ToolBlockState = {
          kind: "tool",
          index: idx,
          itemId: item.id,
          callId: item.call_id,
          name: item.name,
          argsAccum: "",
          hadDelta: false,
        }
        blocksByIndex.set(outputIndex, state)
        emit("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: {},
          },
        })
        continue
      }
      continue
    }

    if (type === "response.output_text.delta") {
      const outputIndex: number | undefined = payload.output_index
      const itemId: string | undefined = payload.item_id
      let state: BlockState | undefined
      if (typeof outputIndex === "number") state = blocksByIndex.get(outputIndex)
      if (!state && itemId) {
        const mapped = itemToOutputIndex.get(itemId)
        if (mapped !== undefined) state = blocksByIndex.get(mapped)
      }
      if (!state || state.kind !== "text") continue
      const delta: string = payload.delta ?? ""
      if (!delta) continue
      emit("content_block_delta", {
        type: "content_block_delta",
        index: state.index,
        delta: { type: "text_delta", text: delta },
      })
      continue
    }

    if (type === "response.function_call_arguments.delta") {
      const outputIndex: number = payload.output_index
      const state = blocksByIndex.get(outputIndex)
      if (!state || state.kind !== "tool") continue
      const delta: string = payload.delta ?? ""
      if (!delta) continue
      state.argsAccum += delta
      state.hadDelta = true
      emit("content_block_delta", {
        type: "content_block_delta",
        index: state.index,
        delta: { type: "input_json_delta", partial_json: delta },
      })
      continue
    }

    if (type === "response.function_call_arguments.done") {
      // Full args available; nothing to emit here (deltas already sent, or
      // we flush on output_item.done if none were sent).
      const outputIndex: number = payload.output_index
      const state = blocksByIndex.get(outputIndex)
      if (!state || state.kind !== "tool") continue
      if (typeof payload.arguments === "string" && !state.argsAccum) {
        state.argsAccum = payload.arguments
      }
      continue
    }

    if (type === "response.output_item.done") {
      const item = payload.item
      const outputIndex: number = payload.output_index
      if (!item) continue
      if (item.type === "reasoning") continue
      const state = blocksByIndex.get(outputIndex)
      if (!state) continue
      if (state.kind === "tool") {
        if (!state.hadDelta) {
          const finalArgs =
            (typeof item.arguments === "string" && item.arguments.length
              ? item.arguments
              : state.argsAccum) || ""
          if (finalArgs.length) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index: state.index,
              delta: { type: "input_json_delta", partial_json: finalArgs },
            })
          }
        }
      }
      emit("content_block_stop", { type: "content_block_stop", index: state.index })
      blocksByIndex.delete(outputIndex)
      continue
    }

    if (type === "response.completed" || type === "response.incomplete") {
      finalUsage = payload.response?.usage
      const reason = payload.response?.incomplete_details?.reason
      if (type === "response.incomplete" || reason === "max_output_tokens" || payload.response?.status === "incomplete") {
        incomplete = true
      }
      continue
    }

    if (type === "response.failed" || type === "response.error" || type === "error") {
      const message = payload?.response?.error?.message || payload?.error?.message || "Upstream error"
      emit("error", { type: "error", error: { type: "api_error", message } })
      return
    }
  }

  if (!messageStarted) {
    // Upstream produced nothing — still emit a minimal envelope so Claude Code doesn't hang.
    ensureMessageStart()
  }

  if (rateLimitReached) {
    emit("error", {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `rate limit reached; retry after ${rateLimitResetSeconds ?? "?"}s`,
      },
    })
    return
  }

  const usage = mapUsage(finalUsage)
  emit("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: incomplete ? "max_tokens" : sawToolUse ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage,
  })
  emit("message_stop", { type: "message_stop" })
}

function mapUsage(u: CodexUsage | undefined): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
  }
}
