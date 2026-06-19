// Request pipeline — the Cloudflare-native gateway runtime. Mirrors the request
// flow in backend/app/main.py (anthropic_messages / openai_chat / openai_responses)
// using the Phase 1 storage + compat + adapter contracts.
//
// Flow per request:
//   ingress (auth, trace id, header capture)
//   -> normalize (protocol adapter in)
//   -> sanitize (billing headers + Anthropic system-first-line cch strip)
//   -> resolve (alias -> target model + provider, with failover candidates)
//   -> route + upstream call (circuit-broken failover)
//   -> adapt out (to client protocol, streaming or buffered)
//   -> trace (redacted, persisted to D1)

import type { Env } from "../types/internal";
import type { ProviderConfig, FusionPlanConfig } from "../types/config";
import type { TraceRecord, SanitizationReport } from "../types/trace";
import type { ConfigStore, StoredAlias } from "../storage/configStore";
import type { TraceStore } from "../storage/traceStore";
import type { ProviderRouter } from "../upstream/router";
import { resolveAlias, type AliasRule } from "../compat/aliasResolver";
import {
  anthropicToOpenaiPayload,
  anthropicPassthroughPayload,
  roughCountTokens,
  type SystemSanitizationReport,
} from "../adapters/anthropicIn";
import { openaiChatPayload } from "../adapters/openaiIn";
import {
  responsesToChatPayload,
  buildResponsesResponse,
} from "../adapters/responsesIn";
import {
  normalizeOpenAIChat,
  openaiStreamDelta,
  type NormalizedCompletion,
} from "../adapters/openaiOut";
import { buildAnthropicMessagesResponse, anthropicMessagesStream } from "../adapters/anthropicOut";
import { encodeSseEvent, encodeData, encodeDone } from "../adapters/sse";
import { newTraceId, newMessageId, newResponseId, newShortMessageId, newChatComplId } from "../utils/ids";
import { redact } from "../utils/redact";
import { step, type StepLike } from "../utils/errors";
import { UpstreamStatusError } from "../upstream/providerClient";
import { callAnthropicCompatible } from "../upstream/anthropicCompatible";
import {
  detectImages,
  makeEvidencePackets,
  evidenceSystemMessage,
  injectEvidenceIntoChatPayload,
} from "../runtime/evidence";
import { effectiveMode } from "./modes";
import {
  runFusionPipeline,
  runFusionStream,
  panelResponsesForTrace,
  FusionConfigError,
} from "./fusion";
import type { PanelResponse } from "./fusion";

export interface PipelineDeps {
  env: Env;
  store: ConfigStore;
  traces: TraceStore;
  router: ProviderRouter;
  mode?: string | undefined;
  fusionPlans?: Record<string, FusionPlanConfig> | undefined;
}

export interface RequestContext {
  deps: PipelineDeps;
  request: Request;
  path: string;
  method: string;
}

interface ResolvedTarget {
  targetModel: string;
  alias?: StoredAlias | undefined;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";

function getFusionPlan(ctx: RequestContext, alias: StoredAlias | undefined): FusionPlanConfig | null {
  if (!alias) return null;
  const strategy = (alias as Record<string, unknown>).strategy as string | undefined;
  if (strategy !== "fusion" && strategy !== "self_consistency") return null;
  const plans = ctx.deps.fusionPlans;
  if (!plans) return null;
  return plans[alias.alias] ?? plans[alias.target_model] ?? null;
}

function findMatchingAlias(aliases: StoredAlias[], incomingModel: string): StoredAlias | undefined {
  const exact = aliases.find((a) => a.alias === incomingModel);
  if (exact) return exact;
  for (const a of aliases) {
    if (!a.alias.includes("*")) continue;
    if (wildcardMatch(a.alias, incomingModel) !== null) return a;
  }
  return undefined;
}

function wildcardMatch(pattern: string, model: string): string | null {
  const idx = pattern.indexOf("*");
  if (idx < 0) return pattern === model ? "" : null;
  const prefix = pattern.slice(0, idx);
  const suffix = pattern.slice(idx + 1);
  const minLen = prefix.length + suffix.length;
  if (model.length >= minLen && model.startsWith(prefix) && model.endsWith(suffix)) {
    return model.slice(prefix.length, model.length - suffix.length);
  }
  return null;
}

async function resolveTarget(store: ConfigStore, incomingModel: string): Promise<ResolvedTarget> {
  const aliases = await store.listAliases();
  const rules: AliasRule[] = aliases.map((a) => ({ alias: a.alias, target: a.target_model }));
  const targetModel = resolveAlias(incomingModel, rules);
  const alias = findMatchingAlias(aliases, incomingModel);
  return { targetModel, alias };
}

function sessionKey(request: Request, body: Record<string, unknown>): string {
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.session_id === "string") return meta.session_id;
  return request.headers.get("x-superds-session-id") ?? request.headers.get("user-agent")?.slice(0, 120) ?? "default";
}

function usageFromOpenAI(resp: Record<string, unknown>): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const u = (resp.usage as Record<string, unknown>) ?? {};
  return {
    inputTokens: (u.prompt_tokens as number) ?? (u.input_tokens as number) ?? 0,
    outputTokens: (u.completion_tokens as number) ?? (u.output_tokens as number) ?? 0,
    totalTokens: (u.total_tokens as number) ?? 0,
  };
}

function usageFromAnthropic(resp: Record<string, unknown>): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const u = (resp.usage as Record<string, unknown>) ?? {};
  const input = (u.input_tokens as number) ?? 0;
  const output = (u.output_tokens as number) ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: (u.total_tokens as number) ?? input + output };
}

function normalizeAnthropicResponse(resp: Record<string, unknown>, requestModel: string): NormalizedCompletion {
  const content = (resp.content as Array<Record<string, unknown>>) ?? [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => (b.text as string) ?? "")
    .join("");
  const usage = usageFromAnthropic(resp);
  return {
    id: (resp.id as string) ?? newMessageId(),
    model: requestModel,
    content: text,
    stopReason: (resp.stop_reason as string) ?? "end_turn",
    usage,
    raw: resp,
  };
}

