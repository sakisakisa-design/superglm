import type { ProviderConfig } from "../types/config";
import { errorResponse } from "../utils/errors";
import { maskProvider, maskProviders } from "../utils/redact";
import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

export async function listProviders(ctx: RouteCtx): Promise<Response> {
  const providers = await ctx.configStore.listProviderProfiles();
  return jsonResponse(200, { providers: maskProviders(providers) });
}

export async function getProvider(ctx: RouteCtx): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  const provider = await ctx.configStore.getProviderProfile(id);
  if (!provider) return errorResponse(404, "not_found", `provider ${id} not found`);
  return jsonResponse(200, maskProvider(provider));
}

export async function putProvider(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;
  if (typeof body["id"] !== "string" || !body["id"]) {
    return errorResponse(400, "invalid_request", "provider id required");
  }
  const provider = body as unknown as ProviderConfig;
  const existing = await ctx.configStore.getProviderProfile(provider.id);
  if (existing?.api_key && isPreserveKeyValue(provider.api_key)) {
    provider.api_key = existing.api_key;
  }
  await ctx.configStore.upsertProviderProfile(provider);
  return jsonResponse(200, maskProvider(provider));
}

export async function deleteProvider(ctx: RouteCtx): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  await ctx.configStore.deleteProviderProfile(id);
  return jsonResponse(200, { deleted: id });
}

function isPreserveKeyValue(key: string | undefined): boolean {
  if (key == null) return true;
  const trimmed = key.trim();
  return trimmed === "" || trimmed === "****" || /^sk-\*{4}.{4}$/.test(trimmed);
}
