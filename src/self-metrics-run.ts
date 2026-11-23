// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { hostedCheckTerminal, type HostedCheckRun, type CheckCause } from './hosted-check.js';
import { hostedRunReuseKey } from './self-metrics-reuse-key.js';
import { isScopedRecheck } from './scoped-recheck-policy.js';
import { runFlakes, type RunFlakes } from './self-metrics-flakes.js';
import { contractGateFallback } from './fallback-reasons.js';
import { auditCoverageSchema } from './landing-audit-cadence.js';

/** The exact metric fields, shared by legacy source reads and transactional read projections. */
export function metricRunRow(
  run: HostedCheckRun,
  reportFlakes?: unknown,
  cause?: CheckCause,
  evidence?: { auditDonor?: boolean | undefined; auditCoverage?: string | undefined },
) {
  const coverage = evidence?.auditCoverage
    ? auditCoverageSchema.parse(JSON.parse(evidence.auditCoverage))
    : undefined;
  return {
    id: run.id,
    at: run.at,
    endedAt: run.endedAt,
    status: run.status,
    ...(cause === undefined ? {} : { cause }),
    ...(evidence?.auditDonor === undefined ? {} : { auditDonor: evidence.auditDonor }),
    head: run.request.expectedHead,
    started: !!run.executionId,
    runnerMinutes: run.cost.status === 'observed' && run.cost.seconds !== null ? run.cost.seconds / 60 : null,
    inputPin: run.candidate?.inputs ?? null,
    reuseKey: hostedRunReuseKey(run.plan),
    fullSuite:
      (run.gate ?? run.request.gate)
        ? ['full', 'audit'].includes((run.gate ?? run.request.gate)!.mode) ||
          (run.gate ?? run.request.gate)!.effective === 'full'
        : null,
    ...(isScopedRecheck(run.gate) ? { scopedRecheck: true as const } : {}),
    ...(coverage
      ? { auditCoverage: { landings: coverage.landings, threshold: coverage.cadence.effective.landings } }
      : {}),
    // A main audit, whatever its state: Stats leaves audits out of both sides (Item a61d3c91). auditRunnerSeconds
    // below is set only for a terminal audit with execution seconds, so it cannot mark one on its own.
    ...((run.gate ?? run.request.gate)?.mode === 'audit' ? { audit: true as const } : {}),
    flaky:
      typeof reportFlakes === 'string'
        ? (JSON.parse(reportFlakes) as RunFlakes | null)
        : (runFlakes(run) ?? null),
    selectionFallback: run.fallback ?? null,
    gateFallback: contractGateFallback(run.gate) ?? null,
    auditRunnerSeconds:
      run.gate?.mode === 'audit' && hostedCheckTerminal(run) ? (run.execution?.seconds ?? null) : null,
  };
}
