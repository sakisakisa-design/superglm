// OpenAI Responses API input adapter. Mirrors backend/app/multimodal.responses_input_to_messages
// and backend/app/main.openai_responses: converts a Responses `response.create` body into an
// OpenAI Chat Completions payload (the Worker edition always speaks Chat Completions upstream).
//
// Also mirrors the responses→chat passthrough field set from backend/app/main.RESPONSES_TO_CHAT_PASSTHROUGH.

const RESPONSES_TO_CHAT_PASSTHROUGH = new Set([
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thinking_budget",
  "enable_thinking",
  "include_reasoning",
  "response_format",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "tool_choice",
  "service_tier",
  "metadata",
  "extra_body",
]);

export function responsesToolsToOpenai(
  tools: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools ?? []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      out.push(tool as Record<string, unknown>);
    } else if (tool.type === "function" && tool.name) {
      out.push({
        type: "function",
        function: {
          name: tool.name,
          description: (tool.description as string) ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block === "string") out.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" || b.type === "input_text" || b.type === "output_text") {
        out.push((b.text as string) ?? "");
      }
    }
  }
  return out.filter(Boolean);
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const t = (block as Record<string, unknown>).type;
    return t === "input_image" || t === "image_url";
  });
}

function openaiContentFromResponses(content: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of (Array.isArray(content) ? content : []) as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "input_text") {
      out.push({ type: "text", text: (block.text as string) ?? "" });
    } else if (block.type === "image_url") {
      out.push(block);
    } else if (block.type === "input_image") {
      const url = (block.image_url as string) ?? (block.url as string);
      if (url) out.push({ type: "image_url", image_url: { url } });
    }
  }
  return out;
}

/** Convert a Responses API `input` into OpenAI chat messages. Mirrors responses_input_to_messages. */
export function responsesInputToMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  const items = (Array.isArray(input) ? input : []) as Array<Record<string, unknown>>;
  let pendingToolCalls: Array<Record<string, unknown>> = [];
  let pendingReasoning = "";

  const flush = () => {
    if (pendingToolCalls.length === 0) return;
    const msg: Record<string, unknown> = { role: "assistant", content: "", tool_calls: pendingToolCalls };
    if (pendingReasoning) msg.reasoning_content = pendingReasoning;
    messages.push(msg);
    pendingToolCalls = [];
    pendingReasoning = "";
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const role = (item.role as string) ?? "user";
    if (item.type === "function_call") {
      let args = (item.arguments as string) ?? "";
      if (typeof args !== "string") args = JSON.stringify(args);
      const callId = (item.call_id as string) ?? (item.id as string) ?? "call_superds";
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name: (item.name as string) ?? "", arguments: args },
      });
      if (item._superds_reasoning_content) pendingReasoning = String(item._superds_reasoning_content);
    } else if (item.type === "function_call_output") {
      flush();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: (item.output as string) ?? "" });
    } else if (item.type === "message" || ["user", "assistant", "system", "developer"].includes(role)) {
      flush();
      let r = role;
      if (r === "developer") r = "system";
      const content = item.content;
      if (contentHasImage(content)) {
        messages.push({ role: r, content: openaiContentFromResponses(content) });
      } else {
        messages.push({ role: r, content: textFromContent(content).join("\n") });
      }
    }
  }
  flush();
  return messages;
}

import { newResponseId, newShortMessageId, newFunctionCallId, newCallId } from "../utils/ids";
import { chunkText } from "../utils/stream";
import { encodeSseEvent, encodeDone } from "./sse";
import type { NormalizedCompletion } from "./openaiOut";

export interface ResponsesConversionResult {
  payload: Record<string, unknown>;
}

