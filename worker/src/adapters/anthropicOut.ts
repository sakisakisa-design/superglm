import { newMessageId } from "../utils/ids";
import { chunkText } from "../utils/stream";
import { encodeDone, encodeSseEvent } from "./sse";
import type { NormalizedCompletion } from "./openaiOut";

export function buildAnthropicMessagesResponse(
  completion: NormalizedCompletion,
): Record<string, unknown> {
  const id = completion.id ?? newMessageId();
  const inputTokens = completion.usage?.inputTokens ?? 0;
  const outputTokens = completion.usage?.outputTokens ?? 0;
  return {
    id,
    type: "message",
    role: "assistant",
    model: completion.model,
    content: [{ type: "text", text: completion.content }],
    stop_reason: completion.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export async function* anthropicMessagesStream(
  completion: NormalizedCompletion,
): AsyncGenerator<string, void, unknown> {
  const id = completion.id ?? newMessageId();

  yield encodeSseEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: completion.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: completion.usage?.inputTokens ?? 0,
        output_tokens: 1,
      },
    },
  });

  yield encodeSseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  for (const chunk of chunkText(completion.content)) {
    yield encodeSseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
  }

  yield encodeSseEvent("content_block_stop", { type: "content_block_stop", index: 0 });

  yield encodeSseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: completion.stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: completion.usage?.outputTokens ?? 0 },
  });

  yield encodeSseEvent("message_stop", { type: "message_stop" });

  yield encodeDone();
}
