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
import type { ProviderRouter } from "../upstream/router";
import { callOpenAIChat, iterOpenAIChatStream } from "../upstream/providerClient";
import { openaiStreamDelta } from "../adapters/openaiOut";

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
  const panelPayload = { ...payload, model, max_tokens: maxTokens, stream: false };
  try {
    const candidates = await router.resolveCandidates(model, providerId);
    const provider = candidates[0];
    if (!provider) {
      return { provider_id: providerId ?? "?", model, status: "error", latency_ms: Date.now() - start, tokens_in: 0, tokens_out: 0, content: "", error: "no provider candidates" };
    }
    const response = await callOpenAIChat(panelPayload, provider, timeoutMs);
    const usage = extractUsage(response);
    return {
      provider_id: provider.id,
      model,
      status: "success",
      latency_ms: Date.now() - start,
      tokens_in: usage.in,
      tokens_out: usage.out,
      content: extractText(response),
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
  if (plan.strategy === "self_consistency" && plan.self_consistency) {
    const sc = plan.self_consistency;
    const temps = sc.temperatures ?? Array.from({ length: sc.samples }, (_, i) => 0.3 + i * 0.3);
    return temps.map((t): PanelModelSpec => {
      const spec: PanelModelSpec = { model: sc.model, temperature: t };
      if (sc.provider_id) spec.provider_id = sc.provider_id;
      return spec;
    });
  }
  return plan.panel_models ?? [];
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

  const panelPromises = specs.map((spec) =>
    callPanel(router, { ...basePayload, temperature: spec.temperature ?? 0.7 }, spec.model, spec.provider_id, maxTokens, timeoutMs),
  );
  const settled = await Promise.allSettled(panelPromises);
  const responses: PanelResponse[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return { provider_id: specs[i]?.provider_id ?? "?", model: specs[i]?.model ?? "?", status: "error", latency_ms: 0, tokens_in: 0, tokens_out: 0, content: "", error: String(s.reason).slice(0, 300) };
  });
  return { responses, messages };
}

/** Non-streaming fusion: panel → synthesizer (buffered). */
export async function runFusionPipeline(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
): Promise<FusionResult> {
  const start = Date.now();
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = plan.timeout_ms ?? DEFAULT_TIMEOUT;
  const basePayload = { ...payload };
  delete basePayload.stream;

  const { responses: panelResponses, messages } = await runPanels(router, plan, basePayload);

  let synthesizedContent = "";
  if (panelResponses.some((r) => r.status === "success" && r.content)) {
    const synthPrompt = buildSynthPrompt(panelResponses, messages);
    try {
      const synthPayload = {
        ...basePayload,
        model: plan.synthesizer_model,
        messages: [{ role: "user", content: synthPrompt }],
        max_tokens: maxTokens,
        temperature: 0.5,
        stream: false,
      };
      const synthCandidates = await router.resolveCandidates(plan.synthesizer_model, plan.synthesizer_provider_id);
      const synthProvider = synthCandidates[0];
      if (synthProvider) {
        const synthResp = await callOpenAIChat(synthPayload, synthProvider, timeoutMs);
        synthesizedContent = extractText(synthResp);
        const usage = extractUsage(synthResp);
        panelResponses.push({
          provider_id: synthProvider.id,
          model: plan.synthesizer_model,
          status: "success",
          latency_ms: 0,
          tokens_in: usage.in,
          tokens_out: usage.out,
          content: synthesizedContent,
        });
      }
    } catch {
      const bestPanel = panelResponses.filter((r) => r.status === "success").sort((a, b) => b.content.length - a.content.length)[0];
      synthesizedContent = bestPanel?.content ?? "";
    }
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
  const timeoutMs = plan.timeout_ms ?? DEFAULT_TIMEOUT;
  const basePayload = { ...payload };
  delete basePayload.stream;

  // 1. Panel calls in parallel
  const { responses: panelResponses, messages } = await runPanels(router, plan, basePayload);
  for (const r of panelResponses) {
    yield { type: "panel_done", response: r };
  }

  // 2. Synthesizer streaming
  if (!panelResponses.some((r) => r.status === "success" && r.content)) {
    yield { type: "error", message: "all panel responses failed" };
    return;
  }

  const synthPrompt = buildSynthPrompt(panelResponses, messages);
  const synthPayload = {
    ...basePayload,
    model: plan.synthesizer_model,
    messages: [{ role: "user", content: synthPrompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
    stream: true,
  };

  yield { type: "synth_start" };

  try {
    const synthCandidates = await router.resolveCandidates(plan.synthesizer_model, plan.synthesizer_provider_id);
    const synthProvider = synthCandidates[0];
    if (!synthProvider) {
      throw new Error("no synthesizer provider available");
    }
    let synthTokensOut = 0;
    for await (const data of iterOpenAIChatStream(synthPayload, synthProvider, timeoutMs)) {
      const { text } = openaiStreamDelta(data);
      if (text) {
        synthTokensOut += Math.ceil(text.length / 4);
        yield { type: "synth_delta", text };
      }
      if (data === "[DONE]") break;
    }
    panelResponses.push({
      provider_id: synthProvider.id,
      model: plan.synthesizer_model,
      status: "success",
      latency_ms: 0,
      tokens_in: 0,
      tokens_out: synthTokensOut,
      content: "",
    });
  } catch (err) {
    const bestPanel = panelResponses.filter((r) => r.status === "success").sort((a, b) => b.content.length - a.content.length)[0];
    if (bestPanel) {
      yield { type: "synth_delta", text: bestPanel.content };
    } else {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
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
