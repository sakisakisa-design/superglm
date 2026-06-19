export type D1Value = string | number | boolean | null | Uint8Array;

export interface QueryableD1 {
  prepare(query: string): D1PreparedStatement;
}

let schemaReady: Promise<void> | null = null;

const INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS config (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    api_key TEXT,
    protocol TEXT NOT NULL DEFAULT 'openai',
    default_model TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    timeout_ms INTEGER NOT NULL DEFAULT 60000,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_provider_profiles_enabled ON provider_profiles(enabled)",
  "ALTER TABLE provider_profiles ADD COLUMN default_model TEXT",
  `CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE,
    target_model TEXT NOT NULL,
    provider_id TEXT,
    strategy TEXT NOT NULL DEFAULT 'round_robin',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_aliases_target_model ON aliases(target_model)",
  "CREATE INDEX IF NOT EXISTS idx_aliases_enabled ON aliases(enabled)",
  "CREATE INDEX IF NOT EXISTS idx_aliases_provider ON aliases(provider_id)",
  `CREATE TABLE IF NOT EXISTS traces (
    request_id TEXT PRIMARY KEY,
    alias TEXT,
    target_model TEXT,
    provider_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    request_json TEXT NOT NULL DEFAULT '{}',
    response_json TEXT NOT NULL DEFAULT '{}',
    steps_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_traces_alias ON traces(alias)",
  "CREATE INDEX IF NOT EXISTS idx_traces_provider ON traces(provider_id)",
  "CREATE INDEX IF NOT EXISTS idx_traces_target_model ON traces(target_model)",
  "CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status)",
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    scopes TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled)",
  "CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)",
];

export async function ensureD1Schema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of INIT_STATEMENTS) {
        try {
          await db.prepare(sql).run();
        } catch (err) {
          if (!isIgnorableSchemaError(err)) throw err;
        }
      }
    })();
  }
  await schemaReady;
}

export function __resetD1SchemaForTest(): void {
  schemaReady = null;
}

function isIgnorableSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate column name|already exists/i.test(message);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function firstRequired<T>(
  statement: D1PreparedStatement,
  message = "record_not_found",
): Promise<T> {
  const row = await statement.first<T>();
  if (!row) throw new Error(message);
  return row;
}
