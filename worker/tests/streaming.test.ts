import { encodeSseEvent, encodeData, encodeDone, iterSseData } from "../src/adapters/sse";
import { openaiStreamDelta, openaiStreamParts } from "../src/adapters/openaiOut";
import { anthropicMessagesStream } from "../src/adapters/anthropicOut";
import { chunkText } from "../src/utils/stream";

describe("sse encoders", () => {
  it("encodes an event frame with JSON data", () => {
    expect(encodeSseEvent("message_start", { a: 1 })).toBe('event: message_start\ndata: {"a":1}\n\n');
  });

  it("encodes a data-only frame", () => {
    expect(encodeData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it("encodes the [DONE] terminator", () => {
    expect(encodeDone()).toBe("data: [DONE]\n\n");
  });
});

describe("openaiStreamDelta", () => {
  it("treats [DONE] as a stop finish reason", () => {
    expect(openaiStreamDelta("[DONE]")).toEqual({ text: "", finishReason: "stop" });
  });

  it("extracts content delta and finish reason", () => {
    const line = JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] });
    expect(openaiStreamDelta(line)).toEqual({ text: "hi", finishReason: null });
  });

  it("returns empty on non-JSON input", () => {
    expect(openaiStreamDelta("not json")).toEqual({ text: "", finishReason: null });
  });
});

describe("openaiStreamParts", () => {
  it("extracts tool_call deltas and reasoning_content", () => {
    const line = JSON.stringify({
      choices: [
        {
          delta: { content: "x", tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }], reasoning_content: "think" },
          finish_reason: null,
        },
      ],
    });
    const parts = openaiStreamParts(line);
    expect(parts.text).toBe("x");
    expect(parts.reasoning).toBe("think");
    expect(parts.toolCalls.length).toBe(1);
    expect(parts.finishReason).toBeNull();
  });
});

describe("anthropicMessagesStream", () => {
  it("emits the full Anthropic SSE event sequence ending in message_stop", async () => {
    const chunks: string[] = [];
    for await (const c of anthropicMessagesStream({ id: "m1", model: "claude-x", content: "hello", stopReason: "end_turn" })) {
      chunks.push(c);
    }
    const joined = chunks.join("");
    expect(joined).toContain("event: message_start");
    expect(joined).toContain("event: content_block_start");
    expect(joined).toContain("event: content_block_delta");
    expect(joined).toContain("event: message_delta");
    expect(joined).toContain("event: message_stop");
    expect(joined).toContain("data: [DONE]");
  });
});

describe("chunkText", () => {
  it("splits text into fixed-size pieces", () => {
    expect(chunkText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(chunkText("abc", 2)).toEqual(["ab", "c"]);
  });
});

describe("iterSseData", () => {
  it("yields each data: payload from an SSE response body", async () => {
    const body = "data: hello\n\ndata: {\"a\":1}\n\ndata: [DONE]\n\n";
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out: string[] = [];
    for await (const d of iterSseData(response)) out.push(d);
    expect(out).toEqual(["hello", '{"a":1}', "[DONE]"]);
  });
});
