export interface AliasRule {
  readonly alias: string;
  readonly target: string;
}

const WILDCARD = "*";

function isWildcardPattern(pattern: string): boolean {
  return pattern.includes(WILDCARD);
}

function matchWildcard(pattern: string, model: string): string | null {
  const idx = pattern.indexOf(WILDCARD);
  const prefix = pattern.slice(0, idx);
  const suffix = pattern.slice(idx + 1);
  const minLength = prefix.length + suffix.length;
  if (
    model.length >= minLength &&
    model.startsWith(prefix) &&
    model.endsWith(suffix)
  ) {
    return model.slice(prefix.length, model.length - suffix.length);
  }
  return null;
}

function applyTarget(target: string, captured: string): string {
  if (!target.includes(WILDCARD)) return target;
  return target.replace(WILDCARD, () => captured);
}

export function resolveAlias(
  model: string,
  rules: readonly AliasRule[],
): string {
  for (const rule of rules) {
    if (!isWildcardPattern(rule.alias) && rule.alias === model) {
      return rule.target;
    }
  }

  for (const rule of rules) {
    if (!isWildcardPattern(rule.alias)) continue;
    const captured = matchWildcard(rule.alias, model);
    if (captured !== null) {
      return applyTarget(rule.target, captured);
    }
  }

  return model;
}
