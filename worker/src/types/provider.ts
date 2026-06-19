// Provider/upstream types — mirrors backend/app/alias_resolver.ResolvedModel
// and backend/app/upstream.py call shapes.

import type { ProviderProtocol, ModelRole } from "./config";

/** Result of resolving an incoming model alias to a concrete upstream target. */
export interface ResolvedModel {
  incoming_model: string;
  alias: string | null;
  profile_id: string;
  role: ModelRole;
  provider_id: string;
  provider_name: string;
  provider_protocol: ProviderProtocol;
  base_url: string;
  api_key: string;
  actual_model: string;
  litellm_model: string;
}

export interface RouteAttempt {
  providerId: string;
  model: string;
  status: "success" | "failed" | "skipped" | "streaming";
  statusCode?: number;
  reason?: string;
  error?: string;
  circuit?: CircuitSnapshot;
}

export interface CircuitSnapshot {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number;
}

export interface UpstreamCallResult {
  response: Record<string, unknown>;
  resolved: ResolvedModel;
  attempts: RouteAttempt[];
}

export interface PreparedStream {
  payload: Record<string, unknown>;
  resolved: ResolvedModel;
  attempts: RouteAttempt[];
}

/** Normalized fetch options for a single upstream HTTP call. */
export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CloudflareAiGatewayConfig {
  enabled?: boolean;
  gatewayUrl?: string;
  cfAccountId?: string;
  authToken?: string;
}
