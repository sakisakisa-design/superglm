// Authentication — mirrors backend/app/security.require_local_key.
//
// Two sources of truth, checked in order:
//   1. config.security.local_api_key  (direct compare, backward-compat with local edition)
//   2. api_keys table (SHA-256 hashed keys, Worker hardened mode)
//
// Token is extracted from Authorization: Bearer <token> or x-api-key header,
// exactly like the Python edition.

import type { SuperDeepSeekConfig } from "../types/config";
import type { Env } from "../types/internal";
import { hashKey, timingSafeEqual } from "./keyHash";

export interface AuthResult {
  ok: boolean;
  reason?: string;
  keyId?: string;
  label?: string;
  scopes?: string[];
}

/** Scope constants: "*" = full access, "admin" = dashboard management, "invoke" = proxy calls. */
export const SCOPE_ADMIN = "admin";
export const SCOPE_INVOKE = "invoke";

export function hasScope(auth: AuthResult, scope: string): boolean {
  const scopes = auth.scopes;
  if (!scopes || scopes.length === 0) return true;
  return scopes.includes("*") || scopes.includes(scope);
}

function extractToken(headers: Headers): string {
  const auth = headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim();
  return "";
}

export async function authenticate(
  request: Request,
  config: SuperDeepSeekConfig,
  env: Env,
  opts: { requireKey?: boolean } = {},
): Promise<AuthResult> {
  const expected = config.security?.local_api_key ?? "";

  // No configured key and no DB keys: decide based on requireKey.
  const hasDbKeys = env.DB != null;

  if (!expected && !hasDbKeys) {
    if (opts.requireKey) {
      return { ok: false, reason: "missing_or_invalid_local_api_key" };
    }
    return { ok: true };
  }

  const token = extractToken(request.headers);

  // 1. Direct compare against config.security.local_api_key.
  if (expected) {
    if (token && timingSafeEqual(token, expected)) {
      return { ok: true, scopes: ["*"] };
    }
    // If no DB keys to fall back to, fail fast.
    if (!hasDbKeys) {
      return {
        ok: false,
        reason: "missing_or_invalid_local_api_key",
      };
    }
  }

  // 2. Hashed keys in D1.
  if (!token) {
    return { ok: false, reason: "missing_or_invalid_local_api_key" };
  }
  const hash = await hashKey(token);
  const row = await env.DB.prepare(
    "SELECT id, label, scopes, enabled FROM api_keys WHERE key_hash = ? AND enabled = 1",
  )
    .bind(hash)
    .first<{ id: string; label: string | null; scopes: string; enabled: number }>();

  if (!row || !row.enabled) {
    return { ok: false, reason: "missing_or_invalid_local_api_key" };
  }

  await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(row.id)
    .run();

  let scopes: string[] = ["*"];
  try {
    scopes = JSON.parse(row.scopes) as string[];
    if (!Array.isArray(scopes)) scopes = ["*"];
  } catch {
    scopes = ["*"];
  }

  const result: AuthResult = { ok: true, keyId: row.id, scopes };
  if (row.label) result.label = row.label;
  return result;
}

export function authDenied(result: AuthResult): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: result.reason ?? "missing_or_invalid_local_api_key",
        message:
          "Use ANTHROPIC_API_KEY/OPENAI_API_KEY with the Super DeepSeek gateway key.",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}