function traceRecord(
  partial: Record<string, unknown> & { trace_id: string; status: TraceRecord["status"]; steps: StepLike[] },
): TraceRecord {
  const steps = partial.steps as TraceRecord["steps"];
  return {
    started_at: Date.now() / 1000,
    ended_at: Date.now() / 1000,
    client_protocol: "gateway",
    ...partial,
    steps,
  } as TraceRecord;
}

async function writeTrace(ctx: RequestContext, record: TraceRecord): Promise<void> {
  if (effectiveMode(ctx.deps.mode) === "passthrough") return;
  try {
    await ctx.deps.traces.create({ ...record, method: ctx.method, path: ctx.path });
  } catch {
    // trace failures must never break the request
  }
}

const EMPTY_SANITIZER: SanitizationReport = {
  billingHeaderDetected: false,
  billingHeaderAction: "none",
  cchRedacted: false,
};

function sanitizeReportToRecord(report?: SystemSanitizationReport): SanitizationReport {
  if (!report) return EMPTY_SANITIZER;
  return {
    billingHeaderDetected: report.billingHeaderDetected,
    billingHeaderAction: report.billingHeaderAction,
    cchRedacted: report.cchRedacted,
    systemFirstLineChanged: report.systemFirstLineChanged,
  };
}

function streamToResponse(gen: AsyncGenerator<string, void, unknown>, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of gen) controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...headers },
  });
}

// ---------------------------------------------------------------------------
// /v1/messages  (Anthropic-compatible)
// ---------------------------------------------------------------------------

export async function handleAnthropicMessages(ctx: RequestContext, body: Record<string, unknown>): Promise<Response> {
  const { deps, request } = ctx;
  const incomingModel = (body.model as string) ?? DEFAULT_ANTHROPIC_MODEL;
  const { targetModel, alias } = await resolveTarget(deps.store, incomingModel);
  const wantStream = Boolean(body.stream);
  const start = Date.now();
  const traceId = newTraceId();
  const steps: StepLike[] = [
    step("Ingress", "ingress", "success", "Captured Anthropic-compatible request"),
    step("Alias Resolver", "compat", "success", `${incomingModel} -> ${targetModel}`),
  ];

  const fusionPlan = getFusionPlan(ctx, alias);
  if (fusionPlan) {
    return handleFusionAsAnthropic(ctx, body, fusionPlan, incomingModel, targetModel, traceId, wantStream, steps);
  }

  // Resolve provider to decide upstream protocol (anthropic passthrough vs openai conversion).
  const candidates = await deps.router.resolveCandidates(targetModel, alias?.provider_id ?? undefined);
  const provider = candidates[0];
  const upstreamProtocol = provider?.protocol ?? "openai";

  let payload: Record<string, unknown>;
  let sanReport: SystemSanitizationReport | undefined;
  if (upstreamProtocol === "anthropic") {
    const r = anthropicPassthroughPayload(body, targetModel, "strip_for_non_anthropic_upstream", "anthropic");
    payload = r.payload;
    sanReport = r.report;
  } else {
    const r = anthropicToOpenaiPayload(body, targetModel, "strip_for_non_anthropic_upstream", "openai");
    payload = r.payload;
    sanReport = r.report;
  }
  steps.push(step("Billing Header Sanitizer", "sanitize", "success", sanReport.billingHeaderAction));

  // Multimodal: detect images and inject evidence when the upstream is not vision-capable.
  const images = detectImages("anthropic", body);
  let forcedEvidenceNote = "";
  if (images.length > 0) {
    const packets = makeEvidencePackets(images, sessionKey(request, body));
    payload = injectEvidenceIntoChatPayload(payload, evidenceSystemMessage(packets));
    forcedEvidenceNote = `${packets.length} image(s) -> evidence packet`;
    steps.push(step("Vision Evidence", "worker", "success", forcedEvidenceNote));
  }

  const baseRequest = {
    headers: redact(Object.fromEntries(request.headers.entries())),
    body: redact(body),
    upstream_payload: redact({ ...payload, model: targetModel }),
    sanitizer: sanitizeReportToRecord(sanReport),
  };

  try {
    if (upstreamProtocol === "anthropic") {
      // Anthropic upstream: buffered call, then re-stream if requested (mirrors local edition).
      if (!provider) throw new Error("No available provider candidates");
      const response = await callAnthropicCompatible({ payload, provider });
      steps.push(step("Provider Router", "route", "success", `1 attempt, final=${provider.id}`));
      steps.push(step("Upstream Call", "anthropic_call", "success", `${provider.name} / ${targetModel}`));
      steps.push(step("Response Adapter", "response_adapter", "success", "Anthropic response passthrough"));
      const latencyMs = Date.now() - start;
      const completion = normalizeAnthropicResponse(response, incomingModel);
      const trace = traceRecord({
        trace_id: traceId,
        status: "success",
        latency_ms: latencyMs,
        client_protocol: "anthropic",
        client_name: "claude-code",
        incoming_model: incomingModel,
        upstream_model: targetModel,
        upstream_provider_id: provider.id,
        usage: usageFromAnthropic(response),
        steps,
        request: baseRequest,
        response: redact(response),
      });
      await writeTrace(ctx, trace);
      if (wantStream) {
        return streamToResponse(anthropicMessagesStream(completion), { "x-superds-trace-id": traceId });
      }
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json", "x-superds-trace-id": traceId },
      });
    }

    // OpenAI-protocol upstream.
    if (wantStream) {
      payload.stream = true;
      steps.push(step("Provider Router", "route", "success", "streaming"));
      steps.push(step("Upstream Stream", "openai_chat_stream", "success", `${provider?.name} / ${targetModel}`));
      const base = {
        trace_id: traceId,
        client_protocol: "anthropic",
        client_name: "claude-code",
        incoming_model: incomingModel,
        upstream_model: targetModel,
        upstream_provider_id: provider?.id,
        sanitizer: sanitizeReportToRecord(sanReport),
        request: baseRequest,
      };
      return streamToResponse(
        streamOpenAIAsAnthropic(ctx, payload, targetModel, incomingModel, alias?.provider_id ?? undefined, start, steps, base),
        { "x-superds-trace-id": traceId },
      );
    }

    const routed = await deps.router.callOpenAIChatWithFailover(payload, targetModel, { pinnedProviderId: alias?.provider_id ?? undefined });
    steps.push(step("Provider Router", "route", "success", `${routed.attempts.length} attempt(s), final=${routed.provider.id}`));
    steps.push(step("Upstream Call", "openai_chat_call", "success", `${routed.provider.name} / ${targetModel}`));
    const completion = normalizeOpenAIChat(routed.response, incomingModel);
    const response = buildAnthropicMessagesResponse(completion);
    steps.push(step("Response Adapter", "response_adapter", "success", "OpenAI response -> Anthropic message"));
    const latencyMs = Date.now() - start;
    await writeTrace(ctx, traceRecord({
      trace_id: traceId,
      status: "success",
      latency_ms: latencyMs,
      client_protocol: "anthropic",
      client_name: "claude-code",
      incoming_model: incomingModel,
      upstream_model: targetModel,
      upstream_provider_id: routed.provider.id,
      usage: usageFromOpenAI(routed.response),
      steps,
      request: { ...baseRequest, route_attempts: routed.attempts },
      response: redact(response),
    }));
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json", "x-superds-trace-id": traceId },
    });
  } catch (err) {
    return handleGatewayError(ctx, err, traceId, start, incomingModel, targetModel, provider, steps, sanitizeReportToRecord(sanReport));
  }
}

