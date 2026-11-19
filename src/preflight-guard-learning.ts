// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { z } from 'zod';
import { type GuardCandidates, guardFileName } from './hosted-lane.js';

/** The server half of the learned preflight guard set (Item 13ea93bf). A landing carries a compact
 * set of the test files its preflight ran (`ran`, on the land gate). When its check fails, the server
 * keeps the failing test files that preflight did not run, in one bounded per-project document
 * written only then. Lane start replies carry the candidates computed from that document and the
 * landed samples the speed record keeps anyway; the CLI caches them by revision and picks the set
 * with its own measured seconds and budget. A fresh sandbox therefore learns from the whole project
 * on its first start, and a project's learning never depends on one machine. */

/** Landing outcomes the rate is read over. */
export const GUARD_WINDOW = 50;
/** A file needs this many skipped failures in the window: one may be a flake. */
export const GUARD_MIN_FAILURES = 2;
/** Landed outcomes the window needs before p counts: a new or reset record has too few to divide by. */
const GUARD_MIN_LANDED = 5;
const MAX_FAILURES = GUARD_WINDOW;
const MAX_FILES = 8;
const MAX_CANDIDATES = 20;
// The land gate's own copies (hosted-land-gates.ts): importing them would split that module out of
// the CLI's eager chunks, since this one loads lazily.
const RAN_MAX_FILES = 256;
const ranKeys = (ran: string) => ran.match(/.{4}/g) ?? [];
const MAX_DOC_CHARS = 8 * 1024;
const HORIZON_MS = 7 * 24 * 3600 * 1000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 24 bits of FNV-1a as four base64url characters. A false match only hides one failure from
 * learning (about 1 in 65,000 at 256 files), so the set can only come out smaller. */
export function ranKey(file: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) hash = Math.imul(hash ^ file.charCodeAt(i), 0x01000193) >>> 0;
  hash = (hash ^ (hash >>> 24)) & 0xffffff;
  return B64[(hash >> 18) & 63]! + B64[(hash >> 12) & 63]! + B64[(hash >> 6) & 63]! + B64[hash & 63]!;
}
/** The gate's `ran`: sorted keys, 4 characters per file; undefined past the cap (unknown). */
export function ranEvidence(files: Iterable<string>): string | undefined {
  const keys = [...new Set([...files].map(ranKey))].sort();
  return keys.length <= RAN_MAX_FILES ? keys.join('') : undefined;
}
const failureSchema = z.tuple([
  /** Submission id, failed at (ms), builder wait s (submit to verdict), runner s, local preflight
   * runs of the Lane, and the failing test files preflight did not run with their check ms. */
  z.string().max(64),
  z.number(),
  z.number().nonnegative().nullable(),
  z.number().nonnegative().nullable(),
  z.number().int().nonnegative().nullable(),
  z.array(z.tuple([guardFileName, z.number().nonnegative().nullable()])).max(MAX_FILES),
]);
const guardDocSchema = z.object({ v: z.literal(1), failures: z.array(failureSchema) }).strict();
type GuardFailure = z.infer<typeof failureSchema>;

function readDoc(text: string | undefined) {
  if (!text) return [];
  try {
    return guardDocSchema.parse(JSON.parse(text)).failures;
  } catch {
    return [];
  }
}
const seconds = (from?: string, to?: string) => {
  const value = (Date.parse(to ?? '') - Date.parse(from ?? '')) / 1000;
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
};

export type FailedCheck = {
  id: string;
  timing?: { submittedAt?: string; ciEndedAt?: string; settledAt?: string } | undefined;
  counts?: { runnerSeconds?: number | undefined } | undefined;
  testFiles?: { failed: { file: string; report?: { durationMs?: number | undefined } }[] } | undefined;
};
/** A check failure joins the document; null when nothing changes (already recorded). Files go in
 * only when the landing said what its preflight ran. Bounded to the last 50 failures and 8 KB. */
