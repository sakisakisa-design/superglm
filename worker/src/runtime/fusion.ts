// Fusion pipeline — gateway-layer ensemble mode.
//
// When an alias has strategy "fusion" or "self_consistency", the request
// branches here instead of the normal single-model path.
//
// Flow:
//   1. Build panel payloads (same messages, different models/temperatures)
//   2. Call all panel models in parallel (Promise.allSettled)
//   3. Judge model analyzes all responses → structured JSON report
//   4. Synthesizer model writes the final answer using judge report
//   5. Return synthesized text + full trace data
//
// MVP: non-streaming only. Streaming fusion falls back to single-model.

import type { FusionPlanConfig, PanelModelSpec } from "../types/config";
import type { ProviderRouter } from "../upstream/router";
import { callOpenAIChat } from "../upstream/providerClient";

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

export interface JudgeReport {
  consensus: string[];
  conflicts: string[];
  missing_points: string[];
  best_sources: string[];
  risk_flags: string[];
  recommended_plan: string;
}

export interface FusionResult {
  panel_responses: PanelResponse[];
  judge_report: JudgeReport | null;
  synthesized_content: string;
  total_latency_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  strategy: string;
}

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

function buildJudgePrompt(panelResponses: PanelResponse[], originalMessages: unknown[]): string {
  const validResponses = panelResponses.filter((r) => r.status === "success" && r.content);
  const parts: string[] = [
    "You are a judge analyzing multiple AI model responses to the same prompt.",
    "Compare the responses and produce a JSON report with these fields:",
    '- "consensus": points all or most models agree on',
    '- "conflicts": points where models disagree',
    '- "missing_points": important aspects none of the models addressed',
    '- "best_sources": which models had the most accurate/useful information',
    '- "risk_flags": factual errors, hallucinations, or dangerous advice detected',
    '- "recommended_plan": a brief plan for how to synthesize the best final answer',
    "",
    "Respond with ONLY the JSON object, no markdown formatting.",
    "",
    "=== Original user messages ===",
    JSON.stringify(originalMessages.slice(-4)),
    "",
  ];
  validResponses.forEach((r, i) => {
    parts.push(`=== Panel response ${i + 1} (model: ${r.model}, provider: ${r.provider_id}) ===`);
    parts.push(r.content.slice(0, 4000));
    parts.push("");
  });
  if (validResponses.length === 0) {
    parts.push("=== All panel responses failed ===");
    panelResponses.forEach((r, i) => {
      parts.push(`Panel ${i + 1} (${r.model}): ${r.status} - ${r.error ?? "no content"}`);
    });
  }
  return parts.join("\n");
}

function parseJudgeReport(text: string): JudgeReport | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      consensus: Array.isArray(obj.consensus) ? (obj.consensus as string[]) : [],
      conflicts: Array.isArray(obj.conflicts) ? (obj.conflicts as string[]) : [],
      missing_points: Array.isArray(obj.missing_points) ? (obj.missing_points as string[]) : [],
      best_sources: Array.isArray(obj.best_sources) ? (obj.best_sources as string[]) : [],
      risk_flags: Array.isArray(obj.risk_flags) ? (obj.risk_flags as string[]) : [],
      recommended_plan: typeof obj.recommended_plan === "string" ? obj.recommended_plan : "",
    };
  } catch {
    return null;
  }
}

function buildSynthesizerPrompt(panelResponses: PanelResponse[], judgeReport: JudgeReport | null, originalMessages: unknown[]): string {
  const validResponses = panelResponses.filter((r) => r.status === "success" && r.content);
  const parts: string[] = [
    "You are the final synthesizer. Write the best possible answer to the user's question.",
    "Use the panel responses and judge analysis below. Do not mention the panel or judge — just write the answer directly.",
    "",
    "=== Original user messages ===",
    JSON.stringify(originalMessages.slice(-4)),
    "",
  ];
  if (judgeReport) {
    parts.push("=== Judge analysis ===");
    parts.push(`Consensus: ${judgeReport.consensus.join("; ")}`);
    parts.push(`Conflicts: ${judgeReport.conflicts.join("; ")}`);
    parts.push(`Missing points: ${judgeReport.missing_points.join("; ")}`);
    parts.push(`Risk flags: ${judgeReport.risk_flags.join("; ")}`);
    parts.push(`Recommended plan: ${judgeReport.recommended_plan}`);
    parts.push("");
  }
  validResponses.forEach((r, i) => {
    parts.push(`=== Panel response ${i + 1} (model: ${r.model}) ===`);
    parts.push(r.content.slice(0, 6000));
    parts.push("");
  });
  return parts.join("\n");
}

export async function runFusionPipeline(
  router: ProviderRouter,
  plan: FusionPlanConfig,
  payload: Record<string, unknown>,
): Promise<FusionResult> {
  const start = Date.now();
  const maxTokens = plan.max_tokens_per_panel ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = plan.timeout_ms ?? DEFAULT_TIMEOUT;
  const messages = (payload.messages as unknown[]) ?? [];
  const basePayload = { ...payload };
  delete basePayload.stream;

  const specs = buildPanelSpecs(plan);

  const panelPromises = specs.map((spec) =>
    callPanel(router, { ...basePayload, temperature: spec.temperature ?? 0.7 }, spec.model, spec.provider_id, maxTokens, timeoutMs),
  );
  const settled = await Promise.allSettled(panelPromises);
  const panelResponses: PanelResponse[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return { provider_id: specs[i]?.provider_id ?? "?", model: specs[i]?.model ?? "?", status: "error", latency_ms: 0, tokens_in: 0, tokens_out: 0, content: "", error: String(s.reason).slice(0, 300) };
  });

  let judgeReport: JudgeReport | null = null;
  if (panelResponses.some((r) => r.status === "success" && r.content)) {
    const judgePrompt = buildJudgePrompt(panelResponses, messages);
    try {
      const judgePayload = {
        ...basePayload,
        model: plan.judge_model,
        messages: [{ role: "user", content: judgePrompt }],
        max_tokens: 2048,
        temperature: 0.2,
        stream: false,
      };
      const judgeCandidates = await router.resolveCandidates(plan.judge_model, plan.judge_provider_id);
      const judgeProvider = judgeCandidates[0];
      if (judgeProvider) {
        const judgeResp = await callOpenAIChat(judgePayload, judgeProvider, timeoutMs);
        judgeReport = parseJudgeReport(extractText(judgeResp));
      }
    } catch {
      // judge failure is non-fatal; synthesizer can still work with raw panel responses
    }
  }

  let synthesizedContent = "";
  if (panelResponses.some((r) => r.status === "success" && r.content)) {
    const synthPrompt = buildSynthesizerPrompt(panelResponses, judgeReport, messages);
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
    } catch (err) {
      const bestPanel = panelResponses.filter((r) => r.status === "success").sort((a, b) => b.content.length - a.content.length)[0];
      synthesizedContent = bestPanel?.content ?? "";
    }
  }

  const totalTokensIn = panelResponses.reduce((sum, r) => sum + r.tokens_in, 0);
  const totalTokensOut = panelResponses.reduce((sum, r) => sum + r.tokens_out, 0);

  return {
    panel_responses: panelResponses,
    judge_report: judgeReport,
    synthesized_content: synthesizedContent,
    total_latency_ms: Date.now() - start,
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    strategy: plan.strategy,
  };
}