// ---------------------------------------------------------------------------
// /openai/v1/chat/completions  +  /v1/chat/completions  (OpenAI-compatible)
// ---------------------------------------------------------------------------

export async function handleOpenAIChat(ctx: RequestContext, body: Record<string, unknown>): Promise<Response> {
  const { deps, request } = ctx;
  const incomingModel = (body.model as string) ?? "";
  const { targetModel, alias } = await resolveTarget(deps.store, incomingModel);
  const payload = openaiChatPayload(body, targetModel);
  const wantStream = Boolean(body.stream);
  const start = Date.now();
  const traceId = newTraceId();
  const steps: StepLike[] = [
    step("Ingress", "ingress", "success", "Captured OpenAI-compatible request"),
    step("Alias Resolver", "compat", "success", `${incomingModel} -> ${targetModel}`),
  ];

  const fusionPlan = getFusionPlan(ctx, alias);
  if (fusionPlan) {
    return handleFusionAsOpenAI(ctx, body, payload, fusionPlan, incomingModel, targetModel, traceId, wantStream, steps);
  }
  const baseRequest = {
    headers: redact(Object.fromEntries(request.headers.entries())),
    body: redact(body),
    upstream_payload: redact({ ...payload, model: targetModel }),
    sanitizer: EMPTY_SANITIZER,
  };

  try {
    if (wantStream) {
      payload.stream = true;
      steps.push(step("Provider Router", "route", "success", "streaming"));
      steps.push(step("Upstream Stream", "openai_chat_stream", "success", `${targetModel}`));
      const base = {
        trace_id: traceId,
        client_protocol: "openai",
        client_name: request.headers.get("user-agent")?.slice(0, 80) ?? "unknown",
        incoming_model: incomingModel,
        upstream_model: targetModel,
        sanitizer: baseRequest.sanitizer,
        request: baseRequest,
      };
      return streamToResponse(
        streamOpenAIPassthrough(ctx, payload, targetModel, alias?.provider_id ?? undefined, start, steps, base),
        { "x-superds-trace-id": traceId },
      );
    }
    const routed = await deps.router.callOpenAIChatWithFailover(payload, targetModel, { pinnedProviderId: alias?.provider_id ?? undefined });
    steps.push(step("Provider Router", "route", "success", `${routed.attempts.length} attempt(s), final=${routed.provider.id}`));
    steps.push(step("Upstream Call", "litellm_call", "success", `${routed.provider.name} / ${targetModel}`));
    const latencyMs = Date.now() - start;
    const response = { ...routed.response, model: routed.response.model ?? targetModel };
    await writeTrace(ctx, traceRecord({
      trace_id: traceId,
      status: "success",
      latency_ms: latencyMs,
      client_protocol: "openai",
      client_name: request.headers.get("user-agent")?.slice(0, 80) ?? "unknown",
      incoming_model: incomingModel,
      upstream_model: targetModel,
      upstream_provider_id: routed.provider.id,
      usage: usageFromOpenAI(routed.response),
      steps,
      request: { ...baseRequest, route_attempts: routed.attempts },
      response: redact(response),
    }));
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json", "x-superds-trace-id": traceId },
    });
  } catch (err) {
    return handleGatewayError(ctx, err, traceId, start, incomingModel, targetModel, undefined, steps, baseRequest.sanitizer);
  }
}

// ---------------------------------------------------------------------------
// /openai/v1/responses  (OpenAI Responses API)
// ---------------------------------------------------------------------------

