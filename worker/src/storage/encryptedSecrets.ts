import { bytesToBase64, base64ToBytes } from "../utils/ids";

async function importKey(raw: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(raw.padEnd(32, "0").slice(0, 32));
  return crypto.subtle.importKey("raw", toArrayBuffer(material), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string, keyMaterial: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyMaterial);
  const data = new TextEncoder().encode(secret);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(data)),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

export async function decryptSecret(payload: string, keyMaterial: string): Promise<string> {
  const [ivText, dataText] = payload.split(".");
  if (!ivText || !dataText) throw new Error("invalid_secret_payload");
  const key = await importKey(keyMaterial);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(ivText)) },
    key,
    toArrayBuffer(base64ToBytes(dataText)),
  );
  return new TextDecoder().decode(decrypted);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
