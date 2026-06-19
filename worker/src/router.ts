// Route helpers shared by the dashboard API handlers. Kept dependency-free (no
// api/* imports) so src/api/*.ts can import from here without circular modules.
// Request dispatch lives in src/index.ts.

import type { Env } from "./types/internal";
import type { SuperDeepSeekConfig } from "./types/config";
import type { ConfigStore } from "./storage/configStore";
import type { TraceStore } from "./storage/traceStore";
import { errorResponse } from "./utils/errors";

/** Per-request context handed to dashboard API handlers. */
export interface RouteCtx {
  env: Env;
  config: SuperDeepSeekConfig;
  configStore: ConfigStore;
  traceStore: TraceStore;
  request: Request;
  params: Record<string, string>;
  url: URL;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Parse a JSON request body, or return a 400 Response on invalid JSON. */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "invalid_request", "invalid json body");
  }
}