export async function handleOpenAIResponses(ctx: RequestContext, body: Record<string, unknown>): Promise<Response> {
  const { deps, request } = ctx;
  const incomingModel = (body.model as string) ?? "gpt-4.1";
  const { targetModel, alias } = await resolveTarget(deps.store, incomingModel);
  const { payload } = responsesToChatPayload(body, targetModel);
  const wantStream = Boolean(body.stream);
  const start = Date.now();
  const traceId = newTraceId();
  const steps: StepLike[] = [
    step("Ingress", "ingress", "success", "Captured OpenAI Responses-compatible request"),
    step("Responses Adapter", "normalize", "success", "Responses input -> chat payload"),
    step("Alias Resolver", "compat", "success", `${incomingModel} -> ${targetModel}`),
  ];

  const fusionPlan = getFusionPlan(ctx, alias);
  if (fusionPlan) {
    return handleFusionAsResponses(ctx, body, payload, fusionPlan, incomingModel, targetModel, traceId, wantStream, steps);
  }
  const baseRequest = {
    headers: redact(Object.fromEntries(request.headers.entries())),
    body: redact(body),
    upstream_payload: redact({ ...payload, model: targetModel }),
    sanitizer: EMPTY_SANITIZER,
  };

  try {
    if (wantStream) {
      payload.stream = true;
      steps.push(step("Provider Router", "route", "success", "streaming"));
      steps.push(step("Upstream Stream", "openai_chat_stream", "success", `${targetModel}`));
      const base = {
        trace_id: traceId,
        client_protocol: "openai_responses",
        client_name: request.headers.get("user-agent")?.slice(0, 80) ?? "unknown",
        incoming_model: incomingModel,
        upstream_model: targetModel,
        sanitizer: baseRequest.sanitizer,
        request: baseRequest,
      };
      return streamToResponse(
        streamOpenAIAsResponses(ctx, payload, targetModel, incomingModel, alias?.provider_id ?? undefined, start, steps, base),
        { "x-superds-trace-id": traceId },
      );
    }
    const routed = await deps.router.callOpenAIChatWithFailover(payload, targetModel, { pinnedProviderId: alias?.provider_id ?? undefined });
    steps.push(step("Provider Router", "route", "success", `${routed.attempts.length} attempt(s), final=${routed.provider.id}`));
    steps.push(step("Response Adapter", "response_adapter", "success", "Chat response -> Responses object"));
    const completion = normalizeOpenAIChat(routed.response, incomingModel);
    const response = buildResponsesResponse(completion, incomingModel);
    const latencyMs = Date.now() - start;
    await writeTrace(ctx, traceRecord({
      trace_id: traceId,
      status: "success",
      latency_ms: latencyMs,
      client_protocol: "openai_responses",
      client_name: request.headers.get("user-agent")?.slice(0, 80) ?? "unknown",
      incoming_model: incomingModel,
      upstream_model: targetModel,
      upstream_provider_id: routed.provider.id,
      usage: usageFromOpenAI(routed.response),
      steps,
      request: { ...baseRequest, route_attempts: routed.attempts },
      response: redact(response),
    }));
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json", "x-superds-trace-id": traceId },
    });
  } catch (err) {
    return handleGatewayError(ctx, err, traceId, start, incomingModel, targetModel, undefined, steps, baseRequest.sanitizer);
  }
}

export function handleCountTokens(_ctx: RequestContext, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(roughCountTokens(body)), { headers: { "content-type": "application/json" } });
}

export async function listAnthropicModels(store: ConfigStore): Promise<Response> {
  const aliases = await store.listAliases();
  const data = aliases
    .filter((a) => a.alias.startsWith("claude-") || a.alias.startsWith("super-"))
    .map((a) => ({ id: a.alias, type: "model", display_name: a.alias }));
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
}

