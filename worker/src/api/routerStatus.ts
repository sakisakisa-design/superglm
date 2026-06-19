import { jsonResponse, type RouteCtx } from "../router";

export function routerStatus(_ctx: RouteCtx): Response {
  return jsonResponse(200, { circuit_breakers: {} });
}
