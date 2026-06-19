import type { Env } from "../types/internal";
import { jsonResponse } from "../router";

export function healthHandler(env: Env): Response {
  return jsonResponse(200, {
    ok: true,
    service: "superdeepseek-worker",
    time: new Date().toISOString(),
    db: env.DB != null,
  });
}
