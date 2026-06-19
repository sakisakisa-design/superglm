-- SuperDeepSeek Worker: initial schema
-- Database: D1 (SQLite)
-- Migration: 0001_init
--
-- This DDL is the data contract for the reviewed Phase 1 storage layer:
--   * config             -> src/api/dashboard.ts (loadConfig/saveConfig: full SuperDeepSeekConfig blob)
--   * provider_profiles  -> src/storage/configStore.ts (upstream OpenAI/Anthropic-compatible endpoints)
--   * aliases            -> src/storage/configStore.ts (public model name -> target model / provider / strategy)
--   * traces             -> src/storage/traceStore.ts  (per-request observability)
--   * api_keys           -> src/auth/auth.ts           (hashed client-facing gateway keys)
--
-- The local Python edition persists config/superds.json + data/traces.sqlite3 on disk.
-- The Worker edition persists the same logical data in D1, with no filesystem and no
-- Uvicorn/SQLite-file dependency. The full config document (providers/models/profiles/
-- model_aliases) lives in the config singleton; provider/alias CRUD is mirrored into
-- normalized tables for routing. Provider API keys live in provider_profiles.api_key
-- (AES-GCM helpers in src/storage/encryptedSecrets.ts are available for hardened mode).

-- Full SuperDeepSeek config document, stored as a single JSON row.
-- Mirrors config_store.ConfigStore (config/superds.json) and src/api/dashboard.ts.
CREATE TABLE IF NOT EXISTS config (
  id          TEXT    PRIMARY KEY DEFAULT 'singleton',
  value       TEXT    NOT NULL,                          -- JSON config document
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Upstream provider endpoints (DeepSeek / Qwen / OpenRouter / Kimi / Anthropic / ...).
CREATE TABLE IF NOT EXISTS provider_profiles (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  base_url     TEXT    NOT NULL,
  api_key      TEXT,
  protocol     TEXT    NOT NULL DEFAULT 'openai',          -- openai | anthropic
  models       TEXT    NOT NULL DEFAULT '[]',              -- JSON array of supported model ids
  enabled      INTEGER NOT NULL DEFAULT 1,
  timeout_ms   INTEGER NOT NULL DEFAULT 60000,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_provider_profiles_enabled
  ON provider_profiles(enabled);

-- Aliases: map a public model name (exposed to Claude Code / OpenAI SDK clients) to a
-- target upstream model, optionally pinned to a single provider, with a routing strategy.
CREATE TABLE IF NOT EXISTS aliases (
  id           TEXT    PRIMARY KEY,
  alias        TEXT    NOT NULL UNIQUE,                    -- public name exposed to clients
  target_model TEXT    NOT NULL,                           -- real upstream model id
  provider_id  TEXT,                                       -- optional pin to a single provider
  strategy     TEXT    NOT NULL DEFAULT 'round_robin',     -- round_robin | weighted | failover
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aliases_target_model
  ON aliases(target_model);
CREATE INDEX IF NOT EXISTS idx_aliases_enabled
  ON aliases(enabled);
CREATE INDEX IF NOT EXISTS idx_aliases_provider
  ON aliases(provider_id);

-- Per-request trace / observability records.
CREATE TABLE IF NOT EXISTS traces (
  request_id         TEXT    PRIMARY KEY,
  alias              TEXT,
  target_model       TEXT,
  provider_id        TEXT,
  method             TEXT    NOT NULL,
  path               TEXT    NOT NULL,
  status             INTEGER NOT NULL,                     -- HTTP-style status code
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  request_json       TEXT    NOT NULL DEFAULT '{}',
  response_json      TEXT    NOT NULL DEFAULT '{}',
  steps_json         TEXT    NOT NULL DEFAULT '[]',
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_created_at
  ON traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_alias
  ON traces(alias);
CREATE INDEX IF NOT EXISTS idx_traces_provider
  ON traces(provider_id);
CREATE INDEX IF NOT EXISTS idx_traces_target_model
  ON traces(target_model);
CREATE INDEX IF NOT EXISTS idx_traces_status
  ON traces(status);

-- Hashed client-facing gateway keys. The Worker authenticates Claude Code / OpenAI SDK
-- clients with these (Bearer / x-api-key). Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT    PRIMARY KEY,
  key_hash     TEXT    NOT NULL UNIQUE,                    -- hex sha-256(plaintext)
  label        TEXT,
  scopes       TEXT    NOT NULL DEFAULT '[]',              -- JSON array of allowed alias globs / '*'
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_enabled
  ON api_keys(enabled);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON api_keys(key_hash);
