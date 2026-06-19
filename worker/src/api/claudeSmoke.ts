// Claude Code smoke test — mirrors backend /api/claude-code/smoke.
// Returns the env vars + base URL a user needs to point Claude Code at the Worker,
// plus a tiny request shape the dashboard can fire to verify the /v1/messages path.

import { jsonResponse, type RouteCtx } from "../router";

export async function claudeSmoke(ctx: RouteCtx): Promise<Response> {
  const baseUrl = ctx.config.server?.public_base_url ?? publicBaseUrl(ctx.request);
  const hasKey = Boolean(ctx.config.security?.local_api_key);
  // Never return the actual gateway key. Show the env var template instead.
  return jsonResponse(200, {
    ok: true,
    base_url: baseUrl,
    model: "claude-3-5-haiku-latest",
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: hasKey ? "<your configured gateway key>" : "<set SUPERDS_LOCAL_API_KEY or create an api_key>",
    },
    smoke_request: {
      model: "claude-3-5-haiku-latest",
      max_tokens: 64,
      messages: [{ role: "user", content: "Super DeepSeek smoke test." }],
    },
  });
}

function publicBaseUrl(request: Request): string {
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://superdeepseek.example.dev";
  }
}
