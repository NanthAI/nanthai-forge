// SPDX-License-Identifier: Apache-2.0
/** Stable metadata bytes only; never accepts a credential or source export. */
export function metadataBytes(value: unknown): string {
  function order(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(order);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, order(x)]),
      );
    return v;
  }
  return JSON.stringify(order(value));
}
