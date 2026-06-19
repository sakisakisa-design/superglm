import { resolveUpstreamStatus } from "../src/runtime/pipeline";
import { UpstreamStatusError } from "../src/upstream/providerClient";

describe("resolveUpstreamStatus", () => {
  it("surfaces upstream auth/limit/request status codes verbatim (not swallowed to 502)", () => {
    // Regression: handleGatewayError computed statusCode but the Response was hard-coded
    // to 502, so 401/429/400 all looked like 502 to the client.
    expect(resolveUpstreamStatus(new UpstreamStatusError(401, "unauthorized"))).toBe(401);
    expect(resolveUpstreamStatus(new UpstreamStatusError(429, "rate limited"))).toBe(429);
    expect(resolveUpstreamStatus(new UpstreamStatusError(400, "bad request"))).toBe(400);
    expect(resolveUpstreamStatus(new UpstreamStatusError(503, "unavailable"))).toBe(503);
  });

  it("falls back to 502 for non-upstream errors (network failure, unknown)", () => {
    expect(resolveUpstreamStatus(new Error("fetch failed"))).toBe(502);
    expect(resolveUpstreamStatus("boom")).toBe(502);
    expect(resolveUpstreamStatus(undefined)).toBe(502);
  });

  it("ignores out-of-range upstream status values and falls back to 502", () => {
    expect(resolveUpstreamStatus(new UpstreamStatusError(0, "weird"))).toBe(502);
    expect(resolveUpstreamStatus(new UpstreamStatusError(700, "weird"))).toBe(502);
  });
});
