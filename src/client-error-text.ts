// SPDX-License-Identifier: Apache-2.0
// Shared by the browser reporter and the Convex insert so neither side alone decides what is safe to keep.

export const clientErrorLimits = {
  message: 500,
  stack: 4000,
  route: 300,
  build: 64,
  functionName: 120,
  code: 64,
} as const;

export const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

/** Keep only the path of a URL or path: no origin, credentials, query string or fragment. */
export function scrubRoute(value: string): string {
  let path: string;
  try {
    path = new URL(value, 'http://forge.invalid/').pathname;
  } catch {
    path = value.split(/[?#]/, 1)[0] ?? '';
  }
  return clip(path || '/', clientErrorLimits.route);
}

const secretPatterns: [RegExp, string][] = [
  // Query strings and fragments of any URL, including blob/file URLs in stacks.
  [/\b((?:https?|wss?|blob|file):\/\/?[^\s?#'"()<>]*)[?#][^\s'"()<>]*/gi, '$1'],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/g, '[redacted]'],
  [/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]'],
  [/\b(?:fga|sk|rk)_[\w-]{8,}/g, '[redacted]'],
  [
    /\b((?:access[_-]?|refresh[_-]?|id[_-]?)?token|secret|password|passwd|api[_-]?key|authorization|credential)(s?["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
    '$1$2[redacted]',
  ],
];

/** Strip URL queries and token-shaped values from free text, then clip it. */
export function scrubText(value: string, max: number): string {
  let text = value;
  for (const [pattern, replacement] of secretPatterns) text = text.replace(pattern, replacement);
  return clip(text, max);
}
