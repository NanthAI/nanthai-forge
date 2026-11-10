// SPDX-License-Identifier: Apache-2.0
// Package-graph-scoped first check (Issue 234b5abc): an Intent without a contract, under every
// other contract-gate guard, may run its first check scoped to the packages its change affects,
// but only for a configured command that declares `selection: changed-paths` and only when the
// manifest package graph selects a minority of the testable packages. Forge's own recipe keeps
// full first checks (Issue 5562167f). A scoped pass is scoped evidence: main-audit debt, the full
// post-accept main audit, red main stops it.
import type { CheckGate } from './bet2-gate.js';
import { gateFor, type GateInput } from './contract-gate-policy.js';
import { buildPackageGraph, packageSelection, type PackageGraph } from './package-graph.js';
import { filesPackageFlags, type PackageFlagSource } from './package-command-flags.js';
import { isStandardForgeCheck } from './standard-check.js';

/** The graph may select at most this share of the testable packages. */
export const GRAPH_FIRST_MAX_SHARE = 0.5;
const REASON = 'graph-first: package-graph-scoped first check';
/** Stands in for the missing contract so the rest of the contract gate decides eligibility. Real
 * contracts start at version 1. */
export const GRAPH_FIRST_CONTRACT = { version: 0, tests: [] as { path: string }[] };

export const graphFirstGate = (): CheckGate => ({ mode: 'scoped', reason: REASON });
export const isGraphFirstGate = (gate: CheckGate | undefined) =>
  gate?.mode === 'scoped' && gate.reason === REASON;

type Check = { executable: string; args: readonly string[]; selection?: { scope?: string | undefined } };
/** A configured command that reads the changed paths; Forge's own recipe never qualifies. */
export const graphFirstCheck = (check: Check) =>
  !isStandardForgeCheck(check) && check.selection?.scope === 'changed-paths';

/** Server gate: `gate` came from `gateFor` with GRAPH_FIRST_CONTRACT for a member without a contract. */
export const fromGraphFirstContract = (gate: CheckGate) =>
  gate.mode === 'contract' && gate.contractVersion === 0 && !gate.tests?.length ? graphFirstGate() : gate;

const eligible = (input: GateInput) => gateFor(input).mode === 'contract';
/** Acceptance re-reads current policy and main: the same terms as a scoped recheck. The caller
 * passes GRAPH_FIRST_CONTRACT as the contract; a recovery (needs-fix) Intent arrives with none. */
export function acceptGraphFirst(input: GateInput): 'pass' | 'full-required' | 'main-red' {
  if (!eligible({ ...input, main: { ...input.main, status: 'green', debt: false } })) return 'full-required';
  if (input.main.status === 'red') return 'main-red';
  return eligible(input) ? 'pass' : 'full-required';
}

/** Recorded on the run's selection: what the graph selected of the testable packages. */
export type GraphShare = { scope: 'scoped' | 'full'; selected: number; total: number; reason: string };

/** The minority rule over one Candidate's manifests. Scoped only when the graph places every changed
 * path and selects a runnable minority; an unknown graph, unplaced paths, a root package, nothing to
 * run or a majority keep the full check. */
export function graphShare(
  graph: PackageGraph,
  changed: string[],
  flags?: PackageFlagSource | { refusal: string },
): GraphShare {
  const selection = packageSelection(graph, changed, undefined, flags);
  if (graph.status === 'unknown' || selection.scope === 'full')
    return { scope: 'full', selected: 0, total: 0, reason: selection.reason };
  const testable = new Set(
    graph.packages.filter(pkg => pkg.testable).map(pkg => `${pkg.ecosystem}:${pkg.dir}`),
  );
  const selected = selection.packages.filter(pkg => testable.has(`${pkg.ecosystem}:${pkg.dir}`)).length;
  const total = testable.size;
  const share = `${selected} of ${total} testable packages`;
  if (selection.scope !== 'scoped' || !selected)
    return { scope: 'full', selected, total, reason: `package graph selects nothing to run (${share})` };
  if (selected > total * GRAPH_FIRST_MAX_SHARE)
    return {
      scope: 'full',
      selected,
      total,
      reason: `package graph selects ${share}, more than ${GRAPH_FIRST_MAX_SHARE * 100}%`,
    };
  return { scope: 'scoped', selected, total, reason: `package graph selects ${share}` };
}

/** `graphShare` over a file map (path → text, read on demand); manifests, forge.json and the
 * check's own scripts (its test flags, as the runner reads them), no repository code run. */
export const graphShareFor = (
  files: { keys(): Iterable<string>; get(path: string): string | undefined },
  changed: string[],
  check?: { executable: string; args: readonly string[] },
) =>
  graphShare(
    buildPackageGraph(files.keys(), path => files.get(path)),
    changed,
    check ? filesPackageFlags(path => files.get(path), check) : undefined,
  );
