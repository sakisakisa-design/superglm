// ID generation — mirrors backend uuid.uuid4().hex[:n] patterns.

const HEX = "0123456789abcdef";
const RADIX =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function randomHex(len: number): string {
  const out: string[] = [];
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out.push(HEX[bytes[i]! & 0x0f]!);
  return out.join("");
}

export function newTraceId(): string {
  return "tr_" + randomHex(10);
}

export function newMessageId(): string {
  return "msg_" + randomHex(16);
}

export function newShortMessageId(): string {
  return "msg_" + randomHex(12);
}

export function newResponseId(): string {
  return "resp_" + randomHex(16);
}

export function newFunctionCallId(): string {
  return "fc_" + randomHex(12);
}

export function newCallId(): string {
  return "call_" + randomHex(12);
}

export function newChatComplId(): string {
  return "chatcmpl-superds-" + Date.now();
}

export function newStepId(): string {
  return "st_" + randomHex(8);
}

export function newEvidenceId(): string {
  return "ev_" + randomHex(10);
}

export function newApiKeyId(): string {
  return "key_" + randomId(14);
}

export function randomId(len: number): string {
  const out: string[] = [];
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out.push(RADIX[bytes[i]! & 0x3f]!);
  return out.join("");
}

/** SHA-256 hex digest of a string (used for key hashing & image source hashing). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

/** Synchronous-ish short hash mirroring multimodal._hash_text (sha256[:16]). */
export async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}

export function bytesToHex(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    out.push(HEX[value >> 4]!, HEX[value & 0x0f]!);
  }
  return out.join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(
    atob(b64.replace(/-/g, "+").replace(/_/g, "/"))
      .split("")
      .map((c) => c.charCodeAt(0)),
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
