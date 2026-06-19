// Optional Cloudflare AI Gateway integration. When enabled, upstream provider
// requests are routed through a Cloudflare AI Gateway so traffic is observable,
// cacheable, and rate-limited at the edge.
//
// Gateway URL shape:
//   https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_slug>/<provider>/<path>
//
// `provider` here is the AI Gateway provider segment (e.g. "openai", "anthropic",
// "azure-openai", "generic"). For arbitrary OpenAI-compatible endpoints we use "generic".

import type { CloudflareAiGatewayConfig } from "../types/provider";

export interface AiGatewaySettings {
  enabled: boolean;
  accountId?: string | undefined;
  gatewaySlug?: string | undefined;
  authToken?: string | undefined;
  /** AI Gateway provider segment for the URL. Defaults to "generic". */
  providerSegment?: string | undefined;
}

export function resolveGatewaySettings(
  config?: CloudflareAiGatewayConfig,
  env?: { CF_AI_GATEWAY_ACCOUNT_ID?: string; CF_AI_GATEWAY_SLUG?: string; CF_AI_GATEWAY_TOKEN?: string },
): AiGatewaySettings {
  const enabled = Boolean(config?.enabled);
  const accountId = config?.cfAccountId ?? env?.CF_AI_GATEWAY_ACCOUNT_ID;
  const gatewaySlug = config?.gatewayUrl ?? env?.CF_AI_GATEWAY_SLUG;
  return {
    enabled,
    accountId,
    gatewaySlug,
    authToken: config?.authToken ?? env?.CF_AI_GATEWAY_TOKEN,
    providerSegment: "generic",
  };
}

/**
 * Rewrite an upstream URL to route through a Cloudflare AI Gateway.
 * Returns the original URL when the gateway is not enabled or misconfigured.
 */
export function rewriteForGateway(
  upstreamUrl: string,
  settings: AiGatewaySettings,
): string {
  if (!settings.enabled || !settings.accountId || !settings.gatewaySlug) {
    return upstreamUrl;
  }
  let parsed: URL;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return upstreamUrl;
  }
  const segment = settings.providerSegment ?? "generic";
  const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${settings.accountId}/${settings.gatewaySlug}/${segment}`;
  // The AI Gateway appends the upstream host + path after the provider segment.
  return `${gatewayBase}${parsed.pathname}${parsed.search}`;
}

/** Merge a gateway auth token into an upstream headers map when enabled. */
export function withGatewayAuth(
  headers: Record<string, string>,
  settings: AiGatewaySettings,
): Record<string, string> {
  if (!settings.enabled || !settings.authToken) return headers;
  return { ...headers, "cf-aig-authorization": settings.authToken };
}
