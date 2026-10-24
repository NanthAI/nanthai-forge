// SPDX-License-Identifier: Apache-2.0
/** A short derived label never silently cuts the last word. The full outcome stays on the Intent. */
export function derivedLaneName(outcome: string): string {
  const text = outcome.trim();
  if (text.length <= 120) return text;
  const prefix = text.slice(0, 119).replace(/[\uD800-\uDBFF]$/u, '');
  return `${prefix.replace(/\s+\S*$/u, '').trimEnd()}…`;
}
/** Restore the full outcome for derived labels, including older fixed-character labels. */
export function displayLaneName(name: string, outcome: string): string {
  return name === derivedLaneName(outcome) || name === outcome.slice(0, 120) ? outcome : name;
}
