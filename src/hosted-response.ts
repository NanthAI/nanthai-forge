// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

/**
 * Response boundary rule (Issue 3205f7e6): a server may ADD reply fields at any deploy, and a
 * published CLI lags the server. So a hosted reply drops object keys this CLI does not know, but
 * still rejects a missing required field, a wrong type or an unknown enum value. Response schemas
 * stay `.strict()` (tests catch typos); only this boundary forgives unknown keys. Request schemas
 * never go through here. A new field that CHANGES the meaning of a reply (not just adds to it)
 * goes behind a named contract feature (src/hosted-contract-features.ts) instead. Reads that report an
 * outcome across a deploy use parseHostedOutcome (below), which degrades further and says so.
 * Docs: docs/operations/cli-update.md "Server replies".
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

/** Field names only: an index or a record key (which can be data, such as a file path) shows as `*`. */
const pathText = (path: readonly PropertyKey[]) =>
  path
    .map(part => (typeof part === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(part) ? part : '*'))
    .join('.') || 'reply';
/** Reply field paths a contract failure names (indices as `*`, at most 5; paths only, never values).
 * Unknown keys are named only when nothing else failed: the boundary drops them anyway. */
export function replyIssuePaths(issues: readonly Issue[]): string[] {
  const failed = issues.filter(issue => issue.code !== 'unrecognized_keys');
  const paths = (failed.length ? failed : issues).map(issue =>
    issue.code === 'unrecognized_keys'
      ? `${pathText(issue.path)}{${issue.keys.map(key => pathText([key])).join('|')}}`
      : pathText(issue.path),
  );
  return [...new Set(paths)].slice(0, 5);
}

const startsWith = (path: readonly PropertyKey[], prefix: readonly PropertyKey[]) =>
  prefix.every((part, index) => path[index] === part);
const holds = (value: unknown, path: readonly PropertyKey[], key: string): boolean => {
  let at = value;
  for (const part of path)
    at = at && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[part] : undefined;
  return Boolean(at && typeof at === 'object' && !Array.isArray(at) && Object.hasOwn(at, key));
};
/** One removal of the smallest OPTIONAL field that holds a contract failure, or undefined. A required
 * field is never removed: deleting it leaves a failure at its own path, so the next ancestor is tried. */
function dropMismatched(
  schema: z.ZodType,
  value: unknown,
  issues: readonly Issue[],
  budget: { parses: number },
) {
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') continue;
    for (let depth = issue.path.length; depth > 0 && budget.parses > 0; depth--) {
      const key = issue.path[depth - 1],
        parent = issue.path.slice(0, depth - 1),
        prefix = issue.path.slice(0, depth);
      if (typeof key !== 'string' || !holds(value, parent, key)) continue;
      const next = without(value, { path: parent, keys: [key] });
      budget.parses--;
      const parsed = schema.safeParse(next);
      if (parsed.success || !parsed.error.issues.some(found => startsWith(found.path, prefix)))
        return { next, dropped: prefix };
    }
  }
  return undefined;
}

/** A reply this CLI could read only in part: the failing paths and which side is older. */
export type ReplySkew = {
  /** Reply fields that did not match this CLI's contract. */
  paths: string[];
  /** Optional fields left out of the parsed reply because their shape is newer than this CLI. */
  dropped: string[];
  /** true: only the stable outcome fields were read (`stable` schema). */
  stable: boolean;
};

/**
 * Reads that report an operation's OUTCOME across a deploy (Issue 71ef0a66: a running wait read a
 * landed reply whose optional `acceptance.acceptedBy` had been renamed, and called a landed change
 * failed). Never silent: the caller reports the returned skew. In order:
 * 1. the normal boundary (unknown keys dropped); no skew;
 * 2. optional fields whose shape differs are left out (bounded re-parses of the same value);
 * 3. the `stable` schema, the outcome fields servers keep unchanged, passing everything else through.
 * Only when all fail does it throw the original error (a reply error). Zero extra calls.
 */
export function parseHostedOutcome<S extends z.ZodType, C extends z.ZodType>(
  schema: S,
  stable: C,
  value: unknown,
): { data: z.output<S>; skew?: ReplySkew } | { data: z.output<C>; skew: ReplySkew & { stable: true } } {
  const first = safeParseHostedResponse(schema, value);
  if (first.success) return { data: first.data };
  const paths = replyIssuePaths(first.error.issues);
  const dropped: string[] = [];
  const budget = { parses: 64 };
  let current = value,
    parsed: z.ZodSafeParseResult<z.output<S>> = first;
  for (let round = 0; !parsed.success && round < 16 && budget.parses > 0; round++) {
    const drop = dropMismatched(schema, current, parsed.error.issues, budget);
    if (!drop) break;
    dropped.push(pathText(drop.dropped));
    current = drop.next;
    parsed = safeParseHostedResponse(schema, current);
  }
  if (parsed.success)
    return { data: parsed.data, skew: { paths, dropped: [...new Set(dropped)], stable: false } };
  const core = stable.safeParse(value);
  if (core.success) return { data: core.data, skew: { paths, dropped: [], stable: true } };
  replyErrors.add(first.error);
  throw first.error;
}
