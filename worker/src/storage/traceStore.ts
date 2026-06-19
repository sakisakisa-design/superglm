import type { TraceRecord } from "../types/trace";
import { redact } from "../utils/redact";
import { parseJsonColumn } from "./d1";

interface TraceRow {
  request_id: string;
  method: string;
  path: string;
  alias?: string | null;
  target_model?: string | null;
  provider_id?: string | number | null;
  status: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  error?: string | null;
  request_json?: string | null;
  response_json?: string | null;
  steps_json?: string | null;
  created_at: string;
}

export class TraceStore {
  constructor(private readonly db: D1Database) {}

  async create(record: TraceRecord & { method?: string; path?: string }): Promise<void> {
    const safe = redact(record);
    await this.db
      .prepare(
        `INSERT INTO traces
          (request_id, alias, target_model, provider_id, method, path, status, latency_ms,
           prompt_tokens, completion_tokens, total_tokens, error, request_json, response_json, steps_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        safe.trace_id,
        safe.incoming_model ?? null,
        safe.upstream_model ?? null,
        safe.upstream_provider_id ?? null,
        safe.method ?? "POST",
        safe.path ?? "/",
        safe.status === "success" ? 200 : 500,
        safe.latency_ms ?? 0,
        safe.usage?.inputTokens ?? 0,
        safe.usage?.outputTokens ?? 0,
        safe.usage?.totalTokens ?? 0,
        safe.status === "error" ? JSON.stringify(safe.response ?? safe.request ?? {}) : null,
        JSON.stringify(safe.request ?? {}),
        JSON.stringify(safe.response ?? {}),
        JSON.stringify(safe.steps ?? []),
      )
      .run();
  }

  async get(traceId: string): Promise<TraceRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM traces WHERE request_id = ?")
      .bind(traceId)
      .first<TraceRow>();
    return row ? rowToTrace(row) : null;
  }

  async list(limit = 50): Promise<TraceRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM traces ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<TraceRow>();
    return (result.results ?? []).map(rowToTrace);
  }

  async clear(): Promise<void> {
    await this.db.prepare("DELETE FROM traces").run();
  }
}

function rowToTrace(row: TraceRow): TraceRecord {
  const trace: TraceRecord = {
    trace_id: row.request_id,
    started_at: Date.parse(row.created_at) || 0,
    client_protocol: "gateway",
    status: row.status >= 200 && row.status < 400 ? "success" : "error",
    latency_ms: row.latency_ms,
    usage: {
      inputTokens: row.prompt_tokens,
      outputTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
    },
    steps: parseJsonColumn(row.steps_json, []),
    request: parseJsonColumn(row.request_json, {}),
    response: parseJsonColumn(row.response_json, {}),
  };
  if (row.alias) trace.incoming_model = row.alias;
  if (row.provider_id != null) trace.upstream_provider_id = String(row.provider_id);
  if (row.target_model) trace.upstream_model = row.target_model;
  return trace;
}
