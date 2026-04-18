import { encode } from "gpt-tokenizer/model/gpt-4o"
import type { AnthropicRequest } from "./anthropic/schema.ts"

export function countTokens(req: AnthropicRequest): number {
  let total = 0
  if (req.system) {
    const text =
      typeof req.system === "string"
        ? req.system
        : req.system.map((b) => b.text || "").join("\n")
    total += encode(text).length
  }
  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      total += encode(msg.content).length
      continue
    }
    for (const block of msg.content) {
      if (block.type === "text") total += encode(block.text).length
      else if (block.type === "tool_use") total += encode(JSON.stringify(block.input ?? {})).length + encode(block.name).length
      else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : block.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
        total += encode(text).length
      }
    }
  }
  for (const tool of req.tools ?? []) {
    total += encode(tool.name).length
    if (tool.description) total += encode(tool.description).length
    total += encode(JSON.stringify(tool.input_schema ?? {})).length
  }
  // Rough per-message overhead
  total += req.messages.length * 4
  return total
}
