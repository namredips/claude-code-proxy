export const ALLOWED_MODELS = new Set([
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
])

export function assertAllowedModel(model: string): void {
  if (!ALLOWED_MODELS.has(model)) {
    throw new ModelNotAllowedError(model)
  }
}

export class ModelNotAllowedError extends Error {
  constructor(public model: string) {
    super(`Model not allowed: ${model}`)
    this.name = "ModelNotAllowedError"
  }
}
