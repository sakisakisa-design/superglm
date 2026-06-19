import { authenticate } from "../src/auth/auth";
import { hashKey, timingSafeEqual } from "../src/auth/keyHash";
import type { SuperDeepSeekConfig } from "../src/types/config";

const baseConfig: SuperDeepSeekConfig = {
  providers: [],
  models: [],
  profiles: [],
  model_aliases: [],
};

describe("auth", () => {
  it("hashes keys with sha256 hex", async () => {
    expect(await hashKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("compares strings without accepting mismatched lengths", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secrex")).toBe(false);
    expect(timingSafeEqual("secret", "secret2")).toBe(false);
  });

  it("accepts configured bearer tokens", async () => {
    const result = await authenticate(
      new Request("https://example.test", { headers: { authorization: "Bearer local" } }),
      { ...baseConfig, security: { local_api_key: "local" } },
      { DB: undefined as unknown as D1Database },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects requests with no token when a key is configured", async () => {
    const result = await authenticate(
      new Request("https://example.test"),
      { ...baseConfig, security: { local_api_key: "local" } },
      { DB: undefined as unknown as D1Database },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects requests with a wrong token when a key is configured", async () => {
    const result = await authenticate(
      new Request("https://example.test", { headers: { authorization: "Bearer nope" } }),
      { ...baseConfig, security: { local_api_key: "local" } },
      { DB: undefined as unknown as D1Database },
    );
    expect(result.ok).toBe(false);
  });
});
