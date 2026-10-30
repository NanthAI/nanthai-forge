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

/** The contract gate's eligibility, without its Intent contract: the same
 * owner-agent, auto-on-pass, unprotected path, trust and green, debt-free main audit. */
export function scopedRecheckEligible(input: GateInput) {
  return (
    input.policy.acceptance.gate === 'contract' &&
    input.policy.acceptance.scopedRecheck !== false &&
    gateFor({ ...input, contract: { version: 0, tests: [] } }).mode === 'contract'
  );
}
export function acceptScopedRecheck(input: GateInput): 'pass' | 'full-required' | 'main-red' {
  if (!scopedRecheckEligible({ ...input, main: { ...input.main, status: 'green', debt: false } }))
    return 'full-required';
  if (input.main.status === 'red') return 'main-red';
  return scopedRecheckEligible(input) ? 'pass' : 'full-required';
}