export async function listOpenAIModels(store: ConfigStore): Promise<Response> {
  const providers = await store.listProviderProfiles();
  const seen = new Set<string>();
  const data: Array<Record<string, unknown>> = [];
  for (const p of providers) {
    const models = (p.capabilities as { models?: unknown } | undefined)?.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (typeof m === "string" && !seen.has(m)) {
          seen.add(m);
          data.push({ id: m, object: "model", owned_by: p.id });
        }
      }
    }
  }
  return new Response(JSON.stringify({ object: "list", data }), { headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Streaming transforms
// ---------------------------------------------------------------------------

interface StreamBase {
  trace_id: string;
  client_protocol: string;
  client_name?: string | undefined;
  incoming_model: string;
  upstream_model: string;
  upstream_provider_id?: string | undefined;
  sanitizer: SanitizationReport;
  request: Record<string, unknown>;
}

async function* streamOpenAIPassthrough(
  ctx: RequestContext,
  payload: Record<string, unknown>,
  targetModel: string,
  pinnedProviderId: string | undefined,
  start: number,
  steps: StepLike[],
  base: StreamBase,
): AsyncGenerator<string, void, unknown> {
  const textParts: string[] = [];
  let error: unknown = null;
  try {
    for await (const data of ctx.deps.router.streamOpenAIChat(payload, targetModel, { pinnedProviderId })) {
      const { text } = openaiStreamDelta(data);
      if (text) textParts.push(text);
      yield encodeData(data);
    }
  } catch (err) {
    error = err;
    yield encodeData({ error: { type: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) } });
    yield encodeDone();
  } finally {
    const latencyMs = Date.now() - start;
    if (error) steps.push(step("Gateway Error", "error", "error", String(error).slice(0, 300)));
    await writeTrace(ctx, traceRecord({
      trace_id: base.trace_id,
      status: error ? "error" : "success",
      latency_ms: latencyMs,
      client_protocol: base.client_protocol,
      client_name: base.client_name,
      incoming_model: base.incoming_model,
      upstream_model: base.upstream_model,
      upstream_provider_id: base.upstream_provider_id,
      usage: {},
      steps,
      request: base.request,
      response: { streamed_text: textParts.join(""), error: error ? String(error) : null },
    }));
  }
}

async function* streamOpenAIAsAnthropic(
  ctx: RequestContext,
  payload: Record<string, unknown>,
  targetModel: string,
  incomingModel: string,
  pinnedProviderId: string | undefined,
  start: number,
  steps: StepLike[],
  base: StreamBase,
): AsyncGenerator<string, void, unknown> {
  const messageId = newMessageId();
  const textParts: string[] = [];
  let error: unknown = null;
  yield encodeSseEvent("message_start", {
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: incomingModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield encodeSseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  try {
    for await (const data of ctx.deps.router.streamOpenAIChat(payload, targetModel, { pinnedProviderId })) {
      const { text, finishReason } = openaiStreamDelta(data);
      if (text) {
        textParts.push(text);
        yield encodeSseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      }
      if (data === "[DONE]" || finishReason) break;
    }
  } catch (err) {
    error = err;
    yield encodeSseEvent("error", { type: "error", error: { type: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) } });
  }
  yield encodeSseEvent("content_block_stop", { index: 0 });
  yield encodeSseEvent("message_delta", {
    delta: { stop_reason: error ? "error" : "stop", stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  yield encodeSseEvent("message_stop", {});
  const latencyMs = Date.now() - start;
  if (error) steps.push(step("Gateway Error", "error", "error", String(error).slice(0, 300)));
  await writeTrace(ctx, traceRecord({
    trace_id: base.trace_id,
    status: error ? "error" : "success",
    latency_ms: latencyMs,
    client_protocol: base.client_protocol,
    client_name: base.client_name,
    incoming_model: base.incoming_model,
    upstream_model: base.upstream_model,
    upstream_provider_id: base.upstream_provider_id,
    usage: {},
    steps,
    request: base.request,
    response: { id: messageId, type: "message", role: "assistant", model: incomingModel, content: [{ type: "text", text: textParts.join("") }] },
  }));
}

async function* streamOpenAIAsResponses(
  ctx: RequestContext,
  payload: Record<string, unknown>,
  targetModel: string,
  incomingModel: string,
  pinnedProviderId: string | undefined,
  start: number,
  steps: StepLike[],
  base: StreamBase,
): AsyncGenerator<string, void, unknown> {
  const responseId = newResponseId();
  const textParts: string[] = [];
  let messageItemId: string | null = null;
  let error: unknown = null;
  let seq = 1;
  yield encodeSseEvent("response.created", {
    type: "response.created",
    sequence_number: seq,
    response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: incomingModel, output: [] },
  });
  try {
    for await (const data of ctx.deps.router.streamOpenAIChat(payload, targetModel, { pinnedProviderId })) {
      const { text, finishReason } = openaiStreamDelta(data);
      if (text) {
        if (messageItemId === null) {
          messageItemId = newShortMessageId();
          seq += 1;
          yield encodeSseEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: seq,
            output_index: 0,
            item: { id: messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          seq += 1;
          yield encodeSseEvent("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: seq,
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        textParts.push(text);
        seq += 1;
        yield encodeSseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: seq,
          item_id: messageItemId,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      }
      if (data === "[DONE]" || finishReason) break;
    }
  } catch (err) {
    error = err;
    seq += 1;
    yield encodeSseEvent("response.failed", {
      type: "response.failed",
      sequence_number: seq,
      response: { id: responseId, status: "failed", error: { type: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) } },
    });
  }
  const text = textParts.join("");
  const itemId = messageItemId ?? newShortMessageId();
  if (!error) {
    if (messageItemId === null) {
      seq += 1;
      yield encodeSseEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: seq,
        output_index: 0,
        item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      seq += 1;
      yield encodeSseEvent("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: seq,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    seq += 1;
    yield encodeSseEvent("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: seq,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    });
    seq += 1;
    yield encodeSseEvent("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: seq,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    seq += 1;
    yield encodeSseEvent("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: seq,
      output_index: 0,
      item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
    });
    seq += 1;
    yield encodeSseEvent("response.completed", {
      type: "response.completed",
      sequence_number: seq,
      response: {
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: incomingModel,
        output: [{ id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
        output_text: text,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    yield encodeDone();
  }
  const latencyMs = Date.now() - start;
  if (error) steps.push(step("Gateway Error", "error", "error", String(error).slice(0, 300)));
  await writeTrace(ctx, traceRecord({
    trace_id: base.trace_id,
    status: error ? "error" : "success",
    latency_ms: latencyMs,
    client_protocol: base.client_protocol,
    client_name: base.client_name,
    incoming_model: base.incoming_model,
    upstream_model: base.upstream_model,
    upstream_provider_id: base.upstream_provider_id,
    usage: {},
    steps,
    request: base.request,
    response: { id: responseId, status: error ? "failed" : "completed", model: incomingModel, output_text: text },
  }));
}

// ---------------------------------------------------------------------------
// Fusion handlers
// ---------------------------------------------------------------------------

/** Whether the caller explicitly opted in to receiving panel details in the response body. */
function wantsFusionDebug(ctx: RequestContext): boolean {
  return ctx.request.headers.get("x-superglm-debug-fusion") === "1";
}

/**
 * Map a fusion failure to a client response. Config errors (no panels) are the
 * caller's/admin's fault → 400; all-panels-failed is an upstream failure → 502.
 * Anything else is an unexpected gateway error → 502.
 */
function fusionErrorResponse(err: unknown, traceId: string): Response {
  const status = err instanceof FusionConfigError ? 400 : 502;
  const type = err instanceof FusionConfigError ? "invalid_request_error" : "upstream_error";
  const message = err instanceof Error ? err.message : String(err);
  return new Response(
    JSON.stringify({ error: { type, message, trace_id: traceId } }),
    { status, headers: { "content-type": "application/json", "x-superds-trace-id": traceId } },
  );
}

/** Persist an error trace for a fusion failure so failures are observable in the dashboard. */
async function writeFusionErrorTrace(
  ctx: RequestContext,
  err: unknown,
  traceId: string,
  clientProtocol: string,
  clientName: string,
  incomingModel: string,
  targetModel: string,
  steps: StepLike[],
  body: Record<string, unknown>,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await writeTrace(ctx, traceRecord({
    trace_id: traceId, status: "error", latency_ms: 0,
    client_protocol: clientProtocol, client_name: clientName,
    incoming_model: incomingModel, upstream_model: targetModel,
    usage: {}, steps, request: { body: redact(body) },
    response: { error: message },
  }));
}

/**
 * Inject vision evidence packets into a fusion (OpenAI-format) payload when the
 * incoming request carries images, mirroring what the single-model path does.
 * Fusion panels may be non-vision models, so images are converted to a textual
 * evidence system message instead of being passed through. Mutates `steps` to
 * record the injection. Returns the (possibly modified) payload.
 */
function injectVisionEvidence(
  ctx: RequestContext,
  payload: Record<string, unknown>,
  protocol: "anthropic" | "openai" | "openai_responses",
  body: Record<string, unknown>,
  steps: StepLike[],
): Record<string, unknown> {
  const images = detectImages(protocol, body);
  if (images.length === 0) return payload;
  const packets = makeEvidencePackets(images, sessionKey(ctx.request, body));
  const evidenceText = evidenceSystemMessage(packets);
  if (!evidenceText) return payload;
  steps.push(step("Vision Evidence", "worker", "success", `${packets.length} image(s) -> evidence packet`));
  return injectEvidenceIntoChatPayload(payload, evidenceText);
}

async function handleFusionAsAnthropic(
  ctx: RequestContext,
  body: Record<string, unknown>,
  plan: FusionPlanConfig,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  wantStream: boolean,
  steps: StepLike[],
): Promise<Response> {
  let fusionPayload = anthropicToOpenaiPayload(body, targetModel, "strip_for_non_anthropic_upstream", "openai").payload;
  fusionPayload = injectVisionEvidence(ctx, fusionPayload, "anthropic", body, steps);

  if (!wantStream) {
    let result;
    try {
      result = await runFusionPipeline(ctx.deps.router, plan, fusionPayload);
    } catch (err) {
      steps.push(step("Fusion Pipeline", "fusion", "error", err instanceof Error ? err.message.slice(0, 300) : String(err)));
      await writeFusionErrorTrace(ctx, err, traceId, "anthropic", "claude-code", incomingModel, targetModel, steps, body);
      return fusionErrorResponse(err, traceId);
    }
    steps.push(step("Fusion Pipeline", "fusion", "success", `${result.strategy}: ${result.panel_responses.length} panel calls`));
    const completion = { id: newMessageId(), model: incomingModel, content: result.synthesized_content, stopReason: "end_turn", usage: { inputTokens: result.total_tokens_in, outputTokens: result.total_tokens_out, totalTokens: result.total_tokens_in + result.total_tokens_out }, raw: {} };
    const response = buildAnthropicMessagesResponse(completion);
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: result.total_latency_ms,
      client_protocol: "anthropic", client_name: "claude-code",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: result.total_tokens_in, outputTokens: result.total_tokens_out, totalTokens: result.total_tokens_in + result.total_tokens_out },
      steps, request: { body: redact(body) },
      response: redact({ ...response, _fusion: { panel_responses: panelResponsesForTrace(result.panel_responses) } }),
    }));
    const clientBody = wantsFusionDebug(ctx)
      ? { ...response, _fusion: { panel_responses: panelResponsesForTrace(result.panel_responses) } }
      : response;
    return new Response(JSON.stringify(clientBody), { headers: { "content-type": "application/json", "x-superds-trace-id": traceId } });
  }

  return streamToResponse(
    fusionStreamAsAnthropic(ctx, plan, fusionPayload, incomingModel, targetModel, traceId, steps),
    { "x-superds-trace-id": traceId },
  );
}

async function handleFusionAsOpenAI(
  ctx: RequestContext,
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
  plan: FusionPlanConfig,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  wantStream: boolean,
  steps: StepLike[],
): Promise<Response> {
  payload = injectVisionEvidence(ctx, payload, "openai", body, steps);
  if (!wantStream) {
    let result;
    try {
      result = await runFusionPipeline(ctx.deps.router, plan, payload);
    } catch (err) {
      steps.push(step("Fusion Pipeline", "fusion", "error", err instanceof Error ? err.message.slice(0, 300) : String(err)));
      await writeFusionErrorTrace(ctx, err, traceId, "openai", "unknown", incomingModel, targetModel, steps, body);
      return fusionErrorResponse(err, traceId);
    }
    steps.push(step("Fusion Pipeline", "fusion", "success", `${result.strategy}: ${result.panel_responses.length} panel calls`));
    const now = Math.floor(Date.now() / 1000);
    const response = {
      id: newChatComplId(), object: "chat.completion", created: now, model: incomingModel,
      choices: [{ index: 0, message: { role: "assistant", content: result.synthesized_content }, finish_reason: "stop" }],
      usage: { prompt_tokens: result.total_tokens_in, completion_tokens: result.total_tokens_out, total_tokens: result.total_tokens_in + result.total_tokens_out },
    };
    const tracePanels = panelResponsesForTrace(result.panel_responses);
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: result.total_latency_ms,
      client_protocol: "openai", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: result.total_tokens_in, outputTokens: result.total_tokens_out, totalTokens: result.total_tokens_in + result.total_tokens_out },
      steps, request: { body: redact(body) }, response: redact({ ...response, _fusion: { panel_responses: tracePanels } }),
    }));
    const clientBody = wantsFusionDebug(ctx) ? { ...response, _fusion: { panel_responses: tracePanels } } : response;
    return new Response(JSON.stringify(clientBody), { headers: { "content-type": "application/json", "x-superds-trace-id": traceId } });
  }

  return streamToResponse(
    fusionStreamAsOpenAI(ctx, plan, payload, incomingModel, targetModel, traceId, steps),
    { "x-superds-trace-id": traceId },
  );
}

async function handleFusionAsResponses(
  ctx: RequestContext,
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
  plan: FusionPlanConfig,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  wantStream: boolean,
  steps: StepLike[],
): Promise<Response> {
  payload = injectVisionEvidence(ctx, payload, "openai_responses", body, steps);
  if (!wantStream) {
    let result;
    try {
      result = await runFusionPipeline(ctx.deps.router, plan, payload);
    } catch (err) {
      steps.push(step("Fusion Pipeline", "fusion", "error", err instanceof Error ? err.message.slice(0, 300) : String(err)));
      await writeFusionErrorTrace(ctx, err, traceId, "openai_responses", "unknown", incomingModel, targetModel, steps, body);
      return fusionErrorResponse(err, traceId);
    }
    steps.push(step("Fusion Pipeline", "fusion", "success", `${result.strategy}: ${result.panel_responses.length} panel calls`));
    const completion = { id: newResponseId(), model: incomingModel, content: result.synthesized_content, stopReason: "stop", usage: { inputTokens: result.total_tokens_in, outputTokens: result.total_tokens_out, totalTokens: result.total_tokens_in + result.total_tokens_out }, raw: {} };
    const response = buildResponsesResponse(completion, incomingModel);
    const tracePanels = panelResponsesForTrace(result.panel_responses);
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: result.total_latency_ms,
      client_protocol: "openai_responses", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: result.total_tokens_in, outputTokens: result.total_tokens_out, totalTokens: result.total_tokens_in + result.total_tokens_out },
      steps, request: { body: redact(body) },
      response: redact({ ...response, _fusion: { panel_responses: tracePanels } }),
    }));
    const clientBody = wantsFusionDebug(ctx) ? { ...response, _fusion: { panel_responses: tracePanels } } : response;
    return new Response(JSON.stringify(clientBody), { headers: { "content-type": "application/json", "x-superds-trace-id": traceId } });
  }

  return streamToResponse(
    fusionStreamAsResponses(ctx, plan, payload, incomingModel, targetModel, traceId, steps),
    { "x-superds-trace-id": traceId },
  );
}

/** Fusion stream formatted as Anthropic SSE (message_start → deltas → message_stop). */
async function* fusionStreamAsAnthropic(
  ctx: RequestContext,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  steps: StepLike[],
): AsyncGenerator<string, void, unknown> {
  const messageId = newMessageId();
  const textParts: string[] = [];
  let fusionResult: { panel_responses: PanelResponse[]; tokens_in: number; tokens_out: number; latency: number } | null = null;
  let failedMessage: string | null = null;

  yield encodeSseEvent("message_start", {
    message: { id: messageId, type: "message", role: "assistant", model: incomingModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  yield encodeSseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } });

  try {
    for await (const evt of runFusionStream(ctx.deps.router, plan, payload)) {
      if (evt.type === "panel_done") {
        steps.push(step(`Panel: ${evt.response.model}`, "fusion", evt.response.status === "success" ? "success" : "error", `${evt.response.model} ${evt.response.status} ${evt.response.latency_ms}ms`));
      } else if (evt.type === "synth_delta") {
        textParts.push(evt.text);
        yield encodeSseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: evt.text } });
      } else if (evt.type === "done") {
        fusionResult = { panel_responses: evt.panel_responses, tokens_in: evt.total_tokens_in, tokens_out: evt.total_tokens_out, latency: evt.total_latency_ms };
      } else if (evt.type === "error") {
        failedMessage = evt.message;
        yield encodeSseEvent("error", { type: "error", error: { type: "fusion_error", message: evt.message } });
      }
    }
  } catch (err) {
    failedMessage = err instanceof Error ? err.message : String(err);
    yield encodeSseEvent("error", { type: "error", error: { type: "fusion_error", message: failedMessage } });
  }

  // On failure, do NOT emit a successful end_turn/message_stop sequence — that would
  // contradict the error frame. Close the content block and stop with an error reason.
  if (failedMessage) {
    yield encodeSseEvent("content_block_stop", { index: 0 });
    yield encodeSseEvent("message_delta", { delta: { stop_reason: "error", stop_sequence: null }, usage: { output_tokens: 0 } });
    yield encodeSseEvent("message_stop", {});
    steps.push(step("Fusion Pipeline", "fusion", "error", failedMessage.slice(0, 300)));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "error", latency_ms: 0,
      client_protocol: "anthropic", client_name: "claude-code",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: {}, steps, request: {}, response: { error: failedMessage },
    }));
    return;
  }

  yield encodeSseEvent("content_block_stop", { index: 0 });
  yield encodeSseEvent("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: fusionResult?.tokens_out ?? 0 } });
  yield encodeSseEvent("message_stop", {});

  if (fusionResult) {
    steps.push(step("Fusion Pipeline", "fusion", "success", `${plan.strategy}: ${fusionResult.panel_responses.length} calls, synth streamed`));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: fusionResult.latency,
      client_protocol: "anthropic", client_name: "claude-code",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: fusionResult.tokens_in, outputTokens: fusionResult.tokens_out, totalTokens: fusionResult.tokens_in + fusionResult.tokens_out },
      steps, request: {}, response: redact({ id: messageId, type: "message", role: "assistant", model: incomingModel, content: [{ type: "text", text: textParts.join("") }], _fusion: { panel_responses: panelResponsesForTrace(fusionResult.panel_responses) } }),
    }));
  }
}

