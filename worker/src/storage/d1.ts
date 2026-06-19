export type D1Value = string | number | boolean | null | Uint8Array;

export interface QueryableD1 {
  prepare(query: string): D1PreparedStatement;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function firstRequired<T>(
  statement: D1PreparedStatement,
  message = "record_not_found",
): Promise<T> {
  const row = await statement.first<T>();
  if (!row) throw new Error(message);
  return row;
}
