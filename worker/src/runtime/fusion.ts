// Fusion pipeline — gateway-layer ensemble mode.
//
// When an alias has strategy "fusion" or "self_consistency", the request
// branches here instead of the normal single-model path.
//
// Flow (streaming):
//   1. Panel models called in parallel (non-streaming, bounded tokens)
//   2. Synthesizer streams the final answer using all panel responses
//
// Flow (non-streaming):
//   Same, but synthesizer returns a single buffered response.
//
// No separate judge step — the synthesizer reads panel responses directly
// and writes the answer. This cuts latency by ~1/3 vs panel→judge→synth.

import type { FusionPlanConfig, PanelModelSpec } from "../types/config";
import { MAX_PANEL_COUNT, DEFAULT_MAX_PARALLEL_PANELS } from "../types/config";
import type { ProviderRouter } from "../upstream/router";
import { openaiStreamDelta } from "../adapters/openaiOut";

/** Raised when a fusion plan is structurally invalid (no panels). Surfaces as 400. */
export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

/** Raised when every panel fails and there is nothing to synthesize. Surfaces as 502. */
export class FusionAllPanelsFailedError extends Error {
  constructor(message = "all panel models failed") {
    super(message);
    this.name = "FusionAllPanelsFailedError";
  }
}

export interface PanelResponse {
  provider_id: string;
  model: string;
  status: "success" | "error" | "timeout";
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  content: string;
  error?: string;
}

export interface FusionResult {
  panel_responses: PanelResponse[];
  synthesized_content: string;
  total_latency_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  strategy: string;
}

export type FusionStreamEvent =
  | { type: "panel_done"; response: PanelResponse }
  | { type: "synth_start" }
  | { type: "synth_delta"; text: string }
  | { type: "done"; panel_responses: PanelResponse[]; total_tokens_in: number; total_tokens_out: number; total_latency_ms: number }
  | { type: "error"; message: string };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT = 120000;

/** Per-panel content cap when persisting panel responses into a trace. */
const PANEL_TRACE_CONTENT_CAP = 4000;

/**
 * Shrink panel responses for trace storage: truncate each panel's content so a
 * handful of long panels can't blow up the D1 response_json blob, and so internal
 * drafts aren't stored at full length.
 */
export function panelResponsesForTrace(panels: PanelResponse[]): PanelResponse[] {
  return panels.map((p) => {
    if (p.content.length <= PANEL_TRACE_CONTENT_CAP) return p;
    return { ...p, content: p.content.slice(0, PANEL_TRACE_CONTENT_CAP) + "…[truncated]" };
  });
}

function extractText(resp: Record<string, unknown>): string {
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const msg = choices[0]?.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
  }
  return "";
}

function extractUsage(resp: Record<string, unknown>): { in: number; out: number } {
  const u = (resp.usage as Record<string, unknown>) ?? {};
  return {
    in: (u.prompt_tokens as number) ?? 0,
    out: (u.completion_tokens as number) ?? 0,
  };
}

async function callPanel(
  router: ProviderRouter,
  payload: Record<string, unknown>,
  model: string,
  providerId: string | undefined,
  maxTokens: number,
  timeoutMs: number,
): Promise<PanelResponse> {
  const start = Date.now();
  const panelPayload = { ...payload, max_tokens: maxTokens, stream: false };
  try {
    // Route through the failover-aware path so panels get the same circuit-breaker
    // and provider-rotation resilience as the normal single-model path. Fusion is
    // OpenAI-only, so non-OpenAI providers are filtered out as candidates. The plan
    // timeout is forwarded so a slow panel actually times out instead of hanging on
    // the providerClient default (5 min).
    const routed = await router.callOpenAIChatWithFailover(panelPayload, model, {
      pinnedProviderId: providerId,
      requireProtocol: "openai",
      timeoutMs,
    });
    const usage = extractUsage(routed.response);
    return {
      provider_id: routed.provider.id,
      model,
      status: "success",
      latency_ms: Date.now() - start,
      tokens_in: usage.in,
      tokens_out: usage.out,
      content: extractText(routed.response),
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      provider_id: providerId ?? "?",
      model,
      status: isTimeout ? "timeout" : "error",
      latency_ms: Date.now() - start,
      tokens_in: 0,
      tokens_out: 0,
      content: "",
      error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    };
  }
}

