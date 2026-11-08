// SPDX-License-Identifier: Apache-2.0
import { globPattern, type AcceptanceActor, type AutonomyPolicy } from './autonomy-policy.js';
import { ownerApprovalMatcher, type DefinedChecks } from './public-governance.js';
import type { CheckGate, MainGate } from './bet2-gate.js';

export type GateInput = {
  policy: AutonomyPolicy;
  project: { owner: string };
  actor: AcceptanceActor | { kind: 'system'; id: string };
  paths: string[] | null;
  contract: { version: number; tests: { path: string }[] } | null;
  main: MainGate;
  /** B2.6, only when `policy.trust.enabled`: trust demotes a supervised actor to the full gate and lets a
   * trusted non-owner agent qualify; it never overrides an explicit `autoActors` list. */
  trust?: { level: 'supervised' | 'trusted' | 'autonomous'; reason: string } | null;
  /** The project's defined checks (and their setup actions), already loaded by the caller; their entry files are protected like the default paths. */
  checks?: DefinedChecks;
};
export function protectedGatePaths(policy: AutonomyPolicy, paths: string[] | null, checks?: DefinedChecks) {
  if (paths === null) return true;
  const approval = ownerApprovalMatcher(policy, checks);
  const patterns = policy.acceptance.protectedPaths.map(globPattern);
  return paths.some(path => approval(path) || patterns.some(pattern => pattern.test(path)));
}
/** Whether an actor's landings may use reduced evidence (the contract gate, first-check reuse). Decided
 * by project policy: an agent on a non-empty `autoActors` list qualifies, an agent off that list never
 * does; with no list the owner's agent qualifies by default, and any other agent only once trust is
 * enabled and has raised it above `supervised` on these paths. Persons and system actors never qualify. */
export function reducedEvidenceActor(
  policy: AutonomyPolicy,
  project: { owner: string },
  actor: GateInput['actor'],
  trust?: GateInput['trust'],
) {
  if (actor.kind !== 'agent') return false;
  const listed = policy.acceptance.autoActors ?? [];
  if (listed.length && !listed.includes(actor.id)) return false;
  if (actor.id === project.owner) return true;
  if (trust) return trust.level !== 'supervised';
  return listed.length > 0;
}
/** Eligibility is recomputed from current server policy, never request gate metadata. */
export function gateFor(input: GateInput): CheckGate {
  const { policy, project, actor, paths, contract, main, trust, checks } = input;
  let reason = 'Full gate';
  if (policy.acceptance.gate !== 'contract') reason = 'Contract gate is off';
  else if (policy.acceptance.mode !== 'auto-on-pass') reason = 'Supervised acceptance';
  else if (!reducedEvidenceActor(policy, project, actor, trust))
    reason = 'Owner review, contributor or system acceptance';
  else if (protectedGatePaths(policy, paths, checks)) reason = 'Protected or unknown paths';
  else if (trust?.level === 'supervised') reason = trust.reason;
  else if (!contract) reason = 'Intent has no contract';
  else if (main.status !== 'green' || main.debt)
    reason = main.status === 'red' ? 'Main is red' : 'Main audit unavailable or in debt';
  else
    return {
      mode: 'contract',
      tests: contract.tests.map(test => test.path),
      contractVersion: contract.version,
      reason: 'Trusted actor with a declared Intent contract',
    };
  return { mode: 'full', reason };
}
/** A hosted batch checks every member's declaration on its combined Candidate.
 * One ineligible member requires full evidence for the whole batch. Callers
 * provide server-read policy, actors, paths and contracts, never request gates.
 * contractVersion is the highest included version; membership remains pinned
 * by the batch's canonical Candidates, not by this scalar summary. */
export function gateForCandidates(candidates: readonly GateInput[]): CheckGate {
  if (!candidates.length) return { mode: 'full', reason: 'No Candidate contracts' };
  const gates = candidates.map(gateFor);
  const full = gates.find(gate => gate.mode === 'full');
  if (full) return full;
  if (gates.length === 1) return gates[0]!;
  return {
    mode: 'contract',
    tests: [...new Set(gates.flatMap(gate => gate.tests ?? []))].sort(),
    contractVersion: Math.max(...gates.map(gate => gate.contractVersion!)),
    reason: `Trusted actors with ${gates.length} declared Intent contracts`,
  };
}
/** Legacy runners omit the echo and still run the full gate. Only the server's
 * prepared run can claim reduced evidence; request.gate is never authoritative. */
export function acceptGate(input: GateInput, gate?: CheckGate): 'pass' | 'full-required' | 'main-red' {
  if (!gate || gate.effective === 'full' || gate.effective === 'docs') return 'pass';
  if (gate.effective === undefined)
    return gate.mode === 'full' || gate.mode === 'audit' || gate.mode === 'contract' || gate.mode === 'scoped'
      ? 'pass'
      : 'full-required';
  if (gate.mode !== 'contract') return 'full-required';
  // Main red holds only otherwise eligible contract attempts; full-gated fixes proceed.
  const required = gateFor({ ...input, main: { ...input.main, status: 'green', debt: false } });
  if (
    required.mode !== 'contract' ||
    required.contractVersion !== gate.contractVersion ||
    required.tests?.some(test => !gate.tests?.includes(test))
  )
    return 'full-required';
  if (input.main.status === 'red') return 'main-red';
  return gateFor(input).mode === 'contract' ? 'pass' : 'full-required';
}
