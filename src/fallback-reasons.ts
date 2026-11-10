// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { markdownPath } from './tested-docs.js';
import { scopedRecheckBase, scopedRecheckPairs } from './scoped-recheck-policy.js';
import { isGraphFirstGate } from './graph-first-check.js';
import type { CheckGate } from './bet2-gate.js';

/** Why Forge took a slower path instead of a fast one (Issue 7c2e69e1). Every code is
 * recorded at its decision point, on the write that decision already makes, and counted by
 * `metrics`. A `limitation` means Forge could not use its fast path for this repository or
 * change shape (fix Forge or configure the project); `genuine` means the slower path is the
 * right outcome (a real conflict, a real risk, or the project's own policy). */
export type FallbackKind = 'limitation' | 'genuine';
/** Where the decision was made. `first-check`: an admitted landing did not land on its
 * admission run (receipt `firstCheck`). `main-race`: main moved before acceptance and the
 * attempt rechecked instead of carrying its check across heads (attempt `recheckReason`).
 * `scoped-recheck`: that recheck ran in full instead of the shared-impact selection.
 * `contract-gate`: the run took the full gate instead of the contract gate. `selection`:
 * the runner could not narrow or skip the configured command. */
export type FallbackStage = 'first-check' | 'main-race' | 'scoped-recheck' | 'contract-gate' | 'selection';

const L = 'limitation' as const,
  G = 'genuine' as const;
/** Cross-head reuse and its proof (projectHostedReuseStore, hosted-cross-head-analysis),
 * shared by the `first-check` and `main-race` stages. */
const REUSE = {
  'not-eligible': L,
  'not-tried': L,
  cohort: L,
  'reuse-policy': G,
  'main-red': G,
  'audit-debt': G,
  'text-conflict': G,
  'check-evidence': L,
  'audit-baseline': L,
  'path-overlap': G,
  'tested-doc': G,
  'global-risk': G,
  'order-sensitive': G,
  'composition-not-exact': L,
  'unsupported-mode': L,
  'checked-not-full': L,
  'audit-not-full': L,
  'source-unavailable': L,
  'analysis-expired': L,
} as const;
const SCOPED = {
  'scoped-no-evidence': L,
  'scoped-base-unavailable': L,
  'scoped-root-config': G,
  'scoped-unclassified': L,
} as const;
const CONTRACT = {
  'contract-supervised': G,
  'contract-actor': G,
  'contract-protected-paths': G,
  'contract-trust': G,
  'contract-none': G,
  'main-red': G,
  'audit-debt': G,
  'contract-other': L,
} as const;
const SELECTION = {
  'contract-full': L,
  'docs-paths-undeclared': L,
  'test-runner-unavailable': L,
  'scoped-base-unavailable': L,
  'scoped-root-config': G,
  'scoped-unclassified': L,
  // A package-graph first check whose graph selects a majority, an unplaced path or nothing to run.
  'graph-full': G,
} as const;
export const FALLBACK_REASONS: Record<FallbackStage, Record<string, FallbackKind>> = {
  'first-check': REUSE,
  'main-race': REUSE,
  'scoped-recheck': SCOPED,
  'contract-gate': CONTRACT,
  selection: SELECTION,
};
/** Codes a runner may name on its selection (`selection.fallback`); the server keeps only these. */
export const selectionFallbackSchema = z.enum(
  Object.keys(SELECTION) as [keyof typeof SELECTION, ...(keyof typeof SELECTION)[]],
);
export type SelectionFallback = z.infer<typeof selectionFallbackSchema>;
/** The run fields a runner's selection pins: the code, and the reason text that names the fix
 * (Issue 7cb61db1), clipped to the run schema's bound. Unknown codes are dropped. */
export function runFallback(selection: { fallback?: unknown; reason?: unknown }) {
  const code = selectionFallbackSchema.safeParse(selection.fallback);
  if (!code.success) return {};
  const reason = typeof selection.reason === 'string' ? selection.reason.replace(/\s+/g, ' ').trim() : '';
  return { fallback: code.data, ...(reason ? { fallbackReason: reason.slice(0, 300) } : {}) };
}
/** An unknown code is a limitation: Forge fell back without saying why. */
export const fallbackKind = (stage: FallbackStage, reason: string): FallbackKind =>
  FALLBACK_REASONS[stage][reason] ?? 'limitation';