function buildPanelSpecs(plan: FusionPlanConfig): PanelModelSpec[] {
  let specs: PanelModelSpec[];
  if (plan.strategy === "self_consistency" && plan.self_consistency) {
    const sc = plan.self_consistency;
    const temps = sc.temperatures ?? Array.from({ length: sc.samples }, (_, i) => 0.3 + i * 0.3);
    specs = temps.map((t): PanelModelSpec => {
      const spec: PanelModelSpec = { model: sc.model, temperature: t };
      if (sc.provider_id) spec.provider_id = sc.provider_id;
      return spec;
    });
  } else {
    specs = plan.panel_models ?? [];
  }
  const cap = plan.max_panel_count ?? MAX_PANEL_COUNT;
  if (specs.length > cap) {
    throw new FusionConfigError(
      `fusion plan expands to ${specs.length} panels, exceeding max_panel_count=${cap}`,
    );
  }
  return specs;
}

function buildSynthPrompt(panelResponses: PanelResponse[], originalMessages: unknown[]): string {
  const valid = panelResponses.filter((r) => r.status === "success" && r.content);
  const parts: string[] = [
    "You are the final synthesizer. Write the best possible answer to the user's question.",
    "Use the panel responses below. Do not mention the panel — just write the answer directly.",
    "",
    "=== Original user messages ===",
    JSON.stringify(originalMessages.slice(-4)),
    "",
  ];
  valid.forEach((r, i) => {
    parts.push(`=== Panel response ${i + 1} (model: ${r.model}) ===`);
    parts.push(r.content.slice(0, 6000));
    parts.push("");
  });
  return parts.join("\n");
}

async function runPanels(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  basePayload: Record<string, unknown>,
): Promise<{ responses: PanelResponse[]; messages: unknown[] }> {
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = plan.timeout_ms ?? DEFAULT_TIMEOUT;
  const messages = (basePayload.messages as unknown[]) ?? [];
  const specs = buildPanelSpecs(plan);

  if (specs.length === 0) {
    throw new FusionConfigError(
      plan.strategy === "self_consistency"
        ? "fusion self_consistency plan has no model/samples configured"
        : "fusion plan has no panel_models configured",
    );
  }

  // Bound concurrency so a misconfigured plan (e.g. 20 panels) doesn't fan out 20
  // simultaneous upstream requests inside the Worker. We launch callPanel lazily
  // through a semaphore instead of Promise.allSettled (which starts everything at once).
  const maxParallel = plan.max_parallel_panels ?? DEFAULT_MAX_PARALLEL_PANELS;
  const responses = await runSpecsWithConcurrency(
    router, basePayload, specs, maxTokens, timeoutMs, maxParallel,
  );
  return { responses, messages };
}

/**
 * Run panel specs with bounded concurrency. Each spec is launched (callPanel) only
 * when a concurrency slot is free, so at most `maxParallel` upstream requests are
 * in-flight at any time. Rejections are caught and converted to error PanelResponses.
 */
async function runSpecsWithConcurrency(
  router: ProviderRouter,
  basePayload: Record<string, unknown>,
  specs: PanelModelSpec[],
  maxTokens: number,
  timeoutMs: number,
  maxParallel: number,
): Promise<PanelResponse[]> {
  const results: PanelResponse[] = new Array(specs.length);
  let cursor = 0;
  let active = 0;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const launchNext = (): void => {
    while (active < maxParallel && cursor < specs.length) {
      const idx = cursor++;
      const spec = specs[idx]!;
      active++;
      callPanel(router, { ...basePayload, temperature: spec.temperature ?? 0.7 }, spec.model, spec.provider_id, maxTokens, timeoutMs)
        .then(
          (r) => { results[idx] = r; },
          (err) => {
            results[idx] = {
              provider_id: spec.provider_id ?? "?",
              model: spec.model ?? "?",
              status: "error",
              latency_ms: 0,
              tokens_in: 0,
              tokens_out: 0,
              content: "",
              error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
            };
          },
        )
        .finally(() => {
          active--;
          if (cursor >= specs.length && active === 0) {
            resolveDone?.();
          } else {
            launchNext();
          }
        });
    }
  };
  if (specs.length > 0) {
    launchNext();
    await done;
  }
  return results;
}

