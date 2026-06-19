// SuperDeepSeek config document — mirrors backend/app/defaults.py default_config().
// The entire config is persisted as one JSON blob in D1 (config table).

export type ProviderProtocol = "openai" | "anthropic";

export type ModelRole = "main" | "fast_tool" | "large" | "verifier" | "vision" | "fallback";

export type ReasoningState = "none" | "reasoning_content" | "mimo_reasoning_content" | "anthropic_thinking";

export type BillingHeaderPolicy =
  | "strip_for_non_anthropic_upstream"
  | "strip"
  | "always-strip"
  | "canonicalize"
  | "pass_through";

export type RuntimeMode = "passthrough" | "observe" | "augment" | "strict";

export type ImagePolicy = "reject" | "route" | "ocr";

export interface ModelCapabilities {
  api_format?: string;
  vision?: boolean | null;
  vision_status?: "unknown" | "verified_supported" | "verified_unsupported";
  tools?: boolean;
  reasoning_state?: ReasoningState;
  preserve_opaque_reasoning?: boolean;
  vision_checked_at?: number;
  [k: string]: unknown;
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  base_url: string;
  api_key_env?: string;
  /** Plaintext key only present in the internal (non-public) config view. */
  api_key?: string;
  default_model?: string;
  capabilities?: ModelCapabilities;
  test_model?: string;
  degraded_threshold_ms?: number;
  [k: string]: unknown;
}

export interface ModelConfig {
  id: string;
  provider_id: string;
  litellm_model: string;
  actual_model: string;
  role: ModelRole;
  capabilities?: ModelCapabilities;
  source?: string;
  [k: string]: unknown;
}

export interface FailoverMap {
  main?: string[];
  fast_tool?: string[];
  large?: string[];
  verifier?: string[];
  vision?: string[];
  fallback?: string[];
  default?: string[];
  [k: string]: string[] | undefined;
}

export interface ProfileConfig {
  id: string;
  name: string;
  main_model?: string;
  fast_tool_model?: string;
  large_model?: string;
  verifier_model?: string;
  vision_model?: string;
  fallback_model?: string;
  failover?: FailoverMap;
  [k: string]: unknown;
}

export interface ModelAlias {
  alias: string;
  profile_id: string;
  role: ModelRole;
  enabled?: boolean;
  [k: string]: unknown;
}

export interface CircuitBreakerConfig {
  failure_threshold?: number;
  success_threshold?: number;
  timeout_seconds?: number;
}

export interface ServerConfig {
  host?: string;
  port?: number;
  public_base_url?: string;
  [k: string]: unknown;
}

export interface SecurityConfig {
  local_api_key?: string;
  bind_localhost_only?: boolean;
  redact_secrets_in_logs?: boolean;
  [k: string]: unknown;
}

export interface RuntimeConfig {
  mode?: RuntimeMode;
  default_profile?: string;
  trace_retention_days?: number;
  image_policy?: ImagePolicy;
  circuit_breaker?: CircuitBreakerConfig;
  [k: string]: unknown;
}

export interface ClaudeCodeCompatConfig {
  enabled?: boolean;
  billing_header_policy?: BillingHeaderPolicy;
  expose_claude_aliases?: boolean;
  require_haiku_alias?: boolean;
  [k: string]: unknown;
}

export interface SuperDeepSeekConfig {
  server?: ServerConfig;
  security?: SecurityConfig;
  runtime?: RuntimeConfig;
  claude_code_compat?: ClaudeCodeCompatConfig;
  providers: ProviderConfig[];
  models: ModelConfig[];
  profiles: ProfileConfig[];
  model_aliases: ModelAlias[];
  fusion_plans?: Record<string, FusionPlanConfig>;
  [k: string]: unknown;
}

export interface PanelModelSpec {
  model: string;
  provider_id?: string;
  temperature?: number;
}

export interface FusionPlanConfig {
  strategy: "fusion" | "self_consistency";
  panel_models?: PanelModelSpec[];
  self_consistency?: { model: string; provider_id?: string; samples: number; temperatures?: number[] };
  judge_model: string;
  judge_provider_id?: string;
  synthesizer_model: string;
  synthesizer_provider_id?: string;
  max_tokens_per_panel?: number;
  timeout_ms?: number;
  blocked_domains?: string[];
}

export const PROFILE_MODEL_KEYS: Record<ModelRole, string> = {
  main: "main_model",
  fast_tool: "fast_tool_model",
  large: "large_model",
  verifier: "verifier_model",
  vision: "vision_model",
  fallback: "fallback_model",
};
