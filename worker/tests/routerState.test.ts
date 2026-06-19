import { ProviderRouter } from "../src/upstream/router";
import { ConfigStore } from "../src/storage/configStore";
import { MockD1 } from "./helpers/mockD1";
import { CircuitBreaker } from "../src/upstream/circuitBreaker";

const PROVIDERS = [
  { id: "a", name: "A", protocol: "openai" as const, base_url: "https://a/v1", api_key: "k", capabilities: { models: ["m"] } },
  { id: "b", name: "B", protocol: "openai" as const, base_url: "https://b/v1", api_key: "k", capabilities: { models: ["m"] } },
  { id: "c", name: "C", protocol: "openai" as const, base_url: "https://c/v1", api_key: "k", capabilities: { models: ["m"] } },
];

function router(): ProviderRouter {
  const db = new MockD1({ providers: PROVIDERS }) as unknown as D1Database;
  return new ProviderRouter(new ConfigStore(db));
}

describe("ProviderRouter cross-request state", () => {
  it("round-robins across requests on the same router instance", async () => {
    const r = router();
    const first = await r.resolveCandidates("m");
    const second = await r.resolveCandidates("m");
    const third = await r.resolveCandidates("m");
    expect(first.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(second.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(third.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("round-robin does NOT reset between requests (state persists on the instance)", async () => {
    const r = router();
    await r.resolveCandidates("m");
    await r.resolveCandidates("m");
    // third request continues the rotation rather than restarting at "a"
    const third = await r.resolveCandidates("m");
    expect(third[0]?.id).toBe("c");
  });

  it("opens the circuit breaker after the failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, successThreshold: 1, timeoutSeconds: 60 });
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    expect(breaker.allowRequest()).toBe(false);
  });

  it("half-opens after the timeout and closes on success", () => {
    const now = { t: 1000 };
    const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, timeoutSeconds: 60 }, () => now.t);
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    now.t += 61;
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.snapshot().state).toBe("half_open");
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("circuit state is shared across calls via the same router instance", async () => {
    const r = router();
    expect(Object.keys(r.status())).toHaveLength(0);
    // prepareOpenAIChatStream creates a breaker entry keyed by provider:model.
    await r.prepareOpenAIChatStream({ messages: [] }, "m");
    const afterFirst = r.status();
    expect(Object.keys(afterFirst).length).toBeGreaterThanOrEqual(1);
    const firstKeys = new Set(Object.keys(afterFirst));
    // A second call may round-robin to a different provider, but the first breaker
    // entry persists (state is not reset between requests on the same instance).
    await r.prepareOpenAIChatStream({ messages: [] }, "m");
    const afterSecond = r.status();
    for (const k of firstKeys) {
      expect(afterSecond[k]).toBeDefined();
    }
  });
});
