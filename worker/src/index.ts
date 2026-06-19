// SuperDeepSeek Worker entry point.
//   * Re-exports Env (src/auth/auth.ts imports `Env` from "../index").
//   * Wires D1-backed config/store/trace/router singletons (module-level cache so
//     circuit-breaker + round-robin state survive across requests in an isolate).
//   * Dispatches dashboard API (/api/*, admin-auth-gated except /api/health),
//     proxy endpoints (/v1/*, /openai/v1/*, gateway-auth-gated),
//     and falls back to the static-assets dashboard SPA.
//
// The local Python edition serves everything from one FastAPI process on :8787.
// The Worker edition serves the dashboard from Workers Static Assets and the
// API/proxy from this Worker, with D1 as the only persistence layer.

import type { Env } from "./types/internal";
import { loadConfig, getOverview, getConfigHandler, putConfigHandler } from "./api/dashboard";
import { listProviders, getProvider, putProvider, deleteProvider } from "./api/providers";
import { listProfiles, createProfile, putProfile, deleteProfile } from "./api/profiles";
import { listAliases, putAlias, deleteAlias } from "./api/aliases";
import { listTraces, getTrace } from "./api/traces";
import { testConnection } from "./api/testConnection";
import { claudeSmoke } from "./api/claudeSmoke";
import { healthWithConfig } from "./api/health";
import { listProviderPresets } from "./api/providerPresets";
import { listModelCapabilities } from "./api/modelCapabilities";
import { visionCheck } from "./api/visionCheck";
import { clearLogs } from "./api/logs";
import { routerStatus } from "./api/routerStatus";
import { authenticate, authDenied, hasScope, SCOPE_ADMIN, SCOPE_INVOKE } from "./auth/auth";
import { ConfigStore } from "./storage/configStore";
import { ensureD1Schema, __resetD1SchemaForTest } from "./storage/d1";
import { TraceStore } from "./storage/traceStore";
import { ProviderRouter } from "./upstream/router";
import {
  handleAnthropicMessages,
  handleOpenAIChat,
  handleOpenAIResponses,
  handleCountTokens,
  listAnthropicModels,
  listOpenAIModels,
  type PipelineDeps,
  type RequestContext,
} from "./runtime/pipeline";

export type { Env } from "./types/internal";

interface Singletons {
  configStore: ConfigStore;
  traceStore: TraceStore;
  router: ProviderRouter;
}

// Module-level cache: ProviderRouter holds in-memory circuit-breaker and round-robin
// state. Rebuilding it per request would reset that state on every fetch. Cached at
// module scope, the state persists for the lifetime of the Worker isolate (the same
// pattern the local edition uses with app.state.provider_router).
let cachedSingletons: Singletons | null = null;

function getSingletons(env: Env): Singletons {
  if (!cachedSingletons) {
    const configStore = new ConfigStore(env.DB, env.ENCRYPTION_KEY);
    const traceStore = new TraceStore(env.DB);
    const router = new ProviderRouter(configStore);
    cachedSingletons = { configStore, traceStore, router };
  }
  return cachedSingletons;
}

/** Test hook: reset the module-level singleton cache (so tests get isolated state). */
export function __resetSingletonsForTest(): void {
  cachedSingletons = null;
  __resetD1SchemaForTest();
}

