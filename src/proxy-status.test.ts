import { describe, expect, it } from "bun:test"

import { getProxyStatus, recordProxyRequest } from "./proxy-status.ts"

describe("proxy status", () => {
  it("returns the last routed request model", () => {
    recordProxyRequest({
      req_id: "req_123",
      provider: "gemini",
      kind: "messages",
      request_model: "gemini-3-pro-preview[1m]",
      routed_model: "gemini-3-pro-preview",
      session_id: "session_123",
      session_seq: 7,
      updated_at: "2026-05-06T00:00:00.000Z",
    })

    expect(getProxyStatus()).toEqual({
      ok: true,
      last_request: {
        req_id: "req_123",
        provider: "gemini",
        kind: "messages",
        request_model: "gemini-3-pro-preview[1m]",
        routed_model: "gemini-3-pro-preview",
        session_id: "session_123",
        session_seq: 7,
        updated_at: "2026-05-06T00:00:00.000Z",
      },
    })
  })

  it("can return a session-specific request", () => {
    recordProxyRequest({
      req_id: "req_global",
      provider: "codex",
      kind: "messages",
      request_model: "gpt-5.5[1m]",
      routed_model: "gpt-5.5",
      session_id: "session_global",
      session_seq: 1,
      updated_at: "2026-05-06T00:00:01.000Z",
    })
    recordProxyRequest({
      req_id: "req_other",
      provider: "gemini",
      kind: "messages",
      request_model: "gemini-3-pro-preview[1m]",
      routed_model: "gemini-3-pro-preview",
      session_id: "session_other",
      session_seq: 1,
      updated_at: "2026-05-06T00:00:02.000Z",
    })

    expect(getProxyStatus("session_global").last_request?.routed_model).toBe("gpt-5.5")
    expect(getProxyStatus("missing").last_request?.routed_model).toBe("gemini-3-pro-preview")
  })
})
