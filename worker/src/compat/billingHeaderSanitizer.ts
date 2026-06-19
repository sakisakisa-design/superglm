export interface SanitizationReport {
  removedHeaders: string[];
  keptHeaders: string[];
  billingHeaderDetected: boolean;
}

const STRIP_EXACT = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "x-openai-organization",
  "x-openai-project",
  "x-openai-beta",
  "cf-access-client-id",
  "cf-access-client-secret",
  "x-anthropic-billing-header",
  "x-anthropic-billing-request",
  "x-anthropic-project",
  "x-project-id",
  "x-billing-project",
  "x-goog-user-project",
]);

const STRIP_PREFIXES = [
  "x-stainless-",
  "x-openai-",
  "x-billing-",
  "x-project-",
  "cf-access-",
];

const KEEP_EXACT = new Set([
  "accept",
  "accept-encoding",
  "anthropic-version",
  "content-type",
  "user-agent",
]);

function shouldStrip(name: string): boolean {
  const lower = name.toLowerCase();
  if (KEEP_EXACT.has(lower)) return false;
  if (STRIP_EXACT.has(lower)) return true;
  return STRIP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function sanitizeBillingHeaders(headers: Headers): {
  headers: Headers;
  report: SanitizationReport;
} {
  const sanitized = new Headers();
  const removedHeaders: string[] = [];
  const keptHeaders: string[] = [];

  for (const [name, value] of headers.entries()) {
    if (shouldStrip(name)) {
      removedHeaders.push(name.toLowerCase());
      continue;
    }
    sanitized.set(name, value);
    keptHeaders.push(name.toLowerCase());
  }

  return {
    headers: sanitized,
    report: {
      removedHeaders,
      keptHeaders,
      billingHeaderDetected: removedHeaders.length > 0,
    },
  };
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}
