import { createLogger, logDir } from "./log.ts"
import type { AnthropicRequest } from "./anthropic/schema.ts"
import { assertAllowedModel, ModelNotAllowedError } from "./translate/model-allowlist.ts"
import { isTitleGenRequest, translateRequest } from "./translate/request.ts"
import { translateStream } from "./translate/stream.ts"
import { accumulateResponse } from "./translate/accumulate.ts"
import { encodeSseEvent } from "./translate/sse.ts"
import { CodexError, postCodex } from "./codex/client.ts"
import { countTokens } from "./count-tokens.ts"

const log = createLogger("server")

export interface ServeOptions {
  port: number
}

export function startServer(opts: ServeOptions): { stop: () => void; port: number } {
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url)
      const start = Date.now()
      const reqId = crypto.randomUUID()
      log.info("request", { reqId, method: req.method, path: url.pathname, query: url.search })
      try {
        const resp = await route(req, url, reqId)
        log.info("response", { reqId, status: resp.status, ms: Date.now() - start })
        return resp
      } catch (err) {
        log.error("handler error", { reqId, err: String(err), stack: (err as Error)?.stack })
        return jsonError(500, "internal_error", String(err))
      }
    },
  })
  log.info("server listening", { port: server.port, logDir: logDir() })
  return {
    port: Number(server.port),
    stop: () => server.stop(),
  }
}

async function route(req: Request, url: URL, reqId: string): Promise<Response> {
  if (url.pathname === "/healthz") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    })
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const body = (await req.json()) as AnthropicRequest
    const tokens = countTokens(body)
    log.debug("count_tokens", { reqId, tokens })
    return new Response(JSON.stringify({ input_tokens: tokens }), {
      headers: { "content-type": "application/json" },
    })
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, reqId)
  }

  return jsonError(404, "not_found", `No route for ${req.method} ${url.pathname}`)
}

async function handleMessages(req: Request, reqId: string): Promise<Response> {
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch (err) {
    return jsonError(400, "invalid_request_error", `Invalid JSON: ${err}`)
  }

  const sessionId = req.headers.get("x-claude-code-session-id") || undefined
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
  const wantStream = body.stream !== false

  log.debug("anthropic request", {
    reqId,
    model: body.model,
    messageCount: body.messages?.length,
    toolCount: body.tools?.length ?? 0,
    stream: wantStream,
    sessionId,
    hasTitleGenFormat: isTitleGenRequest(body),
  })

  // Title-generation stub: Claude Code fires this in parallel for session titles.
  if (isTitleGenRequest(body)) {
    return titleGenStub({ messageId, model: body.model, wantStream })
  }

  try {
    assertAllowedModel(body.model)
  } catch (err) {
    if (err instanceof ModelNotAllowedError) {
      return jsonError(
        400,
        "invalid_request_error",
        `Model "${err.model}" is not in the Codex OAuth allowlist`,
      )
    }
    throw err
  }

  const translated = translateRequest(body, { sessionId })
  log.debug("translated request", {
    reqId,
    inputItems: translated.input.length,
    tools: translated.tools?.length ?? 0,
    hasInstructions: !!translated.instructions,
    promptCacheKey: translated.prompt_cache_key,
  })

  let upstream
  try {
    upstream = await postCodex(translated, { sessionId, signal: req.signal })
  } catch (err) {
    if (err instanceof CodexError) {
      log.warn("codex error", { reqId, status: err.status, detail: err.detail })
      if (err.status === 429) {
        const headers: Record<string, string> = { "content-type": "application/json" }
        if (err.meta?.retryAfter) headers["retry-after"] = err.meta.retryAfter
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: err.detail || err.message },
          }),
          { status: 429, headers },
        )
      }
      const type =
        err.status === 401 || err.status === 403 ? "authentication_error" : "api_error"
      return jsonError(err.status, type, err.detail || err.message)
    }
    throw err
  }

  if (wantStream) {
    const stream = translateStream(upstream.body, { messageId, model: body.model })
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  const result = await accumulateResponse(upstream.body, { messageId, model: body.model })
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  })
}

function titleGenStub(opts: {
  messageId: string
  model: string
  wantStream: boolean
}): Response {
  const content = [{ type: "text" as const, text: JSON.stringify({ title: "Session" }) }]
  if (!opts.wantStream) {
    return new Response(
      JSON.stringify({
        id: opts.messageId,
        type: "message",
        role: "assistant",
        model: opts.model,
        content,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      { headers: { "content-type": "application/json" } },
    )
  }
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(encodeSseEvent(event, data)))
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
      emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })
      emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: content[0]!.text },
      })
      emit("content_block_stop", { type: "content_block_stop", index: 0 })
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
      emit("message_stop", { type: "message_stop" })
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}
