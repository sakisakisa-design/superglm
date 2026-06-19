// In-memory D1 fake for API/integration tests. Supports the exact query shapes
// used by src/storage/configStore.ts, src/api/dashboard.ts, src/storage/traceStore.ts,
// and src/auth/auth.ts. Not a general SQL engine — pattern-matches on table + op.

type Row = Record<string, unknown>;

export interface MockD1Options {
  configValue?: string;
  providers?: Row[];
  aliases?: Row[];
  traces?: Row[];
  apiKeys?: Row[];
}

class MockStatement {
  private values: unknown[] = [];
  constructor(
    private readonly db: MockD1,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }
  async run(): Promise<D1Result> {
    this.db.apply(this.query, this.values);
    return { success: true, meta: emptyMeta(), results: [] };
  }
  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.query, this.values);
  }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, meta: emptyMeta(), results: this.db.all<T>(this.query, this.values) };
  }
}

export class MockD1 {
  configValue: string;
  providers: Map<string, Row> = new Map();
  aliases: Map<string, Row> = new Map();
  traces: Map<string, Row> = new Map();
  apiKeys: Row[] = [];

  constructor(opts: MockD1Options = {}) {
    this.configValue = opts.configValue ?? "";
    for (const p of opts.providers ?? []) this.providers.set(String(p.id), { ...p });
    for (const a of opts.aliases ?? []) this.aliases.set(String(a.alias), { ...a });
    for (const t of opts.traces ?? []) this.traces.set(String(t.request_id), { ...t });
    this.apiKeys = opts.apiKeys ?? [];
  }

  prepare(query: string): D1PreparedStatement {
    return new MockStatement(this, query) as unknown as D1PreparedStatement;
  }

  apply(query: string, values: unknown[]): void {
    const q = query.toLowerCase();
    if (q.startsWith("insert into config")) {
      this.configValue = String(values[0] ?? "");
    } else if (q.includes("insert into provider_profiles")) {
      const [id, name, base_url, api_key, protocol, default_model, models, enabled, timeout_ms] = values;
      const existing = this.providers.get(String(id));
      this.providers.set(String(id), {
        id, name, base_url, api_key, protocol, default_model, models,
        enabled: enabled ?? 1, timeout_ms,
        created_at: existing?.created_at ?? now(), updated_at: now(),
      });
    } else if (q.includes("insert into aliases")) {
      const [id, alias, target_model, provider_id, strategy, enabled] = values;
      this.aliases.set(String(alias), {
        id, alias, target_model, provider_id, strategy, enabled: enabled ?? 1,
        created_at: now(), updated_at: now(),
      });
    } else if (q.includes("insert into traces")) {
      const [request_id, alias, target_model, provider_id, method, path, status, latency_ms,
        prompt_tokens, completion_tokens, total_tokens, error, request_json, response_json, steps_json] = values;
      this.traces.set(String(request_id), {
        request_id, alias, target_model, provider_id, method, path, status, latency_ms,
        prompt_tokens, completion_tokens, total_tokens, error, request_json, response_json, steps_json,
        created_at: now(),
      });
    } else if (q.startsWith("delete from provider_profiles")) {
      this.providers.delete(String(values[0]));
    } else if (q.startsWith("delete from aliases")) {
      this.aliases.delete(String(values[0]));
    } else if (q.startsWith("delete from traces")) {
      this.traces.clear();
    } else if (q.startsWith("update api_keys")) {
      // no-op for the fake
    }
  }

  first<T>(query: string, values: unknown[]): T | null {
    const q = query.toLowerCase();
    if (q.includes("from config")) {
      return (this.configValue ? { value: this.configValue } : null) as T | null;
    }
    if (q.includes("from provider_profiles") && q.includes("where id")) {
      return (this.providers.get(String(values[0])) ?? null) as T | null;
    }
    if (q.includes("from traces") && q.includes("where request_id")) {
      return (this.traces.get(String(values[0])) ?? null) as T | null;
    }
    if (q.includes("from api_keys")) {
      const row = this.apiKeys.find((r) => String(r.key_hash) === String(values[0]) && r.enabled);
      return (row ?? null) as T | null;
    }
    return null;
  }

  all<T>(query: string, _values: unknown[]): T[] {
    const q = query.toLowerCase();
    if (q.includes("from provider_profiles")) {
      return [...this.providers.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) as T[];
    }
    if (q.includes("from aliases")) {
      return [...this.aliases.values()].sort((a, b) => String(a.alias).localeCompare(String(b.alias))) as T[];
    }
    if (q.includes("from traces")) {
      const all = [...this.traces.values()] as T[];
      const limit = Number(_values[0]);
      return Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;
    }
    return [];
  }
}

function now(): string {
  return new Date().toISOString();
}

function emptyMeta(): D1Result["meta"] {
  return {
    duration: 0, size_after: 0, rows_read: 0, rows_written: 0,
    last_row_id: 0, changed_db: false, changes: 0,
  };
}

/** Build an Env stub backed by a MockD1. */
export function mockEnv(opts: MockD1Options = {}): { DB: D1Database; ASSETS?: Fetcher; [k: string]: unknown } {
  return { DB: new MockD1(opts) as unknown as D1Database };
}