/** Fusion stream formatted as OpenAI chat.completion.chunk SSE. */
async function* fusionStreamAsOpenAI(
  ctx: RequestContext,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  steps: StepLike[],
): AsyncGenerator<string, void, unknown> {
  const chatId = newChatComplId();
  const created = Math.floor(Date.now() / 1000);
  const textParts: string[] = [];
  let fusionResult: { panel_responses: PanelResponse[]; tokens_in: number; tokens_out: number; latency: number } | null = null;
  let failedMessage: string | null = null;

  yield encodeData({ id: chatId, object: "chat.completion.chunk", created, model: incomingModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });

  try {
    for await (const evt of runFusionStream(ctx.deps.router, plan, payload)) {
      if (evt.type === "panel_done") {
        steps.push(step(`Panel: ${evt.response.model}`, "fusion", evt.response.status === "success" ? "success" : "error", `${evt.response.model} ${evt.response.status} ${evt.response.latency_ms}ms`));
      } else if (evt.type === "synth_delta") {
        textParts.push(evt.text);
        yield encodeData({ id: chatId, object: "chat.completion.chunk", created, model: incomingModel, choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] });
      } else if (evt.type === "done") {
        fusionResult = { panel_responses: evt.panel_responses, tokens_in: evt.total_tokens_in, tokens_out: evt.total_tokens_out, latency: evt.total_latency_ms };
      } else if (evt.type === "error") {
        failedMessage = evt.message;
        yield encodeData({ error: { message: evt.message, type: "fusion_error" } });
      }
    }
  } catch (err) {
    failedMessage = err instanceof Error ? err.message : String(err);
    yield encodeData({ error: { message: failedMessage, type: "fusion_error" } });
  }

  // On failure emit an error finish_reason instead of a clean "stop", then [DONE].
  const finishReason = failedMessage ? "error" : "stop";
  yield encodeData({ id: chatId, object: "chat.completion.chunk", created, model: incomingModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  yield encodeDone();

  if (failedMessage) {
    steps.push(step("Fusion Pipeline", "fusion", "error", failedMessage.slice(0, 300)));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "error", latency_ms: 0,
      client_protocol: "openai", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: {}, steps, request: {}, response: { error: failedMessage },
    }));
    return;
  }

  if (fusionResult) {
    steps.push(step("Fusion Pipeline", "fusion", "success", `${plan.strategy}: ${fusionResult.panel_responses.length} calls, synth streamed`));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: fusionResult.latency,
      client_protocol: "openai", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: fusionResult.tokens_in, outputTokens: fusionResult.tokens_out, totalTokens: fusionResult.tokens_in + fusionResult.tokens_out },
      steps, request: {}, response: redact({ id: chatId, model: incomingModel, content: textParts.join(""), _fusion: { panel_responses: panelResponsesForTrace(fusionResult.panel_responses) } }),
    }));
  }
}

