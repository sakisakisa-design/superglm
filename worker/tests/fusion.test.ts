import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/storage/configStore";
import { ProviderRouter } from "../src/upstream/router";
import { MockD1 } from "./helpers/mockD1";
import {
  runFusionPipeline,
  runFusionStream,
  panelResponsesForTrace,
  FusionConfigError,
  FusionAllPanelsFailedError,
} from "../src/runtime/fusion";

function routerWithProviders(providers: Array<Record<string, unknown>>): ProviderRouter {
  // Mark every test provider enabled so the router's enabled-filter doesn't drop them.
  const withEnabled = providers.map((p) => ({ enabled: 1, ...p }));
  const db = new MockD1({ providers: withEnabled as never[] }) as unknown as D1Database;
  return new ProviderRouter(new ConfigStore(db));
}

function openaiOk(content: string): unknown {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
  };
}

function openaiError(status: number): unknown {
  return {
    ok: false,
    status,
    text: async () => "upstream boom",
    json: async () => ({}),
  };
}

function openaiStream(content: string): unknown {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "", json: async () => ({}) };
}

const PLAN = {
  strategy: "fusion" as const,
  panel_models: [{ model: "m1" }, { model: "m2" }],
  judge_model: "m1",
  synthesizer_model: "m1",
  max_tokens_per_panel: 128,
  timeout_ms: 5000,
};

describe("runFusionPipeline failure semantics", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws FusionConfigError when the plan has no panel_models and no self_consistency", async () => {
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    await expect(
      runFusionPipeline(router, { strategy: "fusion", synthesizer_model: "m1" } as never, { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(FusionConfigError);
  });

  it("throws FusionAllPanelsFailedError when every panel returns an upstream error", async () => {
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    globalThis.fetch = vi.fn(async () => openaiError(500)) as unknown as typeof fetch;
    await expect(runFusionPipeline(router, PLAN, { messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(FusionAllPanelsFailedError);
  });

  it("returns a 200-shaped result when panels and synthesizer both succeed", async () => {
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    globalThis.fetch = vi.fn(async () => openaiOk("answer")) as unknown as typeof fetch;
    const result = await runFusionPipeline(router, PLAN, { messages: [{ role: "user", content: "hi" }] });
    expect(result.synthesized_content).toBe("answer");
    // 2 panels + 1 synth
    expect(result.panel_responses.length).toBe(3);
  });

  it("filters out non-OpenAI providers (Anthropic-direct) so they cannot be picked as panels", async () => {
    const router = routerWithProviders([
      { id: "anthropic", name: "Anthropic", protocol: "anthropic", base_url: "https://api.anthropic.com/v1", api_key: "k" },
    ]);
    globalThis.fetch = vi.fn(async () => openaiOk("nope")) as unknown as typeof fetch;
    await expect(runFusionPipeline(router, PLAN, { messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(FusionAllPanelsFailedError);
    // No fetch should have hit the Anthropic /v1/chat/completions endpoint.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("runFusionStream failure semantics", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits error then DONE, with no done event, when every panel fails", async () => {
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    globalThis.fetch = vi.fn(async () => openaiError(503)) as unknown as typeof fetch;
    const events: string[] = [];
    for await (const evt of runFusionStream(router, PLAN, { messages: [{ role: "user", content: "hi" }] })) {
      events.push(evt.type);
    }
    expect(events).toContain("panel_done");
    expect(events).toContain("error");
    expect(events).not.toContain("done");
  });

  it("emits synth_delta and done on the happy path", async () => {
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    // First two calls (panels) succeed with simple content, the streaming synth call returns a stream.
    let call = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      call++;
      const url = typeof input === "string" ? input : (input as Request).url;
      if (call <= 2) return openaiOk("panel");
      if (url.includes("stream=true") || call === 3) return openaiStream("final");
      return openaiOk("synth");
    }) as unknown as typeof fetch;
    const events: string[] = [];
    for await (const evt of runFusionStream(router, PLAN, { messages: [{ role: "user", content: "hi" }] })) {
      events.push(evt.type);
    }
    expect(events).toContain("synth_start");
    expect(events).toContain("synth_delta");
    expect(events).toContain("done");
  });
});

describe("runFusionStream per-panel progressive yield", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("yields panel_done events as each panel settles, not as a batch after all finish", async () => {
    // Stagger the two panel calls: the first settles immediately, the second
    // settles only after a delay. If the runner waited for all panels (allSettled)
    // both panel_done events would arrive together after the delay; a streaming
    // implementation yields the first one before the second settles.
    const router = routerWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "k" },
    ]);
    let callCount = 0;
    const slowDelay = 40;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      const isFirstCall = callCount === 1;
      if (!isFirstCall) await new Promise((r) => setTimeout(r, slowDelay));
      return openaiOk("panel");
    }) as unknown as typeof fetch;

    const timestamps: number[] = [];
    const start = Date.now();
    for await (const evt of runFusionStream(router, PLAN, { messages: [{ role: "user", content: "hi" }] })) {
      if (evt.type === "panel_done") timestamps.push(Date.now() - start);
    }
    expect(timestamps.length).toBe(2);
    // First panel_done must arrive well before the second (which waits slowDelay).
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThan(slowDelay - 15);
    // And the first must arrive quickly, before the slow panel's delay elapses.
    expect(timestamps[0]!).toBeLessThan(slowDelay);
  });
});

describe("panelResponsesForTrace", () => {
  it("truncates panel content to the per-panel cap", () => {
    const huge = "x".repeat(8000);
    const out = panelResponsesForTrace([{ provider_id: "p", model: "m", status: "success", latency_ms: 1, tokens_in: 0, tokens_out: 0, content: huge }]);
    expect(out[0]!.content.length).toBeLessThan(huge.length);
    expect(out[0]!.content.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves short panel content untouched", () => {
    const out = panelResponsesForTrace([{ provider_id: "p", model: "m", status: "success", latency_ms: 1, tokens_in: 0, tokens_out: 0, content: "short" }]);
    expect(out[0]!.content).toBe("short");
  });
});