/** Runner side, on the selection it already pins: why the configured command could not be
 * narrowed or skipped. Explicit codes from the selector win; the rest follow from the gate. */
export function selectionFallback(input: {
  standard: boolean;
  gate: CheckGate | undefined;
  docsPaths: readonly string[] | undefined;
  paths: readonly string[];
  mainPaths: readonly string[] | null;
  /** A cohort recheck's per-basis sides; null when a basis State is unavailable. */
  members?: readonly unknown[] | null;
  selected: { scope: string; fallback?: unknown };
  /** The project's test runner for tests Forge must run itself (src/project-test-runner.ts). */
  testRunner?: () => 'available' | 'unavailable' | undefined;
}): SelectionFallback | undefined {
  const explicit = selectionFallbackSchema.safeParse(input.selected.fallback);
  if (explicit.success) return explicit.data;
  // A malformed manifest reads as unavailable too; never fails the plan.
  let runner: 'available' | 'unavailable' | undefined;
  try {
    runner = input.testRunner?.();
  } catch {
    runner = 'unavailable';
  }
  if (runner === 'unavailable') return 'test-runner-unavailable';
  if (input.selected.scope !== 'full') return undefined;
  if (isGraphFirstGate(input.gate)) return 'graph-full';
  if (scopedRecheckBase(input.gate) && !input.mainPaths) return 'scoped-base-unavailable';
  if (scopedRecheckPairs(input.gate) && !input.members) return 'scoped-base-unavailable';
  if (input.gate?.mode === 'contract') return 'contract-full';
  // An opaque command runs whole for a Markdown-only change unless its check declares docs paths.
  if (
    !input.standard &&
    !input.docsPaths?.length &&
    input.gate?.mode !== 'audit' &&
    input.gate?.mode !== 'probe' &&
    input.paths.length > 0 &&
    input.paths.every(markdownPath)
  )
    return 'docs-paths-undeclared';
  return undefined;
}

/** `gateFor`'s full-gate reasons (src/contract-gate-policy.ts) as stable codes. A run whose
 * project has the contract gate off, or an audit/probe/scoped run, is not a fallback. */
const CONTRACT_REASONS: Record<string, keyof typeof CONTRACT> = {
  'Supervised acceptance': 'contract-supervised',
  'Owner review, contributor or system acceptance': 'contract-actor',
  'Protected or unknown paths': 'contract-protected-paths',
  'Intent has no contract': 'contract-none',
  'Main is red': 'main-red',
  'Main audit unavailable or in debt': 'audit-debt',
};
const NOT_CONTRACT = new Set(['Contract gate is off', 'Full gate', 'No Candidate contracts']);
export function contractGateFallback(gate: CheckGate | undefined): string | undefined {
  if (gate?.mode !== 'full' || !gate.reason || NOT_CONTRACT.has(gate.reason)) return undefined;
  if (gate.reason in CONTRACT_REASONS) return CONTRACT_REASONS[gate.reason];
  // Trust demotions carry their own reason text (B2.6).
  return /trust|supervised/i.test(gate.reason) ? 'contract-trust' : 'contract-other';
}

export type FallbackCount = { stage: FallbackStage; reason: string; kind: FallbackKind; count: number };
/** Counts per (stage, reason), limitations first, then by count. */
export function countFallbacks(events: Iterable<{ stage: FallbackStage; reason: string }>) {
  const counts = new Map<string, FallbackCount>();
  for (const { stage, reason } of events) {
    const key = `${stage}\u0000${reason}`;
    const found = counts.get(key);
    if (found) found.count++;
    else counts.set(key, { stage, reason, kind: fallbackKind(stage, reason), count: 1 });
  }
  const byReason = [...counts.values()].sort(
    (a, b) =>
      Number(b.kind === 'limitation') - Number(a.kind === 'limitation') ||
      b.count - a.count ||
      a.stage.localeCompare(b.stage) ||
      a.reason.localeCompare(b.reason),
  );
  const limitations = byReason.filter(row => row.kind === 'limitation');
  return {
    byReason,
    limitations: limitations.reduce((sum, row) => sum + row.count, 0),
    /** One line naming every limitation reason seen, or null. Shown once per read, never polled. */
    warning: limitations.length
      ? `Forge fast-path limitations: ${limitations.map(row => `${row.stage} ${row.reason} ×${row.count}`).join(', ')} (metrics totals.fallbacks; docs/operations.md#fallback-reasons)`
      : null,
  };
}