/** Fusion stream formatted as OpenAI Responses SSE. */
async function* fusionStreamAsResponses(
  ctx: RequestContext,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
  incomingModel: string,
  targetModel: string,
  traceId: string,
  steps: StepLike[],
): AsyncGenerator<string, void, unknown> {
  const responseId = newResponseId();
  const itemId = newShortMessageId();
  const textParts: string[] = [];
  let fusionResult: { panel_responses: PanelResponse[]; tokens_in: number; tokens_out: number; latency: number } | null = null;
  let failedMessage: string | null = null;
  let seq = 0;

  const nextSeq = () => ++seq;
  yield encodeSseEvent("response.created", { type: "response.created", sequence_number: nextSeq(), response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: incomingModel, output: [] } });
  yield encodeSseEvent("response.output_item.added", { type: "response.output_item.added", sequence_number: nextSeq(), output_index: 0, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
  yield encodeSseEvent("response.content_part.added", { type: "response.content_part.added", sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });

  try {
    for await (const evt of runFusionStream(ctx.deps.router, plan, payload)) {
      if (evt.type === "panel_done") {
        steps.push(step(`Panel: ${evt.response.model}`, "fusion", evt.response.status === "success" ? "success" : "error", `${evt.response.model} ${evt.response.status} ${evt.response.latency_ms}ms`));
      } else if (evt.type === "synth_delta") {
        textParts.push(evt.text);
        yield encodeSseEvent("response.output_text.delta", { type: "response.output_text.delta", sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, delta: evt.text });
      } else if (evt.type === "done") {
        fusionResult = { panel_responses: evt.panel_responses, tokens_in: evt.total_tokens_in, tokens_out: evt.total_tokens_out, latency: evt.total_latency_ms };
      } else if (evt.type === "error") {
        failedMessage = evt.message;
      }
    }
  } catch (err) {
    failedMessage = err instanceof Error ? err.message : String(err);
  }

  const text = textParts.join("");

  // On failure: emit ONLY response.failed and stop. Previously we also emitted
  // response.completed afterwards, producing a stream that both failed and
  // completed (protocol-illegal). The terminal event must be exactly one of them.
  if (failedMessage) {
    yield encodeSseEvent("response.failed", { type: "response.failed", sequence_number: nextSeq(), response: { id: responseId, object: "response", status: "failed", model: incomingModel, error: { message: failedMessage } } });
    yield encodeDone();
    steps.push(step("Fusion Pipeline", "fusion", "error", failedMessage.slice(0, 300)));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "error", latency_ms: 0,
      client_protocol: "openai_responses", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: {}, steps, request: {}, response: { error: failedMessage },
    }));
    return;
  }

  yield encodeSseEvent("response.output_text.done", { type: "response.output_text.done", sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, text });
  yield encodeSseEvent("response.content_part.done", { type: "response.content_part.done", sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
  yield encodeSseEvent("response.output_item.done", { type: "response.output_item.done", sequence_number: nextSeq(), output_index: 0, item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } });
  yield encodeSseEvent("response.completed", { type: "response.completed", sequence_number: nextSeq(), response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: incomingModel, output: [{ id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], output_text: text, usage: { input_tokens: fusionResult?.tokens_in ?? 0, output_tokens: fusionResult?.tokens_out ?? 0, total_tokens: (fusionResult?.tokens_in ?? 0) + (fusionResult?.tokens_out ?? 0) } } });
  yield encodeDone();

  if (fusionResult) {
    steps.push(step("Fusion Pipeline", "fusion", "success", `${plan.strategy}: ${fusionResult.panel_responses.length} calls, synth streamed`));
    await writeTrace(ctx, traceRecord({
      trace_id: traceId, status: "success", latency_ms: fusionResult.latency,
      client_protocol: "openai_responses", client_name: "unknown",
      incoming_model: incomingModel, upstream_model: targetModel,
      usage: { inputTokens: fusionResult.tokens_in, outputTokens: fusionResult.tokens_out, totalTokens: fusionResult.tokens_in + fusionResult.tokens_out },
      steps, request: {}, response: redact({ id: responseId, status: "completed", model: incomingModel, output_text: text, _fusion: { panel_responses: panelResponsesForTrace(fusionResult.panel_responses) } }),
    }));
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleGatewayError(
  ctx: RequestContext,
  err: unknown,
  traceId: string,
  start: number,
  incomingModel: string,
  targetModel: string,
  provider: ProviderConfig | undefined,
  steps: StepLike[],
  sanitizer: SanitizationReport,
): Response {
  const latencyMs = Date.now() - start;
  const statusCode = resolveUpstreamStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  steps.push(step("Gateway Error", "error", "error", message.slice(0, 300)));
  void writeTrace(ctx, traceRecord({
    trace_id: traceId,
    status: "error",
    latency_ms: latencyMs,
    client_protocol: "gateway",
    incoming_model: incomingModel,
    upstream_model: targetModel,
    upstream_provider_id: provider?.id,
    usage: {},
    sanitizer,
    steps,
    request: {},
    response: { error: message },
  }));
  return new Response(
    JSON.stringify({ error: { type: "upstream_error", upstream_status: statusCode, message, trace_id: traceId } }),
    { status: statusCode, headers: { "content-type": "application/json", "x-superds-trace-id": traceId } },
  );
}

/**
 * Map an error to the HTTP status the client should see. Upstream auth/limit/request
 * errors (401, 429, 400, ...) are surfaced verbatim so SDKs can react correctly;
 * everything else (network failure, unknown) becomes a 502 bad gateway.
 */
export function resolveUpstreamStatus(err: unknown): number {
  if (err instanceof UpstreamStatusError) {
    const status = err.status;
    if (typeof status === "number" && status >= 400 && status <= 599) return status;
  }
  return 502;
}
