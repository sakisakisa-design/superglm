// Dashboard API client — thin fetch helpers over the Worker's /api/* endpoints.
// Every protected route sends Authorization: Bearer <key>. /api/health is public.
// On 401, forget the stored key and throw AuthError so the UI returns to the locked state.

import { authHeaders, forgetKey, AuthError } from "./auth";

async function getJson<T>(path: string, opts: { public?: boolean } = {}): Promise<T> {
  const headers = opts.public ? {} : authHeaders();
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    forgetKey();
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : null,
  });
  if (res.status === 401) {
    forgetKey();
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export { AuthError } from "./auth";

export interface ProviderRow {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key?: string;
  default_model?: string;
  capabilities?: { models?: string[] };
  enabled?: boolean;
}

export interface AliasRow {
  id: string;
  alias: string;
  target_model: string;
  provider_id?: string | null;
  strategy: string;
  role?: string;
  enabled?: boolean;
}

export interface TraceRow {
  trace_id: string;
  incoming_model?: string;
  upstream_model?: string;
  upstream_provider_id?: string;
  status: string;
  latency_ms?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  steps?: Array<Record<string, unknown>>;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  method?: string;
  path?: string;
}

export interface Overview {
  config: { server?: { public_base_url?: string }; security?: { local_api_key?: string }; runtime?: { mode?: string } };
  providers: ProviderRow[];
  aliases: AliasRow[];
  recent_traces: TraceRow[];
  stats: { providers: number; aliases: number; traces: number };
}

export const api = {
  overview: () => getJson<Overview>("/api/overview"),
  health: () => getJson<{ ok: boolean; service: string; time: string }>("/api/health", { public: true }),

  listProviders: () => getJson<{ providers: ProviderRow[] }>("/api/providers"),
  saveProvider: (p: Partial<ProviderRow>) => sendJson<{ id: string }>("POST", "/api/providers", p),
  deleteProvider: (id: string) => sendJson<{ deleted: string }>("DELETE", `/api/providers/${encodeURIComponent(id)}`),

  listAliases: () => getJson<{ aliases: AliasRow[] }>("/api/aliases"),
  saveAlias: (a: Partial<AliasRow>) => sendJson<AliasRow>("POST", "/api/aliases", a),
  deleteAlias: (alias: string) => sendJson<{ deleted: string }>("DELETE", `/api/aliases/${encodeURIComponent(alias)}`),

  listTraces: (limit = 50) => getJson<{ traces: TraceRow[] }>(`/api/traces?limit=${limit}`),
  getTrace: (id: string) => getJson<TraceRow>(`/api/traces/${encodeURIComponent(id)}`),

  testConnection: (body: { provider_id?: string; base_url?: string; api_key?: string; protocol?: string; model?: string }) =>
    sendJson<{ ok: boolean; status: string; latency_ms?: number; ttfb_ms?: number; model?: string; error?: string }>("POST", "/api/test-connection", body),

  claudeSmoke: () => sendJson<{ ok: boolean; base_url: string; env: Record<string, string> }>("POST", "/api/claude-code/smoke", {}),
};
