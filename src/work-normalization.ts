// SPDX-License-Identifier: Apache-2.0
// Keep schema-normalized property order relied on by legacy receipts while retaining
// uninterpreted extension fields through a local migration.
export function preserveFields(parsed: unknown, raw: unknown): unknown {
  // Zod leaves unknown facts untouched. Clone those owned JSON branches directly
  // rather than recursively rebuilding every original migration observation.
  if (parsed === raw) return parsed !== null && typeof parsed === 'object' ? structuredClone(parsed) : parsed;
  if (Array.isArray(parsed) && Array.isArray(raw))
    return parsed.map((value, index) => preserveFields(value, raw[index]));
  if (parsed && raw && typeof parsed === 'object' && typeof raw === 'object') {
    const known = parsed as Record<string, unknown>,
      original = raw as Record<string, unknown>;
    return Object.fromEntries([
      ...Object.entries(known).map(([key, value]) => [key, preserveFields(value, original[key])]),
      ...Object.entries(original).filter(([key]) => !Object.hasOwn(known, key)),
    ]);
  }
  return parsed;
}
