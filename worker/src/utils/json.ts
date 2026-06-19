// JSON helpers — safe parse/stringify with non-ASCII preserved.

export function safeParse<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value);
}

/** Stringify preserving non-ASCII characters (ensure_ascii=False equivalent). */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