export function addGuardFailure(
  text: string | undefined,
  state: FailedCheck,
  evidence: { ran?: string | undefined; runs?: number | undefined },
  now: number,
): string | null {
  const failures = readDoc(text).filter(failure => failure[1] >= now - HORIZON_MS);
  if (failures.some(failure => failure[0] === state.id)) return null;
  const ran = evidence.ran === undefined ? null : new Set(ranKeys(evidence.ran));
  const files: GuardFailure[5] = [];
  for (const item of ran ? (state.testFiles?.failed ?? []) : []) {
    if (!guardFileName.safeParse(item.file).success || ran!.has(ranKey(item.file))) continue;
    const ms = item.report?.durationMs;
    files.push([item.file, typeof ms === 'number' && ms >= 0 ? Math.round(ms) : null]);
    if (files.length === MAX_FILES) break;
  }
  const runner = state.counts?.runnerSeconds;
  failures.push([
    state.id.slice(0, 64),
    now,
    seconds(state.timing?.submittedAt, state.timing?.ciEndedAt ?? state.timing?.settledAt),
    typeof runner === 'number' && runner >= 0 ? runner : null,
    evidence.runs ?? null,
    files,
  ]);
  let kept = failures.slice(-MAX_FAILURES);
  while (kept.length > 1 && JSON.stringify({ v: 1, failures: kept }).length > MAX_DOC_CHARS)
    kept = kept.slice(1);
  return JSON.stringify({ v: 1, failures: kept });
}

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : null;
};
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const revision = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
};

/** The candidates over the last 50 outcomes: landed ones from the speed record's retained samples
 * (`landedAt`, ms), failed ones from the document. The window never reaches before the record's
 * oldest sample: landings it dropped (its sample cap, or a reset record) would otherwise go uncounted
 * and inflate p. Until the window holds GUARD_MIN_LANDED landings, no file is a candidate. */
export function guardCandidates(text: string | undefined, landedAt: number[], now: number): GuardCandidates {
  const failures = readDoc(text).filter(failure => failure[1] >= now - HORIZON_MS);
  const floor = landedAt.length ? Math.min(...landedAt) : Infinity;
  const outcomes = [
    ...landedAt.map(at => ({ at, failure: null as GuardFailure | null })),
    ...failures.map(failure => ({ at: failure[1], failure })),
  ]
    .filter(outcome => outcome.at >= floor)
    .sort((a, b) => b.at - a.at)
    .slice(0, GUARD_WINDOW);
  const failed = outcomes.flatMap(outcome => (outcome.failure ? [outcome.failure] : []));
  const enough = outcomes.length - failed.length >= GUARD_MIN_LANDED;
  const runs = failed.flatMap(failure => (failure[4] === null ? [] : [failure[4]]));
  const count = new Map<string, { failures: number; ms: number[] }>();
  for (const failure of failed)
    for (const [file, ms] of new Map(failure[5])) {
      const seen = count.get(file) ?? { failures: 0, ms: [] };
      seen.failures += 1;
      if (ms !== null) seen.ms.push(ms);
      count.set(file, seen);
    }
  const runner = median(failed.flatMap(failure => (failure[3] === null ? [] : [failure[3]])));
  const body = {
    outcomes: outcomes.length,
    failed: failed.length,
    C: median(failed.flatMap(failure => (failure[2] === null ? [] : [failure[2]]))) ?? 0,
    r: runs.length ? round(Math.max(1, runs.reduce((sum, n) => sum + n, 0) / runs.length), 2) : 1,
    runnerMinutes: runner === null ? null : round(runner / 60),
    files: [...count]
      .filter(([, seen]) => enough && seen.failures >= GUARD_MIN_FAILURES)
      .sort((a, b) => b[1].failures - a[1].failures || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_CANDIDATES)
      .map(([file, seen]) => ({
        file,
        failures: seen.failures,
        checkSeconds: seen.ms.length ? round(median(seen.ms)! / 1000) : null,
      })),
  };
  return { rev: revision(JSON.stringify(body)), ...body };
}
