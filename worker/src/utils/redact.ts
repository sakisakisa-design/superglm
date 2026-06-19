// Secret redaction — mirrors backend/app/secret_redaction.py exactly.
// Used before any request/response/trace is persisted or returned to the dashboard.

const SECRET_PATTERNS: { re: RegExp; group?: number }[] = [
  { re: /^(\s*x-anthropic-billing-header\s*:\s*).*$/gim, group: 1 },
  { re: /\bcch\s*=\s*[^;\s,\n]+/gi },
  { re: /sk-[A-Za-z0-9_\-]{8,}/g },
  { re: /Bearer\s+[A-Za-z0-9_\-.=]{8,}/gi },
  { re: /(api[_-]?key\s*[:=]\s*)[A-Za-z0-9_\-.]{8,}/gi, group: 1 },
];

const REDACTED_KEYS = new Set([
  "authorization",
  "api_key",
  "x-api-key",
  "cookie",
  "x-anthropic-billing-header",
  "x-anthropic-billing-request",
]);

export function redactText(text: string): string {
  let out = text;
  for (const { re, group } of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      if (group) {
        const captured = args[group - 1] as string | undefined;
        return (captured ?? "") + "<redacted>";
      }
      return "<redacted>";
    });
  }
  return out;
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? "<redacted>" : redact(v);
    }
    return out as T;
  }
  return value;
}

/** Mask an API key for dashboard display: keep last 4 chars. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return "sk-****" + key.slice(-4);
}

/**
 * Return a provider copy with its `api_key` masked for dashboard display.
 * Never expose plaintext upstream keys over the management API.
 */
export function maskProvider<T extends { api_key?: string }>(provider: T): T {
  if (!provider.api_key) return provider;
  return { ...provider, api_key: maskKey(provider.api_key) };
}

/** Mask api_key across a list of providers. */
export function maskProviders<T extends { api_key?: string }>(providers: T[]): T[] {
  return providers.map(maskProvider);
}
