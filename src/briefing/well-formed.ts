/**
 * Replace every lone UTF-16 surrogate with U+FFFD, the same result as
 * `String.prototype.toWellFormed()` (ES2024, not in this repo's ES2022 lib).
 * The Anthropic API answers 400 for an ill-formed string, so a cut that ends
 * inside an emoji must never reach `messages.create`.
 */
export function toWellFormedText(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}
