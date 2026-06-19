import { jsonResponse, readJsonBody, type RouteCtx } from "../router";

export async function visionCheck(ctx: RouteCtx): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  if (body instanceof Response) return body;

  const modelId = (body.model_id as string) || (body.modelId as string) || "";
  if (!modelId) {
    return jsonResponse(200, {
      ok: false,
      model_id: "",
      vision_status: "unknown",
      status: "model_id_required",
    });
  }

  return jsonResponse(200, {
    ok: true,
    model_id: modelId,
    vision_status: "unknown",
    status: "not_checked",
  });
}
