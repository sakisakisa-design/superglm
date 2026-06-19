// Low-level upstream HTTP client — mirrors backend/app/upstream.py.
// Uses the Workers runtime fetch (no httpx). Produces mock responses when an
// upstream provider has no API key / base URL configured (same behaviour as the
// local edition, so the gateway is usable before keys are set).

import type { ProviderConfig } from "../types/config";
import { iterSseData } from "../adapters/sse";
import { newChatComplId } from "../utils/ids";

export function joinUrl(baseUrl: string, suffix: string): string {
  return baseUrl.replace(/\/+$/, "") + "/" + suffix.replace(/^\/+/, "");
}

export class UpstreamStatusError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`upstream returned ${status}`);
    this.name = "UpstreamStatusError";
    this.status = status;
    this.body = body;
  }
}

/** Build OpenAI Chat Completions request (url, headers, body). Mirrors openai_chat_request. */
export function openaiChatRequest(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  stream: boolean,
): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const body: Record<string, unknown> = { ...payload };
  delete body._superds_sanitized_headers;
  body.stream = stream;
  return {
    url: joinUrl(provider.base_url, "chat/completions"),
    body,
    headers: {
      Authorization: `Bearer ${provider.api_key ?? ""}`,
      "Content-Type": "application/json",
    },
  };
}

/** Build Anthropic Messages request. Mirrors call_anthropic_messages header set. */
export function anthropicMessagesRequest(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  stream: boolean,
): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const body: Record<string, unknown> = { ...payload };
  delete body._superds_sanitized_headers;
  body.stream = stream;
  const version = (body.anthropic_version as string) ?? "2023-06-01";
  delete body.anthropic_version;
  return {
    url: joinUrl(provider.base_url, "messages"),
    body,
    headers: {
      "x-api-key": provider.api_key ?? "",
      "anthropic-version": version,
      "content-type": "application/json",
    },
  };
}

/** Mock OpenAI response when no upstream key/base_url is configured. Mirrors mock_openai_response. */
export function mockOpenAIResponse(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  reason = "missing_upstream_api_key",
): Record<string, unknown> {
  let prompt = "";
  for (const msg of (payload.messages as Array<Record<string, unknown>>) ?? []) {
    if (msg.role === "user") prompt = String(msg.content ?? "");
  }
  const name = provider.name ?? provider.id;
  let text = `Super DeepSeek 网关已接到请求。当前没有配置 \`${name}\` 的上游 API Key，所以返回本地 mock 响应。配好密钥后，同一个端点会转发到真实模型。`;
  if (prompt) text += `\n\n收到的用户输入预览：${prompt.slice(0, 180)}`;
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-superds-${now}`,
    object: "chat.completion",
    created: now,
    model: (payload.model as string) ?? provider.default_model ?? "superds",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: Math.floor(prompt.length / 4),
      completion_tokens: Math.floor(text.length / 4),
      total_tokens: Math.floor((prompt.length + text.length) / 4),
    },
    _superds_mock_reason: reason,
  };
}

/** Mock OpenAI stream (yields data lines) when no upstream key/base_url is configured. */
export async function* mockOpenAIStream(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
): AsyncGenerator<string, void, unknown> {
  const mock = mockOpenAIResponse(payload, provider);
  const text = (((mock.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>)?.content as string) ?? "";
  const id = (mock.id as string) ?? newChatComplId();
  const created = (mock.created as number) ?? Math.floor(Date.now() / 1000);
  const model = (mock.model as string) ?? "superds";
  yield JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  yield JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  yield "[DONE]";
}

/** Non-streaming OpenAI Chat call. Mirrors call_openai_chat. */
export async function callOpenAIChat(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  timeoutMs = 300000,
): Promise<Record<string, unknown>> {
  if (!provider.api_key || !provider.base_url) {
    return mockOpenAIResponse(payload, provider);
  }
  const { url, body, headers } = openaiChatRequest(payload, provider, false);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new UpstreamStatusError(response.status, errorBody.slice(0, 2000));
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Streaming OpenAI Chat call. Yields upstream `data:` payload strings. Mirrors iter_openai_chat_stream. */
export async function* iterOpenAIChatStream(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  timeoutMs = 300000,
): AsyncGenerator<string, void, unknown> {
  if (!provider.api_key || !provider.base_url) {
    yield* mockOpenAIStream(payload, provider);
    return;
  }
  const { url, body, headers } = openaiChatRequest(payload, provider, true);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new UpstreamStatusError(response.status, errorBody.slice(0, 2000));
  }
  yield* iterSseData(response);
}

/** Non-streaming Anthropic Messages call. Mirrors call_anthropic_messages. */
export async function callAnthropicMessages(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  timeoutMs = 300000,
): Promise<Record<string, unknown>> {
  if (!provider.api_key || !provider.base_url) {
    return mockAnthropicResponse(payload, provider);
  }
  const { url, body, headers } = anthropicMessagesRequest(payload, provider, false);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new UpstreamStatusError(response.status, errorBody.slice(0, 2000));
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Mock Anthropic response when no upstream key/base_url is configured. */
export function mockAnthropicResponse(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  reason = "missing_upstream_api_key",
): Record<string, unknown> {
  let prompt = "";
  for (const msg of (payload.messages as Array<Record<string, unknown>>) ?? []) {
    if (msg.role === "user") {
      const c = msg.content;
      if (typeof c === "string") prompt = c;
      else if (Array.isArray(c)) {
        prompt = c
          .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
          .map((b) => ((b as Record<string, unknown>).text as string) ?? "")
          .join("\n");
      }
    }
  }
  const name = provider.name ?? provider.id;
  let text = `Super DeepSeek 网关已接到 Anthropic 兼容请求。当前没有配置 \`${name}\` 的上游 API Key，所以返回本地 mock 响应。`;
  if (prompt) text += `\n\n收到的用户输入预览：${prompt.slice(0, 180)}`;
  return {
    id: `msg_superds_${Math.floor(Date.now() / 1000)}`,
    type: "message",
    role: "assistant",
    model: (payload.model as string) ?? provider.default_model ?? "superds",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: Math.max(1, Math.floor(prompt.length / 4)), output_tokens: Math.max(1, Math.floor(text.length / 4)) },
    _superds_mock_reason: reason,
  };
}
