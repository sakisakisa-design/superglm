// Evidence packets + multimodal detection — mirrors backend/app/multimodal.py.
// Specialist workers return EvidencePacket objects (not prose); the pipeline injects
// a canonical evidence system message so the main model answers from traceable
// observations rather than pretending to see images directly.

import { newEvidenceId } from "../utils/ids";

export interface EvidencePacket {
  id: string;
  session_key: string;
  type: "vision_observation" | "ocr_result" | "document_parse" | "web_search" | "code_execution" | "verification" | "memory";
  source: string;
  source_hash: string;
  content: {
    summary: string;
    ocr_text: string;
    regions: unknown[];
    note: string;
  };
  confidence: number;
  uncertainties: string[];
  created_at: number;
}

export interface DetectedImage {
  message_index?: number;
  item_index?: number;
  block_index: number;
  source: Record<string, unknown>;
  hash: string;
  source_ref: string;
}

const IMAGE_REF_WORDS = ["刚才那张图", "上一张图", "这张图", "图里", "截图", "图片", "右下角", "左下角", "右上角", "左上角"];

/** Sync, non-crypto hash for image source dedup/display (mirrors multimodal._hash_text shape). */
function quickHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 16);
}

export function referencesPreviousImage(text: string): boolean {
  return IMAGE_REF_WORDS.some((word) => text.includes(word));
}

/** Detect image blocks across protocols. Mirrors multimodal.detect_images. */
export function detectImages(protocol: "anthropic" | "openai" | "openai_responses", body: Record<string, unknown>): DetectedImage[] {
  if (protocol === "anthropic") return detectAnthropicImages(body);
  if (protocol === "openai_responses") return detectResponsesImages(body);
  return detectOpenAIImages(body);
}

function detectAnthropicImages(body: Record<string, unknown>): DetectedImage[] {
  const images: DetectedImage[] = [];
  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  messages.forEach((msg, mi) => {
    const content = msg.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "image") {
        const source = ((block as Record<string, unknown>).source as Record<string, unknown>) ?? {};
        images.push({
          message_index: mi,
          block_index: bi,
          source,
          hash: quickHash(JSON.stringify(source)),
          source_ref: `messages[${mi}].content[${bi}]`,
        });
      }
    });
  });
  return images;
}

function detectOpenAIImages(body: Record<string, unknown>): DetectedImage[] {
  const images: DetectedImage[] = [];
  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  messages.forEach((msg, mi) => {
    const content = msg.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t === "image_url" || t === "input_image") {
          images.push({
            message_index: mi,
            block_index: bi,
            source: block as Record<string, unknown>,
            hash: quickHash(JSON.stringify(block)),
            source_ref: `messages[${mi}].content[${bi}]`,
          });
        }
      }
    });
  });
  return images;
}

function detectResponsesImages(body: Record<string, unknown>): DetectedImage[] {
  const images: DetectedImage[] = [];
  const items = (Array.isArray(body.input) ? body.input : []) as Array<Record<string, unknown>>;
  items.forEach((item, ii) => {
    const content = item.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t === "input_image" || t === "image_url") {
          images.push({
            item_index: ii,
            block_index: bi,
            source: block as Record<string, unknown>,
            hash: quickHash(JSON.stringify(block)),
            source_ref: `input[${ii}].content[${bi}]`,
          });
        }
      }
    });
  });
  return images;
}

export function makeEvidencePackets(
  images: DetectedImage[],
  sessionKey: string,
  note = "vision_worker_placeholder",
  observationText = "",
): EvidencePacket[] {
  return images.map((image) => {
    const summary =
      observationText.trim() ||
      "检测到图片输入；当前 MVP 使用视觉副手占位证据。接入 Qwen-VL/OCR 后这里会包含 OCR、布局、对象和区域坐标。";
    return {
      id: newEvidenceId(),
      session_key: sessionKey,
      type: "vision_observation",
      source: image.source_ref,
      source_hash: image.hash,
      content: { summary, ocr_text: observationText.trim(), regions: [], note },
      confidence: observationText.trim() ? 0.78 : 0.2,
      uncertainties: observationText.trim()
        ? []
        : ["尚未接入真实视觉/OCR worker，不能保证图片细节。"],
      created_at: Math.floor(Date.now() / 1000),
    };
  });
}

export function evidenceSystemMessage(
  packets: EvidencePacket[],
  historical: EvidencePacket[] = [],
): string {
  const parts: string[] = [];
  for (const ev of historical) {
    parts.push(`- 历史图片证据 ${ev.id}: ${ev.content.summary} OCR: ${ev.content.ocr_text}`);
  }
  for (const ev of packets) {
    parts.push(`- 当前图片证据 ${ev.id}: ${ev.content.summary} OCR: ${ev.content.ocr_text}`);
  }
  if (parts.length === 0) return "";
  return "视觉证据包（由 Super DeepSeek 视觉副手提供，回答必须只基于这些可追溯观察，不要假装直接看图）：\n" + parts.join("\n");
}

/** Inject an evidence system message right after the leading system message. */
export function injectEvidenceIntoChatPayload(
  payload: Record<string, unknown>,
  evidenceText: string,
): Record<string, unknown> {
  if (!evidenceText) return payload;
  const out: Record<string, unknown> = { ...payload };
  const messages = [...((out.messages as Array<Record<string, unknown>>) ?? [])];
  const insertAt = messages.length > 0 && messages[0]?.role === "system" ? 1 : 0;
  messages.splice(insertAt, 0, { role: "system", content: evidenceText });
  out.messages = messages;
  return out;
}

const IMAGE_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);

/**
 * Strip image blocks from an OpenAI chat payload's messages.
 *
 * Used after evidence injection: once images have been converted to a textual
 * evidence system message, the raw image blocks must be removed so a non-vision
 * panel model doesn't reject the request (or silently drop the image). A message
 * whose content becomes empty after stripping is replaced with a single text part
 * so the message structure stays valid (OpenAI requires content to be non-empty
 * when content is an array of parts for user/system messages).
 */
export function stripImageBlocksFromChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = (payload.messages as Array<Record<string, unknown>>) ?? [];
  let touched = false;
  const cleaned = messages.map((msg) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;
    const filtered = content.filter((block) => {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t && IMAGE_BLOCK_TYPES.has(t as string)) {
          touched = true;
          return false;
        }
      }
      return true;
    });
    if (filtered.length === content.length) return msg;
    if (filtered.length === 0) {
      return { ...msg, content: [{ type: "text", text: "[image removed]" }] };
    }
    return { ...msg, content: filtered };
  });
  if (!touched) return payload;
  return { ...payload, messages: cleaned };
}
