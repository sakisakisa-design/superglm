// OpenAI-compatible upstream adapter. Wraps providerClient with optional
// Cloudflare AI Gateway routing. Mirrors backend/app/upstream.call_openai_chat /
// iter_openai_chat_stream.

import type { ProviderConfig } from "../types/config";
import type { CloudflareAiGatewayConfig } from "../types/provider";
import {
  callOpenAIChat,
  iterOpenAIChatStream,
  mockOpenAIResponse,
  mockOpenAIStream,
  openaiChatRequest,
  UpstreamStatusError,
} from "./providerClient";
import {
  resolveGatewaySettings,
  rewriteForGateway,
  withGatewayAuth,
} from "./cloudflareAiGateway";

export interface OpenAICompatibleCall {
  payload: Record<string, unknown>;
  provider: ProviderConfig;
  gateway?: CloudflareAiGatewayConfig;
  gatewayEnv?: { CF_AI_GATEWAY_ACCOUNT_ID?: string; CF_AI_GATEWAY_SLUG?: string; CF_AI_GATEWAY_TOKEN?: string };
}

/** Non-streaming OpenAI Chat call. Returns parsed JSON. */
export async function callOpenAICompatible(opts: OpenAICompatibleCall): Promise<Record<string, unknown>> {
  const { payload, provider } = opts;
  if (!provider.api_key || !provider.base_url) {
    return mockOpenAIResponse(payload, provider);
  }
  const settings = resolveGatewaySettings(opts.gateway, opts.gatewayEnv);
  if (!settings.enabled) {
    return callOpenAIChat(payload, provider);
  }
  const { url, body, headers } = openaiChatRequest(payload, provider, false);
  const response = await fetch(rewriteForGateway(url, settings), {
    method: "POST",
    headers: withGatewayAuth(headers, settings),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new UpstreamStatusError(response.status, errorBody.slice(0, 2000));
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Streaming OpenAI Chat call. Yields upstream `data:` payload strings. */
export async function* streamOpenAICompatible(
  opts: OpenAICompatibleCall,
): AsyncGenerator<string, void, unknown> {
  const { payload, provider } = opts;
  if (!provider.api_key || !provider.base_url) {
    yield* mockOpenAIStream(payload, provider);
    return;
  }
  const settings = resolveGatewaySettings(opts.gateway, opts.gatewayEnv);
  if (!settings.enabled) {
    yield* iterOpenAIChatStream(payload, provider);
    return;
  }
  const { url, body, headers } = openaiChatRequest(payload, provider, true);
  const response = await fetch(rewriteForGateway(url, settings), {
    method: "POST",
    headers: withGatewayAuth(headers, settings),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new UpstreamStatusError(response.status, errorBody.slice(0, 2000));
  }
  const { iterSseData } = await import("../adapters/sse");
  yield* iterSseData(response);
}
