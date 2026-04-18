import { parseSseStream } from "./sse.ts"

export interface AnthropicNonStreamResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

/**
 * Drive the Codex SSE stream to completion and produce a single Anthropic
 * non-streaming response object. Used when the client asked for stream:false.
 */
export async function accumulateResponse(
  upstream: ReadableStream<Uint8Array>,
  opts: { messageId: string; model: string },
): Promise<AnthropicNonStreamResponse> {
  const blocks = new Map<
    number,
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; args: string }
  >()
  const itemToOutputIndex = new Map<string, number>()
  let sawToolUse = false
  let usage: any
  const orderedIndices: number[] = []

  const ensureOrder = (i: number) => {
    if (!orderedIndices.includes(i)) orderedIndices.push(i)
  }

  for await (const evt of parseSseStream(upstream)) {
    if (!evt.data) continue
    let p: any
    try {
      p = JSON.parse(evt.data)
    } catch {
      continue
    }
    const t = p.type || evt.event || ""
    if (t === "response.output_item.added") {
      const item = p.item
      const oi = p.output_index
      if (!item) continue
      if (item.type === "message") {
        blocks.set(oi, { kind: "text", text: "" })
        ensureOrder(oi)
        if (item.id) itemToOutputIndex.set(item.id, oi)
      } else if (item.type === "function_call") {
        sawToolUse = true
        blocks.set(oi, { kind: "tool", id: item.call_id, name: item.name, args: "" })
        ensureOrder(oi)
      }
      continue
    }
    if (t === "response.output_text.delta") {
      let oi = p.output_index
      if (typeof oi !== "number" && p.item_id) oi = itemToOutputIndex.get(p.item_id)
      const b = typeof oi === "number" ? blocks.get(oi) : undefined
      if (b && b.kind === "text") b.text += p.delta ?? ""
      continue
    }
    if (t === "response.function_call_arguments.delta") {
      const b = blocks.get(p.output_index)
      if (b && b.kind === "tool") b.args += p.delta ?? ""
      continue
    }
    if (t === "response.function_call_arguments.done") {
      const b = blocks.get(p.output_index)
      if (b && b.kind === "tool" && !b.args && typeof p.arguments === "string") b.args = p.arguments
      continue
    }
    if (t === "response.output_item.done") {
      const item = p.item
      const b = blocks.get(p.output_index)
      if (b && b.kind === "tool" && !b.args && typeof item?.arguments === "string") b.args = item.arguments
      continue
    }
    if (t === "response.completed") {
      usage = p.response?.usage
      continue
    }
  }

  const content: AnthropicNonStreamResponse["content"] = []
  for (const i of orderedIndices) {
    const b = blocks.get(i)
    if (!b) continue
    if (b.kind === "text") {
      if (b.text) content.push({ type: "text", text: b.text })
    } else {
      let input: unknown = {}
      try {
        input = b.args ? JSON.parse(b.args) : {}
      } catch {
        input = { _raw: b.args }
      }
      content.push({ type: "tool_use", id: b.id, name: b.name, input })
    }
  }

  return {
    id: opts.messageId,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: sawToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    },
  }
}
