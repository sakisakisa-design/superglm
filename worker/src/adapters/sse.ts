// SSE frame construction for protocol output streams.
// Mirrors the SSE generators in backend/app/main.py.
// `encodeSseEvent` / `encodeDone` are consumed by src/adapters/anthropicOut.ts.

export function encodeSseEvent(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function encodeData(data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${payload}\n\n`;
}

export function encodeDone(): string {
  return "data: [DONE]\n\n";
}

/** Parse a `data:` SSE line payload into JSON, or null if not JSON / [DONE]. */
export function parseSseData(line: string): Record<string, unknown> | null {
  if (!line || line === "[DONE]") return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Iterate an upstream SSE response body, yielding each `data:` payload string
 * (including "[DONE]"). Mirrors httpx aiter_lines + data: stripping in
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
