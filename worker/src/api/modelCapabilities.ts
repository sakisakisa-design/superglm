import { jsonResponse, type RouteCtx } from "../router";

const DEFAULT_CAPS = {
  api_format: "openai_chat",
  vision: null,
  vision_status: "unknown",
  tools: true,
  reasoning_state: "none",
  preserve_opaque_reasoning: false,
};

function normalizeCaps(caps: Record<string, unknown>): Record<string, unknown> {
  const out = { ...caps };
  const status = out.vision_status as string | undefined;
  if (status === "verified_supported" || out.vision === true) {
    out.vision = true;
    out.vision_status = "verified_supported";
  } else if (status === "verified_unsupported") {
    out.vision = false;
    out.vision_status = "verified_unsupported";
  } else {
    out.vision = null;
    out.vision_status = "unknown";
  }
  return out;
}

export function listModelCapabilities(ctx: RouteCtx): Response {
  const models = (ctx.config.models ?? []) as Array<Record<string, unknown>>;
  const data = models.map((model) => {
    const caps = { ...DEFAULT_CAPS, ...((model.capabilities as Record<string, unknown>) ?? {}) };
    return {
      id: model.id,
      provider_id: model.provider_id,
      actual_model: model.actual_model,
      role: model.role,
      capabilities: normalizeCaps(caps),
    };
  });
  return jsonResponse(200, { data });
}
