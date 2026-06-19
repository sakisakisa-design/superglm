// Anthropic input adapter — converts Anthropic Messages API requests into the
// internal/OpenAI-chat shape, and produces Anthropic passthrough payloads for
// anthropic-protocol upstreams. Mirrors backend/app/adapters.anthropic_to_openai_payload
// and backend/app/billing_header_sanitizer.sanitize_system_first_line.
//
// The system-first-line `cch=` strip is the core cache-safety behaviour from the
// local edition: Claude Code may inject `x-anthropic-billing-header: ... cch=<random>`
// as the first system line; forwarding that to a non-Anthropic upstream wrecks prefix
// caching. This runs before cache-key computation and before upstream forwarding.

import type { BillingHeaderPolicy } from "../types/config";

const BILLING_HEADER_RE = /^x-anthropic-billing-header\s*:\s*.*\bcch\s*=\s*[^;\s,]+.*$/i;

export interface SystemSanitizationReport {
  billingHeaderDetected: boolean;
  billingHeaderAction: string; // none | stripped | canonicalized | passed_through
  cchRedacted: boolean;
  systemFirstLineChanged: boolean;
}

export function shouldStrip(policy: BillingHeaderPolicy, upstreamProtocol: string): boolean {
  if (policy === "strip" || policy === "always-strip") return true;
  if (policy === "strip_for_non_anthropic_upstream") return upstreamProtocol !== "anthropic";
  return false;
}

export function actionFor(policy: BillingHeaderPolicy, upstreamProtocol: string): string {
  if (policy === "pass_through") return "passed_through";
  if (policy === "canonicalize") return "canonicalized";
  if (shouldStrip(policy, upstreamProtocol)) return "stripped";
  return "passed_through";
}

export function sanitizeSystemFirstLine(
  systemText: string,
  policy: BillingHeaderPolicy = "strip_for_non_anthropic_upstream",
  upstreamProtocol: string = "openai",
): { system: string; report: SystemSanitizationReport } {
  const none: SystemSanitizationReport = {
    billingHeaderDetected: false,
    billingHeaderAction: "none",
    cchRedacted: false,
    systemFirstLineChanged: false,
  };
  const lines = systemText.split(/\r?\n/);
  if (lines.length === 0) return { system: systemText, report: none };

  const first = (lines[0] ?? "").trim();
  if (!BILLING_HEADER_RE.test(first)) return { system: systemText, report: none };

  const action = actionFor(policy, upstreamProtocol);
  const report: SystemSanitizationReport = {
    billingHeaderDetected: true,
    billingHeaderAction: action,
    cchRedacted: true,
    systemFirstLineChanged: action === "stripped" || action === "canonicalized",
  };
  if (action === "canonicalized") {
    lines[0] = "x-anthropic-billing-header: cch=<stable-redacted>";
    return { system: lines.join("\n"), report };
  }
  if (action === "stripped") {
    return { system: lines.slice(1).join("\n").replace(/^\n+/, ""), report };
  }
  return { system: systemText, report };
}

/** Flatten Anthropic system (string | content blocks) to plain text. */
export function anthropicSystemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          return ((block as Record<string, unknown>).text as string) ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return system == null ? "" : String(system);
}

/** Convert Anthropic message content (string | blocks) to OpenAI chat content. */
export function anthropicContentToOpenai(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const out: Array<Record<string, unknown>> = [];
  let hasImage = false;
  for (const block of content) {
    if (typeof block === "string") {
      out.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      out.push({ type: "text", text: (b.text as string) ?? "" });
    } else if (b.type === "image") {
      const source = (b.source as Record<string, unknown>) ?? {};
      const mediaType = (source.media_type as string) ?? "image/png";
      const url =
        source.type === "base64" && source.data
          ? `data:${mediaType};base64,${source.data}`
          : ((source.url as string) ?? "");
      out.push({ type: "image_url", image_url: { url } });
      hasImage = true;
    } else if (b.type === "tool_result") {
      out.push({ type: "text", text: String(b.content ?? "") });
    }
  }
  const filtered = out.filter((b) => b.type !== "text" || b.text);
  if (hasImage) return filtered;
  return filtered.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

export function anthropicToolsToOpenai(
  tools: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools ?? []) {
    out.push({
      type: "function",
      function: {
        name: tool.name,
        description: (tool.description as string) ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

const ANTHROPIC_TO_OPENAI_PASSTHROUGH = new Set([
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "metadata",
  "service_tier",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thinking_budget",
  "enable_thinking",
  "include_reasoning",
  "response_format",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "extra_body",
]);

export interface AnthropicConversionResult {
  payload: Record<string, unknown>;
  report: SystemSanitizationReport;
}

/** Anthropic Messages → OpenAI Chat Completions payload (for openai-protocol upstream). */
export function anthropicToOpenaiPayload(
  body: Record<string, unknown>,
  targetModel: string,
  policy: BillingHeaderPolicy,
  upstreamProtocol: string,
): AnthropicConversionResult {
  const systemText = anthropicSystemToText(body.system);
  const { system, report } = sanitizeSystemFirstLine(systemText, policy, upstreamProtocol);

  const messages: Array<Record<string, unknown>> = [];
  if (system) messages.push({ role: "system", content: system });
  for (const msg of (body.messages as Array<Record<string, unknown>>) ?? []) {
    let role = (msg.role as string) ?? "user";
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      role = "user";
    }
    messages.push({ role, content: anthropicContentToOpenai(msg.content) });
  }

  const payload: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream: Boolean(body.stream),
  };
  for (const key of ANTHROPIC_TO_OPENAI_PASSTHROUGH) {
    if (key in body && body[key] !== undefined) payload[key] = body[key];
  }
  if ("stop_sequences" in body) payload.stop = body.stop_sequences;
  else if ("stop" in body) payload.stop = body.stop;
  if (body.tools) payload.tools = anthropicToolsToOpenai(body.tools as Array<Record<string, unknown>>);
  if (body.tool_choice) {
    payload.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : "auto";
  }
  return { payload, report };
}

/** Anthropic Messages passthrough payload (for anthropic-protocol upstream). */
export function anthropicPassthroughPayload(
  body: Record<string, unknown>,
  targetModel: string,
  policy: BillingHeaderPolicy,
  upstreamProtocol: string,
): AnthropicConversionResult {
  const payload: Record<string, unknown> = { ...body, model: targetModel };
  let report: SystemSanitizationReport = {
    billingHeaderDetected: false,
    billingHeaderAction: "none",
    cchRedacted: false,
    systemFirstLineChanged: false,
  };
  if (typeof body.system === "string") {
    const { system, report: r } = sanitizeSystemFirstLine(body.system, policy, upstreamProtocol);
    payload.system = system;
    report = r;
  }
  return { payload, report };
}

/** Rough token count mirroring backend/app/adapters.rough_count_tokens. */
export function roughCountTokens(body: Record<string, unknown>): Record<string, unknown> {
  let text = anthropicSystemToText(body.system);
  for (const msg of (body.messages as Array<Record<string, unknown>>) ?? []) {
    text += "\n" + anthropicContentToOpenai(msg.content);
  }
  return { input_tokens: Math.max(1, Math.floor(text.length / 4)) };
}
