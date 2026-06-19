import { jsonResponse, type RouteCtx } from "../router";

export async function clearLogs(ctx: RouteCtx): Promise<Response> {
  await ctx.traceStore.clear();
  return jsonResponse(200, { ok: true });
}