/**
 * Streaming variant of runPanels: panels are launched in parallel, but each
 * panel result is yielded the moment it settles, instead of waiting for
 * Promise.allSettled. This lets the client see per-panel progress during the
 * (often long) phase where the slowest panel is still running.
 *
 * The returned generator also yields FusionConfigError eagerly (before any panel
 * call) when the plan has no panels, mirroring runPanels.
 *
 * Implementation note: a self-resetting gate (gateResolve) is used so the
 * generator loop can await "at least one new result is available" without busy
 * polling. Settled results land in a FIFO queue; the main loop drains it.
 */
async function* runPanelsStreaming(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  basePayload: Record<string, unknown>,
): AsyncGenerator<PanelResponse, void, unknown> {
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = plan.timeout_ms ?? DEFAULT_TIMEOUT;
  const specs = buildPanelSpecs(plan);

  if (specs.length === 0) {
    throw new FusionConfigError(
      plan.strategy === "self_consistency"
        ? "fusion self_consistency plan has no model/samples configured"
        : "fusion plan has no panel_models configured",
    );
  }

  const queue: PanelResponse[] = [];
  let gateResolve: (() => void) | null = null;
  const signal = (): void => {
    if (gateResolve) {
      const r = gateResolve;
      gateResolve = null;
      r();
    }
  };
  const waitForSettle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      gateResolve = resolve;
    });

  const maxParallel = plan.max_parallel_panels ?? DEFAULT_MAX_PARALLEL_PANELS;
  let pending = 0;
  let cursor = 0;
  let active = 0;

  const launchOne = (spec: PanelModelSpec): void => {
    pending++;
    active++;
    callPanel(router, { ...basePayload, temperature: spec.temperature ?? 0.7 }, spec.model, spec.provider_id, maxTokens, timeoutMs)
      .then((r) => queue.push(r), (err) =>
        queue.push({ provider_id: spec.provider_id ?? "?", model: spec.model ?? "?", status: "error", latency_ms: 0, tokens_in: 0, tokens_out: 0, content: "", error: String(err).slice(0, 300) }),
      )
      .finally(() => {
        pending--;
        active--;
        signal();
        // When a slot frees up, launch the next spec (if any remain).
        if (cursor < specs.length) {
          launchOne(specs[cursor++]!);
        }
      });
  };

  // Launch the initial batch (up to maxParallel) and then continue launching as
  // each panel settles, so at most maxParallel upstream requests are in-flight.
  const initial = Math.min(maxParallel, specs.length);
  for (let i = 0; i < initial; i++) {
    launchOne(specs[cursor++]!);
  }

  const responses: PanelResponse[] = [];
  // Drain queued results as they arrive. Each iteration: if queue has items,
  // shift+yield; else if panels still pending, await the gate; else done.
  while (pending > 0 || queue.length > 0) {
    if (queue.length === 0) {
      await waitForSettle();
    }
    while (queue.length > 0) {
      const r = queue.shift()!;
      responses.push(r);
      yield r;
    }
  }
}

/** Non-streaming fusion: panel → synthesizer (buffered). */
export async function runFusionPipeline(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
): Promise<FusionResult> {
  const start = Date.now();
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const basePayload = { ...payload };
  delete basePayload.stream;

  const { responses: panelResponses, messages } = await runPanels(router, plan, basePayload);

  // If every panel failed there is nothing to synthesize. Fail loudly instead of
  // returning a 200 with an empty body (which looks like the model going silent).
  if (!panelResponses.some((r) => r.status === "success" && r.content)) {
    throw new FusionAllPanelsFailedError();
  }

  let synthesizedContent = "";
  const synthPrompt = buildSynthPrompt(panelResponses, messages);
  try {
    const synthPayload = {
      ...basePayload,
      messages: [{ role: "user", content: synthPrompt }],
      max_tokens: maxTokens,
      temperature: 0.5,
      stream: false,
    };
    const routed = await router.callOpenAIChatWithFailover(synthPayload, plan.synthesizer_model, {
      pinnedProviderId: plan.synthesizer_provider_id,
      requireProtocol: "openai",
      timeoutMs: plan.timeout_ms ?? DEFAULT_TIMEOUT,
    });
    synthesizedContent = extractText(routed.response);
    const usage = extractUsage(routed.response);
    panelResponses.push({
      provider_id: routed.provider.id,
      model: plan.synthesizer_model,
      status: "success",
      latency_ms: 0,
      tokens_in: usage.in,
      tokens_out: usage.out,
      content: synthesizedContent,
    });
  } catch {
    // Synthesizer failed but panels succeeded: fall back to the best panel answer
    // so the client still gets a usable, non-empty response.
    const bestPanel = panelResponses.filter((r) => r.status === "success").sort((a, b) => b.content.length - a.content.length)[0];
    synthesizedContent = bestPanel?.content ?? "";
  }

  const totalTokensIn = panelResponses.reduce((sum, r) => sum + r.tokens_in, 0);
  const totalTokensOut = panelResponses.reduce((sum, r) => sum + r.tokens_out, 0);

  return {
    panel_responses: panelResponses,
    synthesized_content: synthesizedContent,
    total_latency_ms: Date.now() - start,
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    strategy: plan.strategy,
  };
}

