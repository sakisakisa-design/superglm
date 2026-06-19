import type { ProfileConfig } from "../types/config";
import { errorResponse } from "../utils/errors";
import { randomId } from "../utils/ids";
import { loadConfig, saveConfig } from "./dashboard";
import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

export async function listProfiles(ctx: RouteCtx): Promise<Response> {
  return jsonResponse(200, { profiles: ctx.config.profiles });
}

export async function createProfile(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;
  const id = typeof body["id"] === "string" && body["id"] ? body["id"] : `prof_${randomId(10)}`;
  const name = typeof body["name"] === "string" ? body["name"] : "profile";
  const profile = { ...body, id, name } as unknown as ProfileConfig;
  const config = await loadConfig(ctx.env);
  config.profiles = [...config.profiles.filter((p) => p.id !== id), profile];
  await saveConfig(ctx.env, config);
  return jsonResponse(201, profile);
}

export async function putProfile(ctx: RouteCtx): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;
  const profile = { ...body, id } as unknown as ProfileConfig;
  const config = await loadConfig(ctx.env);
  const idx = config.profiles.findIndex((p) => p.id === id);
  if (idx >= 0) {
    config.profiles[idx] = profile;
  } else {
    config.profiles.push(profile);
  }
  await saveConfig(ctx.env, config);
  return jsonResponse(idx >= 0 ? 200 : 201, profile);
}

export async function deleteProfile(ctx: RouteCtx): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  const config = await loadConfig(ctx.env);
  const before = config.profiles.length;
  config.profiles = config.profiles.filter((p) => p.id !== id);
  if (config.profiles.length === before) {
    return errorResponse(404, "not_found", `profile ${id} not found`);
  }
  await saveConfig(ctx.env, config);
  return jsonResponse(200, { deleted: id });
}
