export interface LastProxyRequest {
  req_id: string
  provider: string
  kind: "messages" | "count_tokens"
  request_model: string
  routed_model: string
  session_id?: string
  session_seq?: number
  updated_at: string
}

let lastRequest: LastProxyRequest | null = null
const requestsBySession = new Map<string, LastProxyRequest>()

export function recordProxyRequest(request: LastProxyRequest): void {
  lastRequest = request
  if (request.session_id) {
    requestsBySession.set(request.session_id, request)
  }
}

export function getProxyStatus(sessionId?: string): { ok: true; last_request: LastProxyRequest | null } {
  return {
    ok: true,
    last_request: sessionId ? requestsBySession.get(sessionId) ?? lastRequest : lastRequest,
  }
}
