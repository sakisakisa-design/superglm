import { describe, expect, it } from "vitest";
import { encodeSseEvent, encodeData, encodeDone, encodeComment, parseSseData } from "../src/adapters/sse";

describe("encodeComment", () => {
  it("produces a single-line SSE comment frame (`: text\\n\\n`)", () => {
    expect(encodeComment("panel m1 success")).toBe(": panel m1 success\n\n");
  });

  it("collapses embedded newlines so the comment never breaks the SSE frame", () => {
    const out = encodeComment("a\nb\r\nc");
    expect(out).toBe(": a b c\n\n");
    // No raw newline between the `:` and the terminating blank line.
    expect(out.slice(1, out.length - 2)).not.toMatch(/[\r\n]/);
  });
});

describe("encodeSseEvent / encodeData / encodeDone", () => {
  it("encodeSseEvent emits event + json data lines", () => {
    expect(encodeSseEvent("ping", { ok: true })).toBe('event: ping\ndata: {"ok":true}\n\n');
  });

  it("encodeData emits a data-only frame", () => {
    expect(encodeData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it("encodeDone emits the sentinel", () => {
    expect(encodeDone()).toBe("data: [DONE]\n\n");
  });
});

describe("parseSseData", () => {
  it("parses JSON data lines", () => {
    expect(parseSseData('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for [DONE]", () => {
    expect(parseSseData("[DONE]")).toBeNull();
  });

  it("returns null for non-JSON", () => {
    expect(parseSseData("not json")).toBeNull();
  });
});
