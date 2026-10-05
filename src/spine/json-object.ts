/** Small JSON-shape helpers shared by the spine's event emitters and card renderer. */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a stored JSON column defensively — malformed text or a non-object value both yield `{}`. */
export function safeJsonObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Copy every top-level string, number or boolean key of `source` onto `target`, skipping
 * `fixed` keys. With `maxStringLength`, a longer string is skipped rather than copied.
 */
export function copyScalarKeys(
  source: unknown,
  target: Record<string, unknown>,
  fixed: ReadonlySet<string>,
  maxStringLength?: number,
): void {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (fixed.has(key)) continue;
    if (typeof value === 'string') {
      if (maxStringLength === undefined || value.length <= maxStringLength) target[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      target[key] = value;
    }
  }
}
