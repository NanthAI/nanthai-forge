// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

/**
 * Response boundary rule (Issue 3205f7e6): a server may ADD reply fields at any deploy, and a
 * published CLI lags the server. So a hosted reply drops object keys this CLI does not know, but
 * still rejects a missing required field, a wrong type or an unknown enum value. Response schemas
 * stay `.strict()` (tests catch typos); only this boundary forgives unknown keys. Request schemas
 * never go through here. A new field that CHANGES the meaning of a reply (not just adds to it)
 * goes behind a named contract feature (src/hosted-contract-features.ts) instead.
 * Docs: docs/agents/hosted-parity.md "Response contract".
 */
type Issue = z.core.$ZodIssue;
type Strip = { path: PropertyKey[]; keys: string[] };

/** The unknown-key removals that would fix every issue, or null when any issue is something else. */
function strips(issues: readonly Issue[], prefix: PropertyKey[] = []): Strip[] | null {
  const found: Strip[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') found.push({ path, keys: issue.keys });
    else if (issue.code === 'invalid_union') {
      // The closest branch: one whose only failures are unknown keys, fewest keys first.
      const best = issue.errors
        .map(branch => strips(branch, path))
        .filter((branch): branch is Strip[] => branch !== null)
        .sort((a, b) => a.flatMap(s => s.keys).length - b.flatMap(s => s.keys).length)[0];
      if (!best) return null;
      found.push(...best);
    } else return null;
  }
  return found;
}

function without(value: unknown, strip: Strip): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!strip.path.length) {
    if (Array.isArray(value)) return value;
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of strip.keys) delete copy[key];
    return copy;
  }
  const [head, ...rest] = strip.path;
  const child = (value as Record<PropertyKey, unknown>)[head as PropertyKey];
  const next = without(child, { path: rest, keys: strip.keys });
  if (next === child) return value;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = next;
    return copy;
  }
  return { ...(value as Record<string, unknown>), [head as string]: next };
}

/** Parses a hosted reply. Unknown object keys are dropped; every other contract failure throws the
 * original ZodError (the transport maps it to HOSTED_PROTOCOL_INVALID). The input is never mutated. */
export function parseHostedResponse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = safeParseHostedResponse(schema, value);
  if (!parsed.success) {
    replyErrors.add(parsed.error);
    throw parsed.error;
  }
  return parsed.data;
}

/** Errors thrown by the reply boundary. Only these say the server's reply disagrees with this CLI
 * (version skew); a ZodError from a request or local file means something else (Issue ec7bd1b5). */
const replyErrors = new WeakSet<object>();
export const isHostedReplyError = (error: unknown) =>
  typeof error === 'object' && error !== null && replyErrors.has(error);

/** parseHostedResponse without throwing, for callers that report their own protocol error. */
export function safeParseHostedResponse<S extends z.ZodType>(schema: S, value: unknown) {
  let current = value;
  let parsed = schema.safeParse(current);
  // Each round removes at least one key; nested unions may reveal more after a removal.
  for (let round = 0; !parsed.success && round < 16; round++) {
    const found = strips(parsed.error.issues);
    const next = found?.length ? found.reduce(without, current) : current;
    if (next === current) break;
    current = next;
    parsed = schema.safeParse(current);
  }
  return parsed as z.ZodSafeParseResult<z.output<S>>;
}
