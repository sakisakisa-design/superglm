import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/storage/configStore";
import { TraceStore } from "../src/storage/traceStore";
import { ProviderRouter } from "../src/upstream/router";
import { MockD1 } from "./helpers/mockD1";
import * as providerClient from "../src/upstream/providerClient";
import { handleAnthropicMessages } from "../src/runtime/pipeline";
import type { Env } from "../src/types/internal";
import type { FusionPlanConfig } from "../src/types/config";

const ALIAS = { id: 1, alias: "fuse-test", target_model: "m1", strategy: "fusion" };
const PLAN: FusionPlanConfig = {
  strategy: "fusion",
  panel_models: [{ model: "m1" }, { model: "m2" }],
  judge_model: "m1",
  synthesizer_model: "m1",
  max_tokens_per_panel: 128,
  timeout_ms: 5000,
};

function makeCtx(env: Partial<Env> = {}) {
  const db = new MockD1({
    providers: [{ id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k", enabled: 1 } as never],
    aliases: [ALIAS] as never[],
  }) as unknown as D1Database;
  const store = new ConfigStore(db);
  const traces = new TraceStore(db);
  const router = new ProviderRouter(store);
  const deps = { env: { DB: db, ...env } as Env, store, traces, router, fusionPlans: { "fuse-test": PLAN } };
  return deps;
}

function anthropicBody(stream = false): Record<string, unknown> {
  return {
    model: "fuse-test",
    stream,
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  };
}

function mockCallOpenAI() {
  return vi
    .spyOn(providerClient, "callOpenAIChat")
    .mockResolvedValue({ choices: [{ message: { role: "assistant", content: "answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) as unknown as ReturnType<typeof vi.fn> & {
      mock: { calls: unknown[][] };
    };
}

async function runFusionRequest(env: Partial<Env>, headers: Record<string, string>, stream = false) {
  const deps = makeCtx(env);
  const req = new Request("https://gw/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(anthropicBody(stream)),
  });
  const ctx = { deps, request: req, path: "/v1/messages", method: "POST" };
  return handleAnthropicMessages(ctx, anthropicBody(stream));
}

describe("fusion debug gate (ALLOW_FUSION_DEBUG_OUTPUT)", () => {
  beforeEach(() => {
    mockCallOpenAI();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits _fusion panel_responses when the env flag is not set, even with the header", async () => {
    const res = await runFusionRequest({}, { "x-superglm-debug-fusion": "1" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._fusion).toBeUndefined();
  });

  it("omits _fusion panel_responses when the header is absent, even with the env flag on", async () => {
    const res = await runFusionRequest({ ALLOW_FUSION_DEBUG_OUTPUT: "true" }, {});
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._fusion).toBeUndefined();
  });

  it("includes _fusion panel_responses only when both env flag and header are present", async () => {
    const res = await runFusionRequest({ ALLOW_FUSION_DEBUG_OUTPUT: "true" }, { "x-superglm-debug-fusion": "1" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._fusion).toBeDefined();
    expect((body._fusion as { panel_responses: unknown }).panel_responses).toBeInstanceOf(Array);
  });
});

describe("fusion image_policy", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockCallOpenAI();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function bodyWithImage(): Record<string, unknown> {
    return {
      model: "fuse-test",
      stream: false,
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
        ],
      }],
    };
  }

  it("rejects the request with 400 when image_policy is reject and an image is present", async () => {
    const deps = makeCtx();
    deps.fusionPlans!["fuse-test"] = { ...PLAN, image_policy: "reject" };
    const req = new Request("https://gw/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyWithImage()),
    });
    const ctx = { deps, request: req, path: "/v1/messages", method: "POST" };
    const res = await handleAnthropicMessages(ctx, bodyWithImage());
    expect(res.status).toBe(400);
  });

  it("keeps image blocks in the payload when image_policy is keep_for_vision_panels", async () => {
    const spy = mockCallOpenAI();
    const deps = makeCtx();
    deps.fusionPlans!["fuse-test"] = { ...PLAN, image_policy: "keep_for_vision_panels" };
    const req = new Request("https://gw/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyWithImage()),
    });
    const ctx = { deps, request: req, path: "/v1/messages", method: "POST" };
    await handleAnthropicMessages(ctx, bodyWithImage());
    // The first callOpenAIChat call is a panel. Its payload should still contain
    // the image block (not stripped, no evidence system message inserted).
    const panelPayload = spy.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = panelPayload.messages as Array<Record<string, unknown>>;
    const hasImage = msgs.some((m) => {
      const c = m.content;
      return Array.isArray(c) && c.some((b: Record<string, unknown>) => b.type === "image" || b.type === "image_url");
    });
    expect(hasImage).toBe(true);
    // And no evidence system message should have been injected.
    const hasEvidence = msgs.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("[image"));
    expect(hasEvidence).toBe(false);
  });

  it("strips image blocks and injects evidence by default (evidence_only)", async () => {
    const spy = mockCallOpenAI();
    const deps = makeCtx();
    // PLAN has no image_policy set — defaults to evidence_only
    const req = new Request("https://gw/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyWithImage()),
    });
    const ctx = { deps, request: req, path: "/v1/messages", method: "POST" };
    await handleAnthropicMessages(ctx, bodyWithImage());
    const panelPayload = spy.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = panelPayload.messages as Array<Record<string, unknown>>;
    // Image blocks should be gone.
    const hasImage = msgs.some((m) => {
      const c = m.content;
      return Array.isArray(c) && c.some((b: Record<string, unknown>) => b.type === "image" || b.type === "image_url");
    });
    expect(hasImage).toBe(false);
    // An evidence system message should have been injected.
    const hasEvidence = msgs.some((m) => m.role === "system" && typeof m.content === "string" && m.content.length > 0 && m.content !== "you are a helpful assistant");
    expect(hasEvidence).toBe(true);
  });
});
