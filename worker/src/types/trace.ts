// Trace schema — mirrors section 9 of the architecture plan and
// backend/app/trace_store.TraceStore records.

import type { ClientProtocol } from "./internal";

export type TraceStatus = "streaming" | "success" | "error" | "cancelled";

export type TraceStepType =
  | "ingress"
  | "normalize"
  | "compat"
  | "sanitize"
  | "route"
  | "worker"
  | "litellm_call"
  | "anthropic_call"
  | "openai_chat_call"
  | "openai_chat_stream"
  | "response_adapter"
  | "error";

export interface TraceStep {
  id: string;
  name: string;
  type: TraceStepType;
  startedAt: string;
  endedAt?: string;
  status: "success" | "error" | "skipped";
  summary?: string;
  error?: string;
  inputRef?: string;
  outputRef?: string;
}

export interface TraceUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface SanitizationReport {
  billingHeaderDetected: boolean;
  billingHeaderAction: string;
  cchRedacted: boolean;
  httpHeaderRemoved?: boolean;
  systemFirstLineChanged?: boolean;
}

export interface TraceRecord {
  trace_id: string;
  started_at: number;
  ended_at?: number;
  client_protocol: ClientProtocol | string;
  client_name?: string;
  incoming_model?: string;
  resolved_profile_id?: string;
  resolved_role?: string;
  upstream_provider_id?: string;
  upstream_model?: string;
  status: TraceStatus;
  latency_ms?: number;
  usage?: TraceUsage;
  sanitizer?: SanitizationReport;
  steps: TraceStep[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}
