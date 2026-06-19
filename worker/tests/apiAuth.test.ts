import worker, { __resetSingletonsForTest } from "../src/index";
import { mockEnv, MockD1 } from "./helpers/mockD1";

const GATEWAY_KEY = "admin-secret-key";
const CONFIG = JSON.stringify({
  security: { local_api_key: GATEWAY_KEY },
  runtime: { mode: "observe" },
  providers: [],
  profiles: [],
  models: [],
  model_aliases: [],
});

const PROVIDER_ROW = {
  id: "deepseek",
  name: "DeepSeek",
  base_url: "https://api.deepseek.com/v1",
  api_key: "test-provider-secret-12345678",
  protocol: "openai",
  models: "[]",
  enabled: 1,
  timeout_ms: 60000,
};

function envWithProvider(): { DB: D1Database; db: MockD1 } {
  // Seed config + provider_profiles in the mock.
  const db = new MockD1({ configValue: CONFIG, providers: [PROVIDER_ROW] });
  return { DB: db as unknown as D1Database, db };
}

afterEach(() => __resetSingletonsForTest());

describe("admin auth gate on /api/*", () => {
  it("returns 401 on /api/providers without a token", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/providers", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/providers", {
        method: "GET",
        headers: { authorization: "Bearer wrong-key" },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with the correct token and masks the provider api_key", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/providers", {
        method: "GET",
        headers: { authorization: `Bearer ${GATEWAY_KEY}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ api_key?: string }> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]?.api_key).toBe("sk-****5678");
    expect(body.providers[0]?.api_key).not.toContain("secret12345678");
  });

  it("leaves /api/health unauthenticated", async () => {
    const env = mockEnv({ configValue: CONFIG });
    const res = await worker.fetch(new Request("https://gw.test/api/health", { method: "GET" }), env);
    expect(res.status).toBe(200);
  });

  it("never returns the gateway key from the claude smoke endpoint", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/claude-code/smoke", {
        method: "POST",
        headers: { authorization: `Bearer ${GATEWAY_KEY}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { env: { ANTHROPIC_API_KEY: string } };
    expect(body.env.ANTHROPIC_API_KEY).not.toContain(GATEWAY_KEY);
  });

  it("never returns the gateway key from /api/config", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/config", {
        method: "GET",
        headers: { authorization: `Bearer ${GATEWAY_KEY}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { security?: { local_api_key?: string } };
    expect(body.security?.local_api_key).toBe("<redacted>");
  });

  it("keeps the stored provider key when saving a masked key from the dashboard", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/providers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "deepseek",
          name: "DeepSeek Cloud",
          base_url: "https://api.deepseek.com/v1",
          api_key: "sk-****5678",
          protocol: "openai",
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(env.db.providers.get("deepseek")?.api_key).toBe("test-provider-secret-12345678");
    expect(env.db.providers.get("deepseek")?.name).toBe("DeepSeek Cloud");
  });

  it("updates the stored provider key when a new cleartext key is supplied", async () => {
    const env = envWithProvider();
    const res = await worker.fetch(
      new Request("https://gw.test/api/providers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "deepseek",
          name: "DeepSeek",
          base_url: "https://api.deepseek.com/v1",
          api_key: "test-provider-new-12345678",
          protocol: "openai",
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(env.db.providers.get("deepseek")?.api_key).toBe("test-provider-new-12345678");
  });
});
