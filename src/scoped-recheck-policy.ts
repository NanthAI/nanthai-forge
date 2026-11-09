// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { CheckGate } from './bet2-gate.js';
import { gateFor, type GateInput } from './contract-gate-policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Server-written basis: the last full pass of this finish's unchanged selection. */
export const scopedRecheckBasisSchema = z
  .object({
    checked: z.object({ id: z.uuid(), head: hash, digest: hash }).strict(),
    checkedBase: z.object({ head: hash, receiptId: z.string().min(1) }).strict(),
    runId: z.uuid(),
  })
  .strict();
export type ScopedRecheckBasis = z.infer<typeof scopedRecheckBasisSchema>;

// The base rides in the gate reason, as culprit gates do, so an older planner
// parses the run and falls back to its ordinary scoped selection of this change.
const prefix = 'scoped-recheck:';
export const scopedRecheckGate = (basis: ScopedRecheckBasis): CheckGate => ({
  mode: 'scoped',
  reason: `${prefix}${basis.checkedBase.head}`,
});
export function scopedRecheckBase(gate: CheckGate | undefined) {
  const base =
    gate?.mode === 'scoped' && gate.reason?.startsWith(prefix) ? gate.reason.slice(prefix.length) : '';
  return hash.safeParse(base).success ? base : null;
}

// A cohort recheck (Issue 28f08555) names each basis as `checkedBase.checked`: the runner rechecks,
// per basis, the tests that can see both that checked change and everything else in the cohort's
// Candidate, and runs their union. An older planner reads an ordinary scoped gate, as above.
const batchPrefix = 'scoped-recheck-batch:';
export const scopedRecheckBatchGate = (bases: readonly ScopedRecheckBasis[]): CheckGate => ({
  mode: 'scoped',
  reason: `${batchPrefix}${[...new Set(bases.map(b => `${b.checkedBase.head}.${b.checked.head}`))].join(',')}`,
});
/** The cohort recheck's bases, `{base, checked}` State heads, or null for any other gate. */
export function scopedRecheckPairs(gate: CheckGate | undefined) {
  if (gate?.mode !== 'scoped' || !gate.reason?.startsWith(batchPrefix)) return null;
  const pairs = gate.reason
    .slice(batchPrefix.length)
    .split(',')
    .map(pair => pair.split('.'));
  return pairs.length && pairs.every(pair => pair.length === 2 && pair.every(h => hash.safeParse(h).success))
    ? pairs.map(([base, checked]) => ({ base: base!, checked: checked! }))
    : null;
}
/** A solo or cohort main-race recheck: scoped evidence accepted on the contract gate's terms. */
export const isScopedRecheck = (gate: CheckGate | undefined) =>
  scopedRecheckBase(gate) !== null || scopedRecheckPairs(gate) !== null;
/** One cohort recheck selection needs a full-pass basis for every included member: the cohort's own
 * earlier full pass covers them together; otherwise each member's own. Any member without one keeps
 * the full union (its change never passed a whole check). */
export function cohortRecheckBases(
  cohort: ScopedRecheckBasis | undefined,
  members: readonly { recheck?: ScopedRecheckBasis | undefined }[],
): ScopedRecheckBasis[] | undefined {
  if (cohort) return [cohort];
  const bases = members.map(member => member.recheck);
  return bases.length && bases.every(basis => basis !== undefined) ? bases : undefined;
}

/** The contract gate's eligibility, without its Intent contract and under either gate (Issue
 * fc215574): the same owner-agent, auto-on-pass, unprotected path, trust and green, debt-free main
 * audit. A full-gated project's main-race recheck runs the tests that can see both changes; the
 * skipped tests are main-audit debt, as under the contract gate. */
export function scopedRecheckEligible(input: GateInput) {
  const acceptance = input.policy.acceptance;
  return (
    acceptance.scopedRecheck !== false &&
    gateFor({
      ...input,
      policy: { ...input.policy, acceptance: { ...acceptance, gate: 'contract' } },
      contract: { version: 0, tests: [] },
    }).mode === 'contract'
  );
}
/** Whether a project's policy can run main-race rechecks scoped (the per-actor rules apply later). */
export const scopedRecheckPolicy = (acceptance: { mode: string; scopedRecheck?: boolean | undefined }) =>
  acceptance.mode === 'auto-on-pass' && acceptance.scopedRecheck !== false;
export function acceptScopedRecheck(input: GateInput): 'pass' | 'full-required' | 'main-red' {
  if (!scopedRecheckEligible({ ...input, main: { ...input.main, status: 'green', debt: false } }))
    return 'full-required';
  if (input.main.status === 'red') return 'main-red';
  return scopedRecheckEligible(input) ? 'pass' : 'full-required';
}
