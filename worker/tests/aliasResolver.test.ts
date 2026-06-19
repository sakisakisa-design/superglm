import { resolveAlias, type AliasRule } from "../src/compat/aliasResolver";

describe("resolveAlias", () => {
  it("returns the original model when there are no rules", () => {
    expect(resolveAlias("gpt-4", [])).toBe("gpt-4");
  });

  it("falls back to the original model when nothing matches", () => {
    const rules: AliasRule[] = [{ alias: "claude-3", target: "claude-3-opus" }];
    expect(resolveAlias("gpt-4", rules)).toBe("gpt-4");
  });

  it("resolves an exact alias to its literal target", () => {
    const rules: AliasRule[] = [{ alias: "gpt-4", target: "gpt-4-turbo" }];
    expect(resolveAlias("gpt-4", rules)).toBe("gpt-4-turbo");
  });

  it("resolves a wildcard alias and substitutes the captured segment", () => {
    const rules: AliasRule[] = [{ alias: "openai/*", target: "azure/*" }];
    expect(resolveAlias("openai/gpt-4", rules)).toBe("azure/gpt-4");
  });

  it("matches a wildcard with both prefix and suffix", () => {
    const rules: AliasRule[] = [
      { alias: "openai/*-mini", target: "azure/*-mini" },
    ];
    expect(resolveAlias("openai/gpt-4-mini", rules)).toBe("azure/gpt-4-mini");
    expect(resolveAlias("openai/gpt-4", rules)).toBe("openai/gpt-4");
  });

  it("prefers an exact alias over a matching wildcard", () => {
    const rules: AliasRule[] = [
      { alias: "openai/*", target: "azure/*" },
      { alias: "openai/gpt-4", target: "openai-gpt-4-0613" },
    ];
    expect(resolveAlias("openai/gpt-4", rules)).toBe("openai-gpt-4-0613");
  });

  it("keeps exact priority even when the wildcard is listed first", () => {
    const rules: AliasRule[] = [
      { alias: "gpt-*", target: "gpt-wildcard" },
      { alias: "gpt-4", target: "gpt-4-exact" },
    ];
    expect(resolveAlias("gpt-4", rules)).toBe("gpt-4-exact");
  });

  it("treats a bare '*' wildcard as a catch-all below exact rules", () => {
    const rules: AliasRule[] = [
      { alias: "*", target: "default-model" },
      { alias: "gpt-4", target: "gpt-4-turbo" },
    ];
    expect(resolveAlias("gpt-4", rules)).toBe("gpt-4-turbo");
    expect(resolveAlias("anything-else", rules)).toBe("default-model");
  });

  it("returns a literal target when the wildcard target has no '*'", () => {
    const rules: AliasRule[] = [{ alias: "openai/*", target: "fixed-model" }];
    expect(resolveAlias("openai/gpt-4", rules)).toBe("fixed-model");
  });

  it("uses the first matching wildcard in array order", () => {
    const rules: AliasRule[] = [
      { alias: "openai/*", target: "first" },
      { alias: "openai/*", target: "second" },
    ];
    expect(resolveAlias("openai/gpt-4", rules)).toBe("first");
  });

  it("matches a wildcard that captures an empty segment", () => {
    const rules: AliasRule[] = [{ alias: "openai/*", target: "azure/*" }];
    expect(resolveAlias("openai/", rules)).toBe("azure/");
  });

  it("does exact matching case-sensitively", () => {
    const rules: AliasRule[] = [{ alias: "GPT-4", target: "gpt-4-turbo" }];
    expect(resolveAlias("gpt-4", rules)).toBe("gpt-4");
    expect(resolveAlias("GPT-4", rules)).toBe("gpt-4-turbo");
  });

  it("does not treat a captured segment with '$' as a replacement pattern", () => {
    const rules: AliasRule[] = [{ alias: "p/*", target: "q/*" }];
    expect(resolveAlias("p/$&x", rules)).toBe("q/$&x");
  });
});
