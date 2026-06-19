// OpenAI Chat Completions input adapter. Mirrors backend/app/adapters.openai_payload:
// the OpenAI chat shape is passed through with the incoming model swapped for the
// resolved target model. No billing-header system-line sanitization is needed here
// (that is Anthropic-specific); HTTP identity headers are handled by the compat layer.

export function openaiChatPayload(
  body: Record<string, unknown>,
  targetModel: string,
): Record<string, unknown> {
  return { ...body, model: targetModel };
}
