// Key hashing — SHA-256 hex digest of client API keys, stored in the api_keys
// table. Plaintext is never persisted.

import { sha256Hex } from "../utils/ids";

export async function hashKey(plaintext: string): Promise<string> {
  return sha256Hex(plaintext);
}

/** Constant-time string compare to avoid timing oracle on key checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // still hash both lengths to keep timing roughly constant
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
