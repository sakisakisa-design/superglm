import { redactText, redact } from "../src/utils/redact";

describe("redactText", () => {
  it("replaces the secret value but keeps the captured key prefix (no leak)", () => {
    // Regression: the replace callback used args[group-1] (the full match) instead
    // of args[group] (the capture group), so the secret survived in the output.
    const out = redactText("api_key=secret12345678");
    expect(out).toBe("api_key=<redacted>");
    expect(out).not.toContain("secret12345678");
  });

  it("does not leak the secret for api_key with colon + spaces", () => {
    const out = redactText("api_key: secret12345678");
    expect(out).toBe("api_key: <redacted>");
    expect(out).not.toContain("secret12345678");
  });

  it("redacts the anthropic billing header value while keeping the header name", () => {
    const out = redactText("x-anthropic-billing-header: cch=abcdefgh1234");
    expect(out).toBe("x-anthropic-billing-header: <redacted>");
    expect(out).not.toContain("abcdefgh1234");
  });

  it("redacts bare sk- keys and Bearer tokens (no capture group)", () => {
    expect(redactText("token sk-ABCDEFGH1234")).toBe("token <redacted>");
    expect(redactText("Authorization Bearer ABCDEFGH1234")).toBe("Authorization <redacted>");
  });

  it("redacts the cch billing cookie value", () => {
    const out = redactText("cch=abcdefgh1234");
    expect(out).toBe("<redacted>");
    expect(out).not.toContain("abcdefgh1234");
  });

  it("redacts secrets embedded inside larger text and trace bodies", () => {
    const out = redactText("before api_key=secret12345678 after");
    expect(out).toBe("before api_key=<redacted> after");
    expect(out).not.toContain("secret12345678");
  });

  it("redacts string values found inside nested objects via redact()", () => {
    const out = redact({ note: "api_key=secret12345678", headers: { authorization: "Bearer x" } });
    expect(out.note).toBe("api_key=<redacted>");
    expect(out.headers.authorization).toBe("<redacted>");
  });
});
