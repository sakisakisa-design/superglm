import { ConfigStore } from "../src/storage/configStore";
import { TraceStore } from "../src/storage/traceStore";

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result> {
    this.db.run(this.query, this.values);
    return okResult();
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.query, this.values);
  }

  async all<T>(): Promise<D1Result<T>> {
    return { ...okResult<T>(), results: this.db.all<T>(this.query) };
  }
}

class FakeD1 {
  providers: Record<string, Record<string, unknown>> = {};
  aliases: Record<string, Record<string, unknown>> = {};
  traces: Record<string, Record<string, unknown>> = {};

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query) as unknown as D1PreparedStatement;
  }

  run(query: string, values: unknown[]): void {
    if (query.includes("provider_profiles")) {
      const [id, name, base_url, api_key, protocol, default_model, models, enabled, timeout_ms] = values;
      this.providers[String(id)] = { id, name, base_url, api_key, protocol, default_model, models, enabled: enabled ?? 1, timeout_ms };
    } else if (query.includes("aliases")) {
      const [id, alias, target_model, provider_id, strategy, enabled] = values;
      this.aliases[String(alias)] = { id, alias, target_model, provider_id, strategy, enabled };
    } else if (query.includes("traces")) {
      const [request_id, alias, target_model, provider_id, method, path, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, error, request_json, response_json, steps_json] = values;
      this.traces[String(request_id)] = {
        request_id,
        alias,
        target_model,
        provider_id,
        method,
        path,
        status,
        latency_ms,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        error,
        request_json,
        response_json,
        steps_json,
        created_at: new Date(0).toISOString(),
      };
    }
  }

  first<T>(query: string, values: unknown[]): T | null {
    if (query.includes("provider_profiles")) return (this.providers[String(values[0])] as T) ?? null;
    if (query.includes("traces")) return (this.traces[String(values[0])] as T) ?? null;
    return null;
  }

  all<T>(query: string): T[] {
    if (query.includes("provider_profiles")) return Object.values(this.providers) as T[];
    if (query.includes("aliases")) return Object.values(this.aliases) as T[];
    if (query.includes("traces")) return Object.values(this.traces) as T[];
    return [];
  }
}

function okResult<T = unknown>(): D1Result<T> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
    results: [],
  };
}

describe("D1 stores", () => {
  it("upserts and lists provider profiles and aliases", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const store = new ConfigStore(db);

    await store.upsertProviderProfile({
      id: "sf",
      name: "SiliconFlow",
      protocol: "openai",
      base_url: "https://api.siliconflow.cn/v1",
      default_model: "zai-org/GLM-5.2",
    });
    await store.upsertAlias({
      id: "a1",
      alias: "glm",
      target_model: "zai-org/GLM-5.2",
      profile_id: "sf",
      provider_id: "sf",
      role: "main",
      strategy: "failover",
    });

    expect(await store.getProviderProfile("sf")).toMatchObject({
      id: "sf",
      name: "SiliconFlow",
      default_model: "zai-org/GLM-5.2",
    });
    expect(await store.listAliases()).toHaveLength(1);
  });

  it("persists provider enabled=false on insert and update", async () => {
    // Regression: enabled was hard-coded to 1 on insert and never updated, so a
    // provider disabled in the dashboard kept getting picked by the router.
    const db = new FakeD1() as unknown as D1Database;
    const store = new ConfigStore(db);

    await store.upsertProviderProfile({
      id: "sf",
      name: "SiliconFlow",
      protocol: "openai",
      base_url: "https://api.siliconflow.cn/v1",
      enabled: false,
    });
    expect((await store.getProviderProfile("sf"))?.enabled).toBe(false);

    // Re-enable via update.
    await store.upsertProviderProfile({
      id: "sf",
      name: "SiliconFlow",
      protocol: "openai",
      base_url: "https://api.siliconflow.cn/v1",
      enabled: true,
    });
    expect((await store.getProviderProfile("sf"))?.enabled).toBe(true);

    // Disable again via update.
    await store.upsertProviderProfile({
      id: "sf",
      name: "SiliconFlow",
      protocol: "openai",
      base_url: "https://api.siliconflow.cn/v1",
      enabled: false,
    });
    expect((await store.getProviderProfile("sf"))?.enabled).toBe(false);
  });

  it("redacts traces before storing", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const store = new TraceStore(db);
    await store.create({
      trace_id: "tr_1",
      started_at: 0,
      client_protocol: "gateway",
      incoming_model: "glm",
      upstream_model: "zai-org/GLM-5.2",
      status: "success",
      steps: [],
      request: { authorization: "Bearer test-secret-token" },
    });

    const trace = await store.get("tr_1");
    expect(trace?.request?.authorization).toBe("<redacted>");
  });
});
