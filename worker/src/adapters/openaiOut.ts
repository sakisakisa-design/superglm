// OpenAI output adapter — defines NormalizedCompletion (the internal completion
// shape consumed by anthropicOut.ts) and builds OpenAI Chat Completion responses
// + SSE streams. Mirrors backend/app/adapters.openai_to_anthropic_response and
// backend/app/main.openai_sse / response_from_stream_text.

import { newChatComplId } from "../utils/ids";
import { chunkText } from "../utils/stream";
import { encodeData, encodeDone } from "./sse";

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Internal normalized completion. Produced by the upstream layer regardless of
 * upstream protocol, then rendered into the client-requested protocol.
 */
export interface NormalizedCompletion {
  id?: string;
  model: string;
  content: string;
  stopReason?: string;
  reasoning?: string;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: NormalizedUsage;
  raw?: Record<string, unknown>;
}

export function emptyCompletion(model: string): NormalizedCompletion {
  return { id: newChatComplId(), model, content: "", stopReason: "stop" };
}

/** Build an OpenAI Chat Completion object from a normalized completion. */
export function buildOpenAIChatResponse(
  completion: NormalizedCompletion,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: completion.content,
  };
  if (completion.reasoning) message.reasoning_content = completion.reasoning;
  if (completion.toolCalls && completion.toolCalls.length > 0) {
    message.tool_calls = completion.toolCalls.map((call) => ({
      id: call.id ?? "call_superds",
      type: "function",
      function: { name: call.name ?? "", arguments: call.arguments ?? "" },
    }));
  }
  return {
    id: completion.id ?? newChatComplId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: completion.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: completion.stopReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: completion.usage?.inputTokens ?? 0,
      completion_tokens: completion.usage?.outputTokens ?? 0,
      total_tokens: completion.usage?.totalTokens ?? 0,
    },
  };
}

/** OpenAI Chat Completion SSE stream from a normalized completion. */
export async function* openaiChatStream(
  completion: NormalizedCompletion,
): AsyncGenerator<string, void, unknown> {
  const id = completion.id ?? newChatComplId();
  const created = Math.floor(Date.now() / 1000);
  const model = completion.model;
  for (const chunk of chunkText(completion.content)) {
    yield encodeData({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    });
  }
  yield encodeData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: completion.stopReason ?? "stop" }],
  });
  yield encodeDone();
}

/** Extract text + finish_reason from an upstream OpenAI SSE data line. */
export function openaiStreamDelta(
  data: string,
): { text: string; finishReason: string | null } {
  if (data === "[DONE]") return { text: "", finishReason: "stop" };
  try {
    const chunk = JSON.parse(data) as Record<string, unknown>;
    const choices = (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const choice = choices[0] ?? {};
    const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
    return {
      text: (delta.content as string) ?? "",
      finishReason: (choice.finish_reason as string) ?? null,
    };
  } catch {
    return { text: "", finishReason: null };
  }
}

/** Extract text, tool_call deltas, reasoning text, finish_reason from an upstream SSE line. */
export function openaiStreamParts(
  data: string,
): {
  text: string;
  toolCalls: Array<Record<string, unknown>>;
  reasoning: string;
  finishReason: string | null;
} {
  if (data === "[DONE]") return { text: "", toolCalls: [], reasoning: "", finishReason: "stop" };
  try {
    const chunk = JSON.parse(data) as Record<string, unknown>;
    const choices = (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const choice = choices[0] ?? {};
    const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
    return {
      text: (delta.content as string) ?? "",
      toolCalls: (delta.tool_calls as Array<Record<string, unknown>>) ?? [],
      reasoning: (delta.reasoning_content as string) ?? "",
      finishReason: (choice.finish_reason as string) ?? null,
    };
  } catch {
    return { text: "", toolCalls: [], reasoning: "", finishReason: null };
  }
}

/** Normalize an upstream OpenAI Chat Completion JSON response. */
export function normalizeOpenAIChat(
  resp: Record<string, unknown>,
  requestModel: string,
): NormalizedCompletion {
  const choices = (resp.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const usage = (resp.usage as Record<string, unknown> | undefined) ?? {};
  const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) ?? [];
  return {
    id: (resp.id as string) ?? newChatComplId(),
    model: requestModel,
    content: (message.content as string) ?? "",
    stopReason: (choice.finish_reason as string) ?? "stop",
    reasoning: (message.reasoning_content as string) ?? undefined,
    toolCalls: toolCalls.map((call) => {
      const fn = (call.function as Record<string, unknown>) ?? {};
      return {
        id: (call.id as string) ?? undefined,
        name: (fn.name as string) ?? undefined,
        arguments: (fn.arguments as string) ?? undefined,
      };
    }),
    usage: {
      inputTokens: (usage.prompt_tokens as number) ?? (usage.input_tokens as number) ?? 0,
      outputTokens: (usage.completion_tokens as number) ?? (usage.output_tokens as number) ?? 0,
      totalTokens: (usage.total_tokens as number) ?? 0,
    },
    raw: resp,
  };
}
