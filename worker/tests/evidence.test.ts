import { describe, expect, it } from "vitest";
import {
  detectImages,
  makeEvidencePackets,
  evidenceSystemMessage,
  injectEvidenceIntoChatPayload,
  stripImageBlocksFromChatPayload,
} from "../src/runtime/evidence";

describe("detectImages", () => {
  it("detects image blocks in an Anthropic message body", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看这张图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
          ],
        },
      ],
    };
    const imgs = detectImages("anthropic", body);
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.source_ref).toContain("messages[0].content[1]");
    expect(imgs[0]!.hash).toBeTruthy();
  });

  it("detects image_url / input_image blocks in an OpenAI chat body", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://x/a.png" } },
            { type: "input_image", image_url: "data:image/png;base64,iVBOR" },
          ],
        },
      ],
    };
    const imgs = detectImages("openai", body);
    expect(imgs.length).toBe(2);
  });

  it("detects input_image items in an OpenAI Responses body (input array)", () => {
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "q" }, { type: "input_image", image_url: "https://x/a.png" }],
        },
      ],
    };
    const imgs = detectImages("openai_responses", body);
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.item_index).toBe(0);
  });

  it("returns [] when there are no image blocks", () => {
    expect(detectImages("anthropic", { messages: [{ role: "user", content: "hi" }] })).toEqual([]);
    expect(detectImages("openai", { messages: [{ role: "user", content: "hi" }] })).toEqual([]);
    expect(detectImages("openai_responses", { input: [{ role: "user", content: "hi" }] })).toEqual([]);
  });
});

describe("evidence injection chain", () => {
  it("builds an evidence system message and injects it right after a leading system message", () => {
    const images = detectImages("anthropic", {
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }] },
      ],
    });
    const packets = makeEvidencePackets(images, "sess");
    const evidenceText = evidenceSystemMessage(packets);
    expect(evidenceText).toContain("视觉证据包");
    expect(evidenceText).toContain(packets[0]!.id);

    const payload = injectEvidenceIntoChatPayload(
      { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] },
      evidenceText,
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    // Evidence injected at index 1 (after the leading system message).
    expect(messages[1]!.role).toBe("system");
    expect(String(messages[1]!.content)).toContain("视觉证据包");
    expect(messages[0]!.content).toBe("sys");
    expect(messages[2]!.content).toBe("hi");
  });

  it("injects at index 0 when there is no leading system message", () => {
    const images = detectImages("openai", {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }],
    });
    const evidenceText = evidenceSystemMessage(makeEvidencePackets(images, "s"));
    const payload = injectEvidenceIntoChatPayload({ messages: [{ role: "user", content: "hi" }] }, evidenceText);
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.content).toBe("hi");
  });

  it("returns the payload unchanged when evidenceText is empty (no images)", () => {
    const payload = { messages: [{ role: "user", content: "hi" }] };
    expect(injectEvidenceIntoChatPayload(payload, "")).toBe(payload);
  });
});

describe("stripImageBlocksFromChatPayload", () => {
  it("removes image_url / input_image / image blocks, keeps text parts", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "https://x/a.png" } },
            { type: "input_image", image_url: "data:..." },
          ],
        },
      ],
    };
    const out = stripImageBlocksFromChatPayload(payload);
    const content = (out.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toBe("look at this");
  });

  it("replaces a message whose content becomes empty with a text placeholder", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] },
      ],
    };
    const out = stripImageBlocksFromChatPayload(payload);
    const content = (out.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(1);
    expect(content[0]!.type).toBe("text");
    expect(String(content[0]!.text)).toMatch(/image removed/);
  });

  it("returns the payload unchanged when there are no image blocks", () => {
    const payload = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    expect(stripImageBlocksFromChatPayload(payload)).toBe(payload);
  });

  it("leaves string-content messages untouched (no array to filter)", () => {
    const payload = { messages: [{ role: "user", content: "just text" }] };
    expect(stripImageBlocksFromChatPayload(payload)).toBe(payload);
  });
});
