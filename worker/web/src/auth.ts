// Dashboard admin-key storage + auth helpers.
//
// The gateway key is kept client-side only for the lifetime of the dashboard
// session. By default it lives in sessionStorage (cleared when the tab closes);
// with an explicit "remember" toggle it is stored in localStorage. It is never
// sent anywhere except as an Authorization header to the same-origin /api/* and
// proxy endpoints.

const SS_KEY = "superds_admin_key";
const LS_KEY = "superds_admin_key_remember";

/** Thrown when a protected /api/* call returns 401, so the UI can lock the dashboard. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function storageFor(remember: boolean): Storage | null {
  try {
    return remember ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether a key is currently stored (session or local). */
export function hasKey(): boolean {
  return Boolean(getKey());
}

/** Read the stored key, preferring sessionStorage (the active session). */
export function getKey(): string {
  try {
    const ss = window.sessionStorage.getItem(SS_KEY);
    if (ss) return ss;
    if (window.localStorage.getItem(LS_KEY) === "1") {
      const ls = window.localStorage.getItem(SS_KEY);
      if (ls) return ls;
    }
  } catch {
    // storage unavailable (private mode) — no key
  }
  return "";
}

/** Store the key. `remember` persists across sessions via localStorage. */
export function setKey(key: string, remember: boolean): void {
  const cleaned = key.trim();
  if (!cleaned) return;
  const storage = storageFor(remember);
  if (!storage) return;
  try {
    storage.setItem(SS_KEY, cleaned);
    if (remember) {
      window.localStorage.setItem(LS_KEY, "1");
    } else {
      window.localStorage.removeItem(LS_KEY);
    }
  } catch {
    // ignore
  }
  emit();
}

/** Forget the key from both stores and notify listeners (returns to locked state). */
export function forgetKey(): void {
  try {
    window.sessionStorage.removeItem(SS_KEY);
    window.localStorage.removeItem(SS_KEY);
    window.localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
  emit();
}

/**
 * Build the Authorization header for a protected request. Returns an empty record
 * when no key is stored (the call will then 401 and the UI locks). Exported for
 * unit testing.
 */
export function authHeaders(): Record<string, string> {
  const key = getKey();
  return key ? { authorization: `Bearer ${key}` } : {};
}
