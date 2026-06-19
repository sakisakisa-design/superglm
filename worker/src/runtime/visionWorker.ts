// Vision worker — mirrors backend/app/main.run_vision_worker.
// In the Worker edition, if images are detected and no vision-capable provider is
// configured, the pipeline converts them into placeholder evidence packets. When a
// dedicated vision provider exists (a provider whose capabilities.models includes a
// vision model, pinned via alias target), it is called to produce an observation.

import type { ProviderConfig } from "../types/config";
import { callOpenAIChat } from "../upstream/providerClient";

const VISION_CHECK_IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export interface VisionWorkerResult {
  observationText: string;
  provider?: ProviderConfig;
  model?: string;
  note: string;
}

/** Call a vision-capable provider with a minimal probe prompt. */
export async function runVisionWorker(
  _payload: Record<string, unknown>,
  provider: ProviderConfig,
  model: string,
): Promise<VisionWorkerResult> {
  const visionPayload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "请只回复 VISION_OK。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${VISION_CHECK_IMAGE_B64}` } },
        ],
      },
    ],
    stream: false,
    max_tokens: 8,
    temperature: 0,
  };
  try {
    const resp = await callOpenAIChat(visionPayload, provider);
    const choices = (resp.choices as Array<Record<string, unknown>>) ?? [];
    const text = String(((choices[0]?.message as Record<string, unknown>)?.content as string) ?? "");
    return { observationText: text, provider, model, note: `vision_worker:${provider.id}/${model}` };
  } catch (err) {
    return {
      observationText: "",
      provider,
      model,
      note: `vision_worker_error:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
