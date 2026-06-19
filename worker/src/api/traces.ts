import { errorResponse } from "../utils/errors";
import { jsonResponse, type RouteCtx } from "../router";

function parseLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

export async function listTraces(ctx: RouteCtx): Promise<Response> {
  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  const traces = await ctx.traceStore.list(limit);
  return jsonResponse(200, { traces });
}

export async function getTrace(ctx: RouteCtx): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  const trace = await ctx.traceStore.get(id);
  if (!trace) return errorResponse(404, "not_found", `trace ${id} not found`);
  return jsonResponse(200, trace);
}
