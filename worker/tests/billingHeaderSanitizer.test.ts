import { sanitizeBillingHeaders, headersToRecord } from "../src/compat/billingHeaderSanitizer";

describe("sanitizeBillingHeaders", () => {
  it("strips auth, cookies, billing, project, stainless, and access headers", () => {
    const { headers, report } = sanitizeBillingHeaders(
      new Headers({
        authorization: "Bearer test-secret-token",
        cookie: "sid=1",
        "x-api-key": "test-secret-token",
        "openai-organization": "org",
        "openai-project": "proj",
        "x-stainless-lang": "js",
        "cf-access-client-id": "id",
        "x-goog-user-project": "billing",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      }),
    );

    const record = headersToRecord(headers);
    expect(record.authorization).toBeUndefined();
    expect(record.cookie).toBeUndefined();
    expect(record["x-api-key"]).toBeUndefined();
    expect(record["content-type"]).toBe("application/json");
    expect(record["anthropic-version"]).toBe("2023-06-01");
    expect(report.billingHeaderDetected).toBe(true);
    expect(report.removedHeaders).toContain("authorization");
    expect(report.removedHeaders).toContain("x-stainless-lang");
  });
});
