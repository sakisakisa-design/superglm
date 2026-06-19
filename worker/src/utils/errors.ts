// Error normalization & typed gateway errors.

import type { SanitizationReport } from "../types/trace";
import type { ResolvedModel } from "../types/provider";
import { newStepId } from "./ids";

export class GatewayError extends Error {
  readonly status: number;
  readonly upstreamStatus?: number;
  readonly traceId: string;
  constructor(message: string, opts: { status?: number; upstreamStatus?: number; traceId?: string } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = opts.status ?? 502;
    if (opts.upstreamStatus !== undefined) this.upstreamStatus = opts.upstreamStatus;
    this.traceId = opts.traceId ?? "";
  }
}

export class UpstreamStatusError extends GatewayError {
  readonly body: string;
  constructor(status: number, body: string, traceId?: string) {
    const opts: { status: number; upstreamStatus: number; traceId?: string } = {
      status: 502,
      upstreamStatus: status,
    };
    if (traceId !== undefined) opts.traceId = traceId;
    super(`upstream returned ${status}`, opts);
    this.name = "UpstreamStatusError";
    this.body = body;
  }
}

export function errorResponse(
  status: number,
  type: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { type, message, ...extra } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface StepLike {
  id: string;
  name: string;
  type: string;
  startedAt: string;
  endedAt: string;
  status: "success" | "error" | "skipped";
  summary?: string;
  error?: string;
}

export function step(
  name: string,
  type: string,
  status: "success" | "error" | "skipped" = "success",
  summary = "",
): StepLike {
  const ts = nowIso();
  return { id: newStepId(), name, type, startedAt: ts, endedAt: ts, status, summary };
}

export function gatewayErrorRecord(
  traceId: string,
  start: number,
  incomingModel: string,
  resolved: ResolvedModel | undefined,
  sanitizer: SanitizationReport | Record<string, unknown>,
  steps: StepLike[],
  _statusCode: number,
  message: string,
) {
  const latencyMs = Date.now() - start;
  steps.push(step("Gateway Error", "error", "error", message.slice(0, 300)));
  return {
    trace_id: traceId,
    started_at: (Date.now() - latencyMs) / 1000,
    ended_at: Date.now() / 1000,
    client_protocol: "gateway",
    incoming_model: incomingModel,
    resolved_profile_id: resolved?.profile_id,
    resolved_role: resolved?.role,
    upstream_provider_id: resolved?.provider_id,
    upstream_model: resolved?.actual_model,
    status: "error" as const,
    latency_ms: latencyMs,
    usage: {},
    sanitizer,
    steps,
    request: {},
    response: { error: message },
  };
}

export function gatewayErrorResponse(
  traceId: string,
  statusCode: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "upstream_error",
        upstream_status: statusCode,
        message,
        trace_id: traceId,
      },
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
}
