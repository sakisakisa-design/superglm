// Streaming helpers — SSE frame construction & parsing, mirrors the SSE
// generators in backend/app/main.py (anthropic_sse / openai_sse / responses_sse).

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseData(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export interface SseFrame {
  event: string | null;
  data: string;
}

/** Parse one SSE frame (already split on blank lines). */
export function parseSseFrame(frame: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0 && event === null) return null;
  return { event, data: dataLines.join("\n") };
}

/** Decode the JSON payload of an SSE data line, or null if not JSON. */
export function sseFrameData(frame: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read an upstream SSE stream line-by-line and yield each `data:` payload
 * (string, possibly "[DONE]"). Mirrors httpx aiter_lines + data: stripping in
 * backend/app/upstream.iter_openai_chat_stream.
 */
export async function* iterSseData(
  response: Response,
): AsyncGenerator<string, void, unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.replace(/\r$/, "").trim();
        if (!line) continue;
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        } else if (line.startsWith(":")) {
          // comment / heartbeat
          continue;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Chunk a string into pieces of `size` for SSE delta emission (mirrors range(0,len,96)). */
export function chunkText(text: string, size = 96): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
