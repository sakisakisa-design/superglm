import {
  sanitizeSystemFirstLine,
  anthropicToOpenaiPayload,
  anthropicPassthroughPayload,
  anthropicContentToOpenai,
  anthropicToolsToOpenai,
  roughCountTokens,
} from "../src/adapters/anthropicIn";

const HEADER_LINE = "x-anthropic-billing-header: acct=1 cch=RANDOM123 token=xy";

describe("sanitizeSystemFirstLine", () => {
  it("strips the billing header first line for non-anthropic upstream", () => {
    const { system, report } = sanitizeSystemFirstLine(
      `${HEADER_LINE}\nYou are helpful.`,
      "strip_for_non_anthropic_upstream",
      "openai",
    );
    expect(system).toBe("You are helpful.");
    expect(report.billingHeaderDetected).toBe(true);
    expect(report.billingHeaderAction).toBe("stripped");
    expect(report.systemFirstLineChanged).toBe(true);
  });

  it("canonicalizes the cch value to a stable redacted token", () => {
    const { system, report } = sanitizeSystemFirstLine(
      `${HEADER_LINE}\nrest`,
      "canonicalize",
      "openai",
    );
    expect(system).toBe("x-anthropic-billing-header: cch=<stable-redacted>\nrest");
    expect(report.billingHeaderAction).toBe("canonicalized");
  });

  it("passes through unchanged for anthropic upstream under the default policy", () => {
    const { system, report } = sanitizeSystemFirstLine(
      `${HEADER_LINE}\nrest`,
      "strip_for_non_anthropic_upstream",
      "anthropic",
    );
    expect(system).toBe(`${HEADER_LINE}\nrest`);
    expect(report.billingHeaderAction).toBe("passed_through");
    expect(report.systemFirstLineChanged).toBe(false);
  });

  it("does nothing when the first line is not a billing header", () => {
    const { system, report } = sanitizeSystemFirstLine(
      "You are a coding assistant.\nMore.",
      "strip_for_non_anthropic_upstream",
      "openai",
    );
    expect(system).toBe("You are a coding assistant.\nMore.");
    expect(report.billingHeaderDetected).toBe(false);
    expect(report.billingHeaderAction).toBe("none");
  });

  it("ignores billing-header-like text that is not the first line", () => {
    const { system, report } = sanitizeSystemFirstLine(
      "You are helpful.\nx-anthropic-billing-header: cch=abc",
      "strip_for_non_anthropic_upstream",
      "openai",
    );
    expect(system).toBe("You are helpful.\nx-anthropic-billing-header: cch=abc");
    expect(report.billingHeaderDetected).toBe(false);
  });

  it("always strips when policy is 'strip' even for anthropic upstream", () => {
    const { system, report } = sanitizeSystemFirstLine(`${HEADER_LINE}\nrest`, "strip", "anthropic");
    expect(system).toBe("rest");
    expect(report.billingHeaderAction).toBe("stripped");
  });
});

describe("anthropicToOpenaiPayload", () => {
  it("swaps the model, preserves system, and passes through generation params", () => {
    const body = {
      model: "claude-3-5-haiku-latest",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      stream: false,
    };
    const { payload, report } = anthropicToOpenaiPayload(body, "deepseek-chat", "strip_for_non_anthropic_upstream", "openai");
    expect(payload["model"]).toBe("deepseek-chat");
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe("You are helpful.");
    expect(messages[1]?.["role"]).toBe("user");
    expect(payload["max_tokens"]).toBe(100);
    expect(payload["stream"]).toBe(false);
    expect(report.billingHeaderAction).toBe("none");
  });

  it("converts stop_sequences to stop and tools to openai function tools", () => {
    const body = {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["end"],
      tools: [{ name: "foo", description: "d", input_schema: { type: "object" } }],
    };
    const { payload } = anthropicToOpenaiPayload(body, "m", "strip_for_non_anthropic_upstream", "openai");
    expect(payload["stop"]).toEqual(["end"]);
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]?.["type"]).toBe("function");
    expect((tools[0]?.["function"] as Record<string, unknown>)?.["name"]).toBe("foo");
  });

  it("strips a billing header from the system first line during conversion", () => {
    const body = { model: "claude-x", system: `${HEADER_LINE}\nYou are helpful.`, messages: [] };
    const { payload, report } = anthropicToOpenaiPayload(body, "m", "strip_for_non_anthropic_upstream", "openai");
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["content"]).toBe("You are helpful.");
    expect(report.billingHeaderAction).toBe("stripped");
  });
});

describe("anthropicPassthroughPayload", () => {
  it("keeps the anthropic shape and only swaps the model", () => {
    const body = { model: "claude-x", system: "sys", messages: [{ role: "user", content: "hi" }] };
    const { payload } = anthropicPassthroughPayload(body, "real-model", "pass_through", "anthropic");
    expect(payload["model"]).toBe("real-model");
    expect(payload["system"]).toBe("sys");
    expect(payload["messages"]).toEqual(body.messages);
  });
});

describe("anthropicContentToOpenai", () => {
  it("returns plain strings unchanged", () => {
    expect(anthropicContentToOpenai("hello")).toBe("hello");
  });

  it("joins text blocks and drops images when there are no images", () => {
    expect(anthropicContentToOpenai([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("emits image_url blocks when an image is present", () => {
    const out = anthropicContentToOpenai([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    ]) as Array<Record<string, unknown>>;
    expect(Array.isArray(out)).toBe(true);
    const img = out.find((b) => b["type"] === "image_url") as Record<string, unknown>;
    const url = (img["image_url"] as Record<string, unknown>)?.["url"];
    expect(url).toBe("data:image/png;base64,AAA");
  });
});

describe("anthropicToolsToOpenai", () => {
  it("maps input_schema to parameters", () => {
    const out = anthropicToolsToOpenai([{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }]);
    expect(out[0]?.["type"]).toBe("function");
    expect((out[0]?.["function"] as Record<string, unknown>)?.["parameters"]).toEqual({ type: "object", properties: {} });
  });
});

describe("roughCountTokens", () => {
  it("returns a positive integer estimate", () => {
    const out = roughCountTokens({ system: "hello world", messages: [{ role: "user", content: "more text here" }] });
    expect(out["input_tokens"]).toBeGreaterThan(0);
  });
});
