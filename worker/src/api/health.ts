import type { Env } from "../types/internal";
import { jsonResponse, type RouteCtx } from "../router";

export function healthHandler(env: Env): Response {
  return jsonResponse(200, {
    ok: true,
    service: "superglm-worker",
    time: new Date().toISOString(),
    db: env.DB != null,
  });
}

export async function healthWithConfig(ctx: RouteCtx): Promise<Response> {
  const aliases = await ctx.configStore.listAliases();
  const haikuAlias = aliases.some((a) => a.alias.includes("haiku"));
  return jsonResponse(200, {
    ok: true,
    service: "superglm-worker",
    time: new Date().toISOString(),
    mode: ctx.config.runtime?.mode ?? "observe",
    aliases: aliases.length,
    haiku_alias_enabled: haikuAlias,
  });
}
