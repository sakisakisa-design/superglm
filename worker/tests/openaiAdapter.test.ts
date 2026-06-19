import { openaiChatPayload } from "../src/adapters/openaiIn";
import {
  normalizeOpenAIChat,
  buildOpenAIChatResponse,
  openaiChatStream,
  type NormalizedCompletion,
} from "../src/adapters/openaiOut";
import {
  responsesToChatPayload,
  responsesToolsToOpenai,
  buildResponsesResponse,
  responsesInputToMessages,
} from "../src/adapters/responsesIn";

describe("openaiChatPayload", () => {
  it("swaps the incoming model for the resolved target model", () => {
    const out = openaiChatPayload({ model: "alias-x", messages: [], temperature: 0.7 }, "real-model");
    expect(out["model"]).toBe("real-model");
    expect(out["temperature"]).toBe(0.7);
  });
});

describe("normalizeOpenAIChat / buildOpenAIChatResponse", () => {
  it("normalizes an upstream OpenAI chat response", () => {
    const completion = normalizeOpenAIChat(
      {
        id: "chatcmpl-1",
        model: "real-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
      "alias-x",
    );
    expect(completion.content).toBe("hi");
    expect(completion.stopReason).toBe("stop");
    expect(completion.usage?.inputTokens).toBe(5);
    expect(completion.usage?.outputTokens).toBe(3);
    expect(completion.usage?.totalTokens).toBe(8);
    expect(completion.model).toBe("alias-x");
  });

  it("builds a chat.completion object from a normalized completion", () => {
    const completion: NormalizedCompletion = {
      id: "chatcmpl-1",
      model: "alias-x",
      content: "hello",
      stopReason: "stop",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    };
    const resp = buildOpenAIChatResponse(completion);
    expect(resp["object"]).toBe("chat.completion");
    const choices = resp["choices"] as Array<Record<string, unknown>>;
    const msg = choices[0]?.["message"] as Record<string, unknown>;
    expect(msg["content"]).toBe("hello");
    const usage = resp["usage"] as Record<string, number>;
    expect(usage["total_tokens"]).toBe(4);
  });

  it("emits a chat.completion.chunk stream terminated by [DONE]", async () => {
    const completion: NormalizedCompletion = { id: "c1", model: "m", content: "abcd", stopReason: "stop" };
    const chunks: string[] = [];
    for await (const c of openaiChatStream(completion)) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain("chat.completion.chunk");
    expect(joined).toContain("data: [DONE]");
  });
});

describe("responsesInputToMessages", () => {
  it("turns instructions + string input into system + user messages", () => {
    const messages = responsesInputToMessages({ instructions: "sys", input: "hi" });
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe("sys");
    expect(messages[1]?.["role"]).toBe("user");
    expect(messages[1]?.["content"]).toBe("hi");
  });

  it("maps function_call and function_call_output items into tool calls + tool results", () => {
    const messages = responsesInputToMessages({
      input: [
        { type: "function_call", call_id: "call_1", name: "do", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const assistant = messages.find((m) => m["role"] === "assistant") as Record<string, unknown>;
    const toolCalls = assistant["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls?.[0]?.["id"]).toBe("call_1");
    const tool = messages.find((m) => m["role"] === "tool") as Record<string, unknown>;
    expect(tool?.["tool_call_id"]).toBe("call_1");
    const user = messages.find((m) => m["role"] === "user") as Record<string, unknown>;
    expect(user?.["content"]).toBe("next");
  });
});

describe("responsesToChatPayload", () => {
  it("builds a chat payload with the target model and max_tokens from max_output_tokens", () => {
    const { payload } = responsesToChatPayload(
      { model: "r", instructions: "sys", input: "hi", max_output_tokens: 128, stream: false },
      "real-model",
    );
    expect(payload["model"]).toBe("real-model");
    expect(payload["max_tokens"]).toBe(128);
    expect(payload["stream"]).toBe(false);
  });
});

describe("responsesToolsToOpenai", () => {
  it("passes through openai-style function tools and wraps bare function tools", () => {
    const out = responsesToolsToOpenai([
      { type: "function", function: { name: "a", description: "d", parameters: {} } },
      { type: "function", name: "b", description: "d", parameters: { type: "object" } },
    ]);
    expect(out.length).toBe(2);
    expect((out[0]?.["function"] as Record<string, unknown>)?.["name"]).toBe("a");
    expect((out[1]?.["function"] as Record<string, unknown>)?.["name"]).toBe("b");
  });
});

describe("buildResponsesResponse", () => {
  it("builds a response object with output_text and completed status", () => {
    const completion: NormalizedCompletion = { id: "r1", model: "alias-x", content: "hello", stopReason: "stop" };
    const resp = buildResponsesResponse(completion, "alias-x");
    expect(resp["object"]).toBe("response");
    expect(resp["status"]).toBe("completed");
    expect(resp["output_text"]).toBe("hello");
    const output = resp["output"] as Array<Record<string, unknown>>;
    expect(output.length).toBeGreaterThan(0);
  });
});
