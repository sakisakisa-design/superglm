import type { ModelRole } from "../types/config";
import type { StoredAlias } from "../storage/configStore";
import { errorResponse } from "../utils/errors";
import { randomId } from "../utils/ids";
import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

export async function listAliases(ctx: RouteCtx): Promise<Response> {
  const aliases = await ctx.configStore.listAliases();
  return jsonResponse(200, { aliases });
}

export async function putAlias(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;
  const alias = typeof body["alias"] === "string" ? body["alias"] : "";
  const targetModel = typeof body["target_model"] === "string" ? body["target_model"] : "";
  if (!alias || !targetModel) {
    return errorResponse(400, "invalid_request", "alias and target_model required");
  }
  const stored: StoredAlias = {
    id: typeof body["id"] === "string" ? body["id"] : randomId(12),
    alias,
    target_model: targetModel,
    profile_id: typeof body["profile_id"] === "string" ? body["profile_id"] : "",
    role: typeof body["role"] === "string" ? (body["role"] as ModelRole) : "main",
    strategy: typeof body["strategy"] === "string" ? body["strategy"] : "round_robin",
  };
  if (typeof body["provider_id"] === "string") stored.provider_id = body["provider_id"];
  if (body["enabled"] === false) stored.enabled = false;
  await ctx.configStore.upsertAlias(stored);
  return jsonResponse(200, stored);
}

export async function deleteAlias(ctx: RouteCtx): Promise<Response> {
  const alias = ctx.params["alias"] ?? "";
  await ctx.configStore.deleteAlias(decodeURIComponent(alias));
  return jsonResponse(200, { deleted: alias });
}