/** Streaming fusion: panel (non-streaming) → synthesizer (streaming). Yields events. */
export async function* runFusionStream(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
): AsyncGenerator<FusionStreamEvent, void, unknown> {
  const start = Date.now();
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const basePayload = { ...payload };
  delete basePayload.stream;

  // 1. Panel calls in parallel — each panel is emitted the moment it settles
  //    (not after all panels finish), so the client sees per-panel progress.
  const panelResponses: PanelResponse[] = [];
  for await (const r of runPanelsStreaming(router, plan, basePayload)) {
    panelResponses.push(r);
    yield { type: "panel_done", response: r };
  }
  const messages = (basePayload.messages as unknown[]) ?? [];

  // 2. Synthesizer streaming. If every panel failed there is nothing to
  // synthesize: emit a terminal error and return WITHOUT a done event, so the
  // outer wrapper closes the stream as a failure (no success/completed frame).
  if (!panelResponses.some((r) => r.status === "success" && r.content)) {
    yield { type: "error", message: "all panel models failed" };
    return;
  }

  const synthPrompt = buildSynthPrompt(panelResponses, messages);
  const synthPayload = {
    ...basePayload,
    messages: [{ role: "user", content: synthPrompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
    stream: true,
  };

  yield { type: "synth_start" };

  let synthProviderId = plan.synthesizer_provider_id ?? "?";
  let streamedAny = false;
  try {
    let synthTokensOut = 0;
    // Route through streamOpenAIChatWithMeta so the synthesizer gets circuit-breaker
    // tracking, OpenAI-only provider filtering, and we can capture the actual
    // selected provider id for trace attribution (not just a pinned-id guess).
    for await (const { chunk: data, providerId } of router.streamOpenAIChatWithMeta(synthPayload, plan.synthesizer_model, {
      pinnedProviderId: plan.synthesizer_provider_id,
      requireProtocol: "openai",
      timeoutMs: plan.timeout_ms ?? DEFAULT_TIMEOUT,
    })) {
      synthProviderId = providerId;
      const { text } = openaiStreamDelta(data);
      if (text) {
        streamedAny = true;
        synthTokensOut += Math.ceil(text.length / 4);
        yield { type: "synth_delta", text };
      }
      if (data === "[DONE]") break;
    }
    panelResponses.push({
      provider_id: synthProviderId,
      model: plan.synthesizer_model,
      status: "success",
      latency_ms: 0,
      tokens_in: 0,
      tokens_out: synthTokensOut,
      content: "",
    });
  } catch (err) {
    // Synthesizer failed. If we already streamed partial text we cannot cleanly
    // restart, so surface an error; otherwise fall back to the best panel answer
    // so the client still gets a complete, usable response.
    const bestPanel = panelResponses.filter((r) => r.status === "success").sort((a, b) => b.content.length - a.content.length)[0];
    if (!streamedAny && bestPanel) {
      yield { type: "synth_delta", text: bestPanel.content };
    } else {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }
  }

  const totalTokensIn = panelResponses.reduce((sum, r) => sum + r.tokens_in, 0);
  const totalTokensOut = panelResponses.reduce((sum, r) => sum + r.tokens_out, 0);
  yield {
    type: "done",
    panel_responses: panelResponses,
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    total_latency_ms: Date.now() - start,
  };
}