/** Convert a Responses API request body into a Chat Completions payload. */
export function responsesToChatPayload(
  body: Record<string, unknown>,
  targetModel: string,
): ResponsesConversionResult {
  const messages = responsesInputToMessages(body);
  const payload: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream: Boolean(body.stream),
  };
  if (body.max_output_tokens != null) payload.max_tokens = body.max_output_tokens;
  for (const key of RESPONSES_TO_CHAT_PASSTHROUGH) {
    if (key in body && body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  if (body.tools) payload.tools = responsesToolsToOpenai(body.tools as Array<Record<string, unknown>>);
  return { payload };
}

// ---- Responses output (OpenAI Chat -> Responses API) ----
// Mirrors backend/app/main.openai_to_responses_response + responses_sse.
// No separate responsesOut.ts in the layout, so responses-direction logic lives here.

export function responsesOutputFromCompletion(
  completion: NormalizedCompletion,
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (completion.content) {
    output.push({
      id: newShortMessageId(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: completion.content, annotations: [] }],
    });
  }
  for (const call of completion.toolCalls ?? []) {
    output.push({
      id: call.id ?? newFunctionCallId(),
      type: "function_call",
      status: "completed",
      call_id: call.id ?? newCallId(),
      name: call.name ?? "",
      arguments: call.arguments ?? "",
    });
  }
  if (output.length === 0) {
    output.push({
      id: newShortMessageId(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }
  return output;
}

export function buildResponsesResponse(
  completion: NormalizedCompletion,
  requestModel: string,
): Record<string, unknown> {
  const usage = completion.usage ?? {};
  return {
    id: newResponseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    background: false,
    error: null,
    model: requestModel,
    output: responsesOutputFromCompletion(completion),
    output_text: completion.content,
    usage: {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
    },
  };
}

/** Buffered Responses SSE stream from a normalized completion (mirrors responses_sse). */
export async function* responsesStream(
  completion: NormalizedCompletion,
): AsyncGenerator<string, void, unknown> {
  const response = buildResponsesResponse(completion, completion.model);
  const responseId = (response.id as string) ?? newResponseId();
  let seq = 1;
  yield encodeSseEvent("response.created", {
    type: "response.created",
    sequence_number: seq,
    response: { ...response, status: "in_progress", output: [] },
  });
  for (let i = 0; i < (response.output as Array<Record<string, unknown>>).length; i++) {
    const item = (response.output as Array<Record<string, unknown>>)[i]!;
    seq += 1;
    if (item.type === "function_call") {
      yield encodeSseEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: seq,
        output_index: i,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      const args = (item.arguments as string) ?? "";
      if (args) {
        seq += 1;
        yield encodeSseEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: seq,
          item_id: item.id,
          output_index: i,
          delta: args,
        });
      }
      seq += 1;
      yield encodeSseEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: seq,
        item_id: item.id,
        output_index: i,
        arguments: args,
      });
      seq += 1;
      yield encodeSseEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: seq,
        output_index: i,
        item,
      });
      continue;
    }
    const text = (((item.content as Array<Record<string, unknown>>) ?? [])[0]?.text as string) ?? "";
    const itemId = (item.id as string) ?? newShortMessageId();
    yield encodeSseEvent("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: seq,
      output_index: i,
      item: { ...item, content: [] },
    });
    seq += 1;
    yield encodeSseEvent("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: seq,
      item_id: itemId,
      output_index: i,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const chunk of chunkText(text)) {
      seq += 1;
      yield encodeSseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: seq,
        item_id: itemId,
        output_index: i,
        content_index: 0,
        delta: chunk,
      });
    }
    seq += 1;
    yield encodeSseEvent("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: seq,
      item_id: itemId,
      output_index: i,
      content_index: 0,
      text,
    });
    seq += 1;
    yield encodeSseEvent("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: seq,
      item_id: itemId,
      output_index: i,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    seq += 1;
    yield encodeSseEvent("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: seq,
      output_index: i,
      item,
    });
  }
  seq += 1;
  yield encodeSseEvent("response.completed", {
    type: "response.completed",
    sequence_number: seq,
    response: { ...response, id: responseId },
  });
  yield encodeDone();
}
