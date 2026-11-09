// SPDX-License-Identifier: Apache-2.0
import { pathsOverlap } from './hosted-cross-head-proof.js';
import { globalRiskBetween } from './first-check-risk.js';

/** The older live entry a passed (Ready) landing is about to wait for. */
export type OvertakeTarget = {
  phase: 'queued' | 'checking' | 'ready';
  priority?: 'urgent' | 'normal';
  attemptId: string;
  runId: string | null;
  /** Entered the queue after its own pre-queue Lane check (its Lane run can go stale). */
  admitted: boolean;
  /** `overtakeMark` of the generation a newer landing already overtook, if any. */
  overtaken?: string;
};

/** The check generation a newer landing makes stale by taking main first. */
export const overtakeMark = (target: Pick<OvertakeTarget, 'attemptId' | 'runId'>) =>
  `${target.attemptId}:${target.runId ?? ''}`;

/** Bounded overtaking (core-claim incident 7d98c7da, 2026-11-08). Strict submission
 * order (e4aee4fe) made every passed landing wait out an older entry's whole check,
 * related or not: with ~14 parallel builders, passed landings waited 17-40 min. A
 * passed landing now takes main ahead of an older live entry it is unrelated to
 * (`unrelatedChanges`, checked by the caller) once per check generation of that
 * entry: the older one lands on its stale pass through the first-check proof, or
 * re-checks at most once because of it, and from its next check on it holds strict
 * order again, so it cannot starve.
 *
 * - `hold`: wait as before (a Ready entry about to land, an urgent entry, or one
 *   that already gave up its place for an earlier generation);
 * - `free`: skip it at no cost to it (queued with no check of its own in flight,
 *   or this same generation was already overtaken);
 * - `spend`: skip it and record `overtakeMark(target)` on it.
 * Pure: no reads, so the claim transaction adds one patch per spent entry only. */
export function overtakeOlder(target: OvertakeTarget): 'hold' | 'free' | 'spend' {
  if (target.phase === 'ready' || target.priority === 'urgent') return 'hold';
  if (target.overtaken !== undefined) return target.overtaken === overtakeMark(target) ? 'free' : 'hold';
  if (target.phase === 'queued' && !target.admitted) return 'free';
  return 'spend';
}

/** The older entry as graph-sealed landing (D1, Issue c6b81429) sees it. */
export type SealedTarget = Pick<OvertakeTarget, 'phase' | 'priority'> & {
  /** A Ready entry parked behind an older submission (`orderWait`): it is not about to land. */
  parked: boolean;
  /** A member of a combined group: its shared pass never carries across heads. */
  combined: boolean;
  /** Why this entry's pass cannot be carried across a moved main (`unsealed` on the row), if known. */
  unsealed?: string;
  /** The project lets a passed check carry across heads (first-check proof). */
  proofs: boolean;
};

/** Graph-sealed landing order (D1, Issue c6b81429). An older entry whose changes are independent of
 * a passed newer one (`unrelatedChanges`: the same test the first-check proof applies) loses nothing
 * when the newer one takes main first: its own pass lands across that main move through the proof,
 * so it never re-checks for it. Such an entry never holds the newer one, for any number of its check
 * generations and including a Ready entry that is itself parked behind an older submission, so N
 * independent landings reach main in about one check wall. Not sealed (the bounded `overtakeOlder`
 * rule decides): urgent entries, a Ready entry about to land, combined-group members, a project whose policy keeps exact
 * rechecks, and an entry whose pass cannot be carried (`unsealed`: its re-check is scoped, or a proof
 * was refused for a reason other than a dependent change). `unsealed` is set once and kept, so a wrong
 * guess costs that entry at most one re-check before strict order protects it again. Pure. */
export function sealedOlder(target: SealedTarget) {
  return (
    target.proofs &&
    !target.combined &&
    target.priority !== 'urgent' &&
    target.unsealed === undefined &&
    (target.phase !== 'ready' || target.parked)
  );
}

/** Proof refusals caused by a change the other side depends on (paths, risk files, a text merge).
 * An independent newer landing never causes one; any other refusal means the entry's pass cannot be
 * carried at all, so it stops being sealed (`unsealed`). */
const DEPENDENT_REFUSALS = new Set([
  'path-overlap',
  'global-risk',
  'order-sensitive',
  'tested-doc',
  'composition-not-exact',
  'text-conflict',
]);
export const unsealedBy = (input: { reason: string | undefined; scoped: boolean }) =>
  input.scoped
    ? 'scoped-recheck'
    : DEPENDENT_REFUSALS.has(input.reason ?? '')
      ? null
      : (input.reason ?? 'not-eligible');

/** Two changes are unrelated when neither's paths equal, contain or sit inside the
 * other's and together they touch no global-risk file (the first-check rule's own
 * tests, `clean-disjoint` without the Markdown allowance). Only an unrelated older
 * entry is overtaken: landing a related change first would make it re-check anyway
 * and gain nothing for the other waiters. Unknown paths are related. */
export function unrelatedChanges(
  mine: readonly string[] | null,
  theirs: readonly string[] | null,
  checkEntries: readonly string[],
) {
  return Boolean(
    mine?.length &&
    theirs?.length &&
    !pathsOverlap([...mine], [...theirs]) &&
    !globalRiskBetween(mine, theirs, checkEntries),
  );
}
