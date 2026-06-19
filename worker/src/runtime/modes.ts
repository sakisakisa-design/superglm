// Runtime modes — mirrors backend/app runtime.mode (passthrough/observe/augment/strict).
// The Worker edition ships in observe mode: forward + trace + sanitize, no specialist
// augmentation beyond optional vision evidence.

export type RuntimeMode = "passthrough" | "observe" | "augment" | "strict";

export const DEFAULT_MODE: RuntimeMode = "observe";

export function effectiveMode(mode?: string): RuntimeMode {
  if (mode === "passthrough" || mode === "observe" || mode === "augment" || mode === "strict") {
    return mode;
  }
  return DEFAULT_MODE;
}

/** Whether the pipeline should capture full request/response bodies in traces. */
export function shouldCaptureBodies(mode: RuntimeMode): boolean {
  return mode !== "passthrough";
}
