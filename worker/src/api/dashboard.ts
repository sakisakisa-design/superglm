import type { Env } from "../types/internal";
import type { ProviderConfig, SuperDeepSeekConfig } from "../types/config";
import type { StoredAlias } from "../storage/configStore";
import type { TraceRecord } from "../types/trace";
import { ConfigStore } from "../storage/configStore";
import { safeParse } from "../utils/json";
import { maskProvider, maskProviders } from "../utils/redact";
import { randomId } from "../utils/ids";
import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

const DEFAULT_CONFIG: SuperDeepSeekConfig = {
  providers: [],
  models: [],
  profiles: [],
  model_aliases: [],
};

/**
 * Load the SuperDeepSeek config document.
 *
 * Source of truth:
 *   - server / security / runtime / claude_code_compat / profiles / models  -> config blob (D1 `config`)
 *   - providers   -> normalized `provider_profiles` table (via ConfigStore)
 *   - model_aliases -> normalized `aliases` table (via ConfigStore)
 *
 * The blob's providers/model_aliases are ignored on read; the normalized tables win,
 * so routing and the dashboard never drift. `security.local_api_key` is hydrated from
 * the `SUPERDS_LOCAL_API_KEY` Worker secret when present (deployed bootstrap path).
 */
export async function loadConfig(env: Env): Promise<SuperDeepSeekConfig> {
  let config: SuperDeepSeekConfig = { ...DEFAULT_CONFIG };
  try {
    const row = await env.DB.prepare("SELECT value FROM config WHERE id = 'singleton'")
      .first<{ value: string }>();
    if (row?.value) config = safeParse<SuperDeepSeekConfig>(row.value, { ...DEFAULT_CONFIG });
  } catch {
    // fall through to env override / defaults
  }
  if ((!config.providers || config.providers.length === 0) && typeof env.CONFIG_JSON === "string" && env.CONFIG_JSON) {
    config = safeParse<SuperDeepSeekConfig>(env.CONFIG_JSON, { ...DEFAULT_CONFIG });
  }

  const store = new ConfigStore(env.DB);
  try {
    config.providers = await store.listProviderProfiles();
  } catch {
    config.providers = config.providers ?? [];
  }
  try {
    config.model_aliases = await store.listAliases();
  } catch {
    config.model_aliases = config.model_aliases ?? [];
  }

  // Hydrate the gateway key from the Worker secret (authoritative when set).
  const envKey = typeof env.SUPERDS_LOCAL_API_KEY === "string" ? env.SUPERDS_LOCAL_API_KEY : "";
  if (envKey) {
    config.security = { ...(config.security ?? {}), local_api_key: envKey };
  }
  return config;
}

/**
 * Persist the config document and sync providers/aliases into the normalized tables
 * so routing stays consistent with the dashboard view.
 */
export async function saveConfig(env: Env, config: SuperDeepSeekConfig): Promise<void> {
  const store = new ConfigStore(env.DB);
  const existingProviders = await safeListProviders(store);
  const existingById = new Map(existingProviders.map((p) => [p.id, p]));
  config.providers = config.providers.map((provider) => {
    const existing = existingById.get(provider.id);
    if (existing?.api_key && isPreserveKeyValue(provider.api_key)) {
      return { ...provider, api_key: existing.api_key };
    }
    return provider;
  });

  await env.DB.prepare(
    "INSERT INTO config (id, value, updated_at) VALUES ('singleton', ?, datetime('now')) " +
      "ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  )
    .bind(JSON.stringify(config))
    .run();

  // Sync providers: upsert all in the config, delete normalized rows no longer present.
  const keepProviderIds = new Set(config.providers.map((p) => p.id));
  for (const provider of config.providers) {
    await store.upsertProviderProfile(provider);
  }
  try {
    const existing = await store.listProviderProfiles();
    for (const p of existing) {
      if (!keepProviderIds.has(p.id)) await store.deleteProviderProfile(p.id);
    }
  } catch {
    // ignore
  }

  // Sync aliases: upsert aliases that carry a target_model (Worker shape); leave
  // table-managed aliases otherwise untouched to avoid wiping /api/aliases CRUD.
  for (const alias of config.model_aliases ?? []) {
    const ext = alias as Record<string, unknown>;
    const target = ext.target_model;
    if (typeof target !== "string" || !target) continue;
    const strategyRaw = ext.strategy;
    const stored: StoredAlias = {
      id: typeof ext.id === "string" ? ext.id : randomId(12),
      alias: alias.alias,
      target_model: target,
      profile_id: alias.profile_id ?? "",
      role: alias.role ?? "main",
      strategy: typeof strategyRaw === "string" ? strategyRaw : "round_robin",
      enabled: alias.enabled !== false,
    };
    if (typeof ext.provider_id === "string") stored.provider_id = ext.provider_id;
    await store.upsertAlias(stored);
  }
}

async function safeListProviders(store: ConfigStore): Promise<ProviderConfig[]> {
  try {
    return await store.listProviderProfiles();
  } catch {
    return [];
  }
}

function isPreserveKeyValue(key: string | undefined): boolean {
  if (key == null) return true;
  const trimmed = key.trim();
  return trimmed === "" || trimmed === "****" || /^sk-\*{4}.{4}$/.test(trimmed);
}

export function publicConfig(config: SuperDeepSeekConfig): SuperDeepSeekConfig {
  const providers = (config.providers ?? []).map((p): ProviderConfig => maskProvider(p));
  const out: SuperDeepSeekConfig = { ...config, providers };
  // Never surface the gateway key in config responses.
  if (out.security?.local_api_key) {
    out.security = { ...out.security, local_api_key: "<redacted>" };
  }
  return out;
}

export async function getOverview(ctx: RouteCtx): Promise<Response> {
  let providers: ProviderConfig[] = [];
  let aliases: StoredAlias[] = [];
  let recentTraces: TraceRecord[] = [];
  try {
    providers = await ctx.configStore.listProviderProfiles();
  } catch {
    // store unavailable — return empty
  }
  try {
    aliases = await ctx.configStore.listAliases();
  } catch {
    // store unavailable — return empty
  }
  try {
    recentTraces = await ctx.traceStore.list(20);
  } catch {
    // store unavailable — return empty
  }
  return jsonResponse(200, {
    config: publicConfig(ctx.config),
    providers: maskProviders(providers),
    aliases,
    recent_traces: recentTraces,
    stats: {
      providers: providers.length,
      aliases: aliases.length,
      traces: recentTraces.length,
    },
  });
}

export async function getConfigHandler(ctx: RouteCtx): Promise<Response> {
  return jsonResponse(200, publicConfig(ctx.config));
}

export async function putConfigHandler(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;
  const config = body as unknown as SuperDeepSeekConfig;
  await saveConfig(ctx.env, config);
  // Re-read so the response reflects the normalized-table source of truth.
  const fresh = await loadConfig(ctx.env);
  return jsonResponse(200, publicConfig(fresh));
}