function scopeDenied(): Response {
  return new Response(
    JSON.stringify({ error: { type: "insufficient_scope", message: "This key does not have the required scope." } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

async function serveApi(
  request: Request,
  env: Env,
  singletons: Singletons,
): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // /api/health is the only unauthenticated management endpoint.
  if (path === "/api/health" && method === "GET") {
    const config = await loadConfig(env);
    const store = new ConfigStore(env.DB, env.ENCRYPTION_KEY);
    const traceStore = new TraceStore(env.DB);
    const ctx = { env, config, configStore: store, traceStore, request, params: {} as Record<string, string>, url };
    return healthWithConfig(ctx);
  }

  // All other /api/* require admin auth.
  const config = await loadConfig(env);
  const auth = await authenticate(request, config, env);
  if (!auth.ok) return authDenied(auth);
  if (!hasScope(auth, SCOPE_ADMIN)) return scopeDenied();

  const ctx = {
    env,
    config,
    configStore: singletons.configStore,
    traceStore: singletons.traceStore,
    request,
    params: {} as Record<string, string>,
    url,
  };

  // ---- config / overview ----
  if (path === "/api/overview" && method === "GET") return getOverview(ctx);
  if (path === "/api/config" && method === "GET") return getConfigHandler(ctx);
  if (path === "/api/config" && method === "PUT") return putConfigHandler(ctx);

  // ---- providers ----
  if (path === "/api/providers" && method === "GET") return listProviders(ctx);
  if (path === "/api/providers" && method === "POST") return putProvider(ctx);
  const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch) {
    ctx.params = { id: decodeURIComponent(providerMatch[1]!) };
    if (method === "GET") return getProvider(ctx);
    if (method === "PUT") return putProvider(ctx);
    if (method === "DELETE") return deleteProvider(ctx);
  }

  // ---- profiles ----
  if (path === "/api/profiles" && method === "GET") return listProfiles(ctx);
  if (path === "/api/profiles" && method === "POST") return createProfile(ctx);
  const profileMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch) {
    ctx.params = { id: decodeURIComponent(profileMatch[1]!) };
    if (method === "PUT") return putProfile(ctx);
    if (method === "DELETE") return deleteProfile(ctx);
  }

  // ---- aliases ----
  if (path === "/api/aliases" && method === "GET") return listAliases(ctx);
  if (path === "/api/aliases" && method === "POST") return putAlias(ctx);
  const aliasMatch = path.match(/^\/api\/aliases\/(.+)$/);
  if (aliasMatch && method === "DELETE") {
    ctx.params = { alias: decodeURIComponent(aliasMatch[1]!) };
    return deleteAlias(ctx);
  }

  // ---- traces ----
  if (path === "/api/traces" && method === "GET") return listTraces(ctx);
  const traceMatch = path.match(/^\/api\/traces\/([^/]+)$/);
  if (traceMatch && method === "GET") {
    ctx.params = { id: decodeURIComponent(traceMatch[1]!) };
    return getTrace(ctx);
  }

  // ---- test connection / claude smoke ----
  if (path === "/api/test-connection" && method === "POST") return testConnection(ctx);
  if (path === "/api/claude-code/smoke" && method === "POST") return claudeSmoke(ctx);

  // ---- provider presets / model capabilities / vision check ----
  if (path === "/api/provider-presets" && method === "GET") return listProviderPresets(ctx);
  if (path === "/api/model-capabilities" && method === "GET") return listModelCapabilities(ctx);
  if (path === "/api/vision-check" && method === "POST") return visionCheck(ctx);

  // ---- logs / router status ----
  if (path === "/api/logs/clear" && method === "POST") return clearLogs(ctx);
  if (path === "/api/router/status" && method === "GET") return routerStatus(ctx);

  return null;
}

async function serveProxy(
  request: Request,
  env: Env,
  singletons: Singletons,
): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  const isProxyPath =
    path.startsWith("/v1/") || path.startsWith("/openai/v1/");
  if (!isProxyPath) return null;

  const config = await loadConfig(env);
  const auth = await authenticate(request, config, env);
  if (!auth.ok) return authDenied(auth);
  if (!hasScope(auth, SCOPE_INVOKE)) return scopeDenied();

  const deps: PipelineDeps = {
    env,
    store: singletons.configStore,
    traces: singletons.traceStore,
    router: singletons.router,
    mode: config.runtime?.mode as string | undefined,
    fusionPlans: config.fusion_plans,
  };
  const reqCtx: RequestContext = { deps, request, path, method };

  // Anthropic-compatible
  if (path === "/v1/messages" && method === "POST") {
    const body = await parseBody(request);
    if (body instanceof Response) return body;
    return handleAnthropicMessages(reqCtx, body);
  }
  if (path === "/v1/messages/count_tokens" && method === "POST") {
    const body = await parseBody(request);
    if (body instanceof Response) return body;
    return handleCountTokens(reqCtx, body);
  }
  if (path === "/v1/models" && method === "GET") {
    return listAnthropicModels(singletons.configStore);
  }

  // OpenAI-compatible
  if ((path === "/openai/v1/chat/completions" || path === "/v1/chat/completions") && method === "POST") {
    const body = await parseBody(request);
    if (body instanceof Response) return body;
    return handleOpenAIChat(reqCtx, body);
  }
  if (path === "/openai/v1/responses" && method === "POST") {
    const body = await parseBody(request);
    if (body instanceof Response) return body;
    return handleOpenAIResponses(reqCtx, body);
  }
  if (path === "/openai/v1/models" && method === "GET") {
    return listOpenAIModels(singletons.configStore);
  }

  return null;
}

async function parseBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: { type: "invalid_request", message: "invalid json body" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureD1Schema(env.DB);
    const singletons = getSingletons(env);

    const api = await serveApi(request, env, singletons);
    if (api) return api;

    const proxy = await serveProxy(request, env, singletons);
    if (proxy) return proxy;

    // Dashboard SPA (Workers Static Assets).
    if (env.ASSETS) {
      try {
        return env.ASSETS.fetch(request);
      } catch {
        // fall through
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};
