// Test connection — mirrors backend/app/upstream.test_connection.
// Performs a minimal streaming probe against an upstream provider and reports
// latency / TTFB so the dashboard can show healthy / degraded / failed status.

import type { ProviderConfig } from "../types/config";
import { joinUrl } from "../upstream/providerClient";
import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

export async function testConnection(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;

  let provider: ProviderConfig;
  const providerId = body["provider_id"] as string | undefined;
  if (providerId) {
    const stored = await ctx.configStore.getProviderProfile(providerId);
    if (!stored) {
      return jsonResponse(404, { ok: false, status: "provider_not_found" });
    }
    provider = stored;
  } else {
    provider = {
      id: (body["id"] as string) ?? "test",
      name: (body["name"] as string) ?? "Test",
      protocol: body["protocol"] === "anthropic" ? "anthropic" : "openai",
      base_url: (body["base_url"] as string) ?? "",
      api_key: (body["api_key"] as string) ?? "",
      default_model: (body["default_model"] as string) ?? "",
    };
  }
  if (body["api_key"]) provider = { ...provider, api_key: body["api_key"] as string };
  if (body["model"]) provider = { ...provider, test_model: body["model"] as string };

  const model = provider.test_model ?? provider.default_model ?? "";
  if (!model) {
    return jsonResponse(200, {
      ok: false,
      status: "missing_model",
      latency_ms: null,
      ttfb_ms: null,
      mode: "stream_check",
      model: "",
      error: "Set a test model or provider default_model before testing the connection.",
    });
  }
  if (!provider.api_key || !provider.base_url) {
    return jsonResponse(200, {
      ok: false,
      status: "missing_api_key",
      latency_ms: null,
      ttfb_ms: null,
      mode: "stream_check",
      model,
    });
  }

  const start = Date.now();
  let firstByteAt: number | null = null;
  const isAnthropic = provider.protocol === "anthropic";
  const url = joinUrl(provider.base_url, isAnthropic ? "messages" : "chat/completions");
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 16,
    stream: true,
  };
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": provider.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { Authorization: `Bearer ${provider.api_key}`, "Content-Type": "application/json" };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      return jsonResponse(200, {
        ok: false,
        status: response.status,
        latency_ms: Date.now() - start,
        ttfb_ms: null,
        mode: "stream_check",
        model,
        error: errorBody.slice(0, 500),
      });
    }
    if (response.body) {
      const reader = response.body.getReader();
      const { value } = await reader.read();
      if (value && value.length > 0) firstByteAt = Date.now();
      reader.releaseLock();
    }
    const latencyMs = Date.now() - start;
    const ttfbMs = firstByteAt != null ? firstByteAt - start : latencyMs;
    const threshold = provider.degraded_threshold_ms ?? 6000;
    return jsonResponse(200, {
      ok: true,
      status: ttfbMs < threshold ? "healthy" : "degraded",
      http_status: response.status,
      latency_ms: latencyMs,
      ttfb_ms: ttfbMs,
      mode: "stream_check",
      model,
    });
  } catch (err) {
    return jsonResponse(200, {
      ok: false,
      status: err instanceof Error ? err.name : "error",
      latency_ms: Date.now() - start,
      ttfb_ms: null,
      mode: "stream_check",
      model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
