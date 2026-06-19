// Anthropic-compatible upstream adapter. Wraps providerClient for the Anthropic
// Messages protocol (used when the resolved upstream provider speaks Anthropic).
// Mirrors backend/app/upstream.call_anthropic_messages.

import type { ProviderConfig } from "../types/config";
import type { CloudflareAiGatewayConfig } from "../types/provider";
import {
  anthropicMessagesRequest,
  callAnthropicMessages,
  mockAnthropicResponse,
  UpstreamStatusError,
} from "./providerClient";
import {
  resolveGatewaySettings,
  rewriteForGateway,
  withGatewayAuth,
} from "./cloudflareAiGateway";

export interface AnthropicCompatibleCall {
  payload: Record<string, unknown>;
  provider: ProviderConfig;
  gateway?: CloudflareAiGatewayConfig;
  gatewayEnv?: { CF_AI_GATEWAY_ACCOUNT_ID?: string; CF_AI_GATEWAY_SLUG?: string; CF_AI_GATEWAY_TOKEN?: string };
}

/** Non-streaming Anthropic Messages call. Returns parsed JSON. */
export async function callAnthropicCompatible(opts: AnthropicCompatibleCall): Promise<Record<string, unknown>> {
  const { payload, provider } = opts;
  if (!provider.api_key || !provider.base_url) {
    return mockAnthropicResponse(payload, provider);
  }
  const settings = resolveGatewaySettings(opts.gateway, opts.gatewayEnv);
  if (!settings.enabled) {
    return callAnthropicMessages(payload, provider);
  }
  const { url, body, headers } = anthropicMessagesRequest(payload, provider, false);
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

/** Build an Anthropic Messages passthrough payload from an Anthropic request body. */
export function anthropicPassthroughBody(
  body: Record<string, unknown>,
  targetModel: string,
): Record<string, unknown> {
  return { ...body, model: targetModel };
}
