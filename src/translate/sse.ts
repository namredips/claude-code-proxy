export interface SseEvent {
  event?: string
  data: string
}

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const evt = parseEventBlock(raw)
        if (evt) yield evt
      }
    }
    if (buf.trim()) {
      const evt = parseEventBlock(buf)
      if (evt) yield evt
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEventBlock(raw: string): SseEvent | undefined {
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "data") dataLines.push(value)
  }
  if (!dataLines.length && !event) return undefined
  return { event, data: dataLines.join("\n") }
}
