import type { ModelAlias, ProviderConfig } from "../types/config";
import { parseJsonColumn } from "./d1";
import { encryptSecret, decryptSecret } from "./encryptedSecrets";

const ENC_PREFIX = "enc:";

interface ProviderProfileRow {
  id: string | number;
  name: string;
  base_url: string;
  api_key?: string | null;
  protocol?: string | null;
  default_model?: string | null;
  models?: string | null;
  enabled: number;
  timeout_ms?: number | null;
  created_at?: string;
  updated_at?: string;
}

interface AliasRow {
  id: string | number;
  alias: string;
  target_model: string;
  provider_id?: string | number | null;
  strategy?: string | null;
  enabled: number;
  created_at?: string;
  updated_at?: string;
}

export interface StoredAlias extends ModelAlias {
  id: string;
  target_model: string;
  provider_id?: string | null;
  strategy: string;
}

export class ConfigStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey?: string,
  ) {}

  async listProviderProfiles(): Promise<ProviderConfig[]> {
    const result = await this.db
      .prepare("SELECT * FROM provider_profiles ORDER BY name ASC")
      .all<ProviderProfileRow>();
    const rows = result.results ?? [];
    const out: ProviderConfig[] = [];
    for (const row of rows) out.push(await providerFromRow(row, this.encryptionKey));
    return out;
  }

  async getProviderProfile(id: string): Promise<ProviderConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM provider_profiles WHERE id = ?")
      .bind(id)
      .first<ProviderProfileRow>();
    return row ? providerFromRow(row, this.encryptionKey) : null;
  }

  async upsertProviderProfile(profile: ProviderConfig): Promise<void> {
    let apiKey = profile.api_key ?? null;
    if (apiKey && this.encryptionKey) {
      apiKey = ENC_PREFIX + (await encryptSecret(apiKey, this.encryptionKey));
    }
    await this.db
      .prepare(
        `INSERT INTO provider_profiles
          (id, name, base_url, api_key, protocol, default_model, models, enabled, timeout_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          base_url = excluded.base_url,
          api_key = excluded.api_key,
          protocol = excluded.protocol,
          default_model = excluded.default_model,
          models = excluded.models,
          enabled = excluded.enabled,
          timeout_ms = excluded.timeout_ms,
          updated_at = datetime('now')`,
      )
      .bind(
        profile.id,
        profile.name,
        profile.base_url,
        apiKey,
        profile.protocol,
        profile.default_model ?? null,
        JSON.stringify(profile.capabilities?.models ?? []),
        profile.enabled === false ? 0 : 1,
        profile.degraded_threshold_ms ?? 60000,
      )
      .run();
  }

  async deleteProviderProfile(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM provider_profiles WHERE id = ?").bind(id).run();
  }

  async listAliases(): Promise<StoredAlias[]> {
    const result = await this.db
      .prepare("SELECT * FROM aliases ORDER BY alias ASC")
      .all<AliasRow>();
    return (result.results ?? []).map(aliasFromRow);
  }

  async upsertAlias(alias: StoredAlias): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO aliases
          (id, alias, target_model, provider_id, strategy, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(alias) DO UPDATE SET
          target_model = excluded.target_model,
          provider_id = excluded.provider_id,
          strategy = excluded.strategy,
          enabled = excluded.enabled,
          updated_at = datetime('now')`,
      )
      .bind(
        alias.id,
        alias.alias,
        alias.target_model,
        alias.provider_id ?? null,
        alias.strategy,
        alias.enabled === false ? 0 : 1,
      )
      .run();
  }

  async deleteAlias(alias: string): Promise<void> {
    await this.db.prepare("DELETE FROM aliases WHERE alias = ?").bind(alias).run();
  }
}

async function providerFromRow(row: ProviderProfileRow, encryptionKey?: string): Promise<ProviderConfig> {
  const models = parseJsonColumn<string[]>(row.models, []);
  const provider: ProviderConfig = {
    id: String(row.id),
    name: row.name,
    protocol: row.protocol === "anthropic" ? "anthropic" : "openai",
    base_url: row.base_url,
    capabilities: { models },
    enabled: Boolean(row.enabled),
  };
  (provider as Record<string, unknown>)["models"] = models;
  if (row.api_key) {
    provider.api_key = await decryptApiKey(row.api_key, encryptionKey);
  }
  if (row.default_model) provider.default_model = row.default_model;
  if (row.timeout_ms != null) provider.degraded_threshold_ms = row.timeout_ms;
  return provider;
}

async function decryptApiKey(stored: string, encryptionKey?: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  if (!encryptionKey) return stored;
  try {
    return await decryptSecret(stored.slice(ENC_PREFIX.length), encryptionKey);
  } catch {
    return stored;
  }
}

function aliasFromRow(row: AliasRow): StoredAlias {
  return {
    id: String(row.id),
    alias: row.alias,
    target_model: row.target_model,
    profile_id: row.provider_id == null ? "" : String(row.provider_id),
    provider_id: row.provider_id == null ? null : String(row.provider_id),
    role: "main",
    strategy: row.strategy ?? "round_robin",
    enabled: Boolean(row.enabled),
  };
}
