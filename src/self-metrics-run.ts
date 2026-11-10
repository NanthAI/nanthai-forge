// SPDX-License-Identifier: Apache-2.0
import { hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';
import { hostedRunReuseKey } from './self-metrics-reuse-key.js';
import { isScopedRecheck } from './scoped-recheck-policy.js';
import { runFlakes } from './self-metrics-flakes.js';
import { contractGateFallback } from './fallback-reasons.js';

/** The exact metric fields, shared by legacy source reads and transactional read projections. */
export function metricRunRow(run: HostedCheckRun) {
  return {
    id: run.id,
    at: run.at,
    endedAt: run.endedAt,
    status: run.status,
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
    flaky: runFlakes(run) ?? null,
    selectionFallback: run.fallback ?? null,
    gateFallback: contractGateFallback(run.gate) ?? null,
    auditRunnerSeconds:
      run.gate?.mode === 'audit' && hostedCheckTerminal(run) ? (run.execution?.seconds ?? null) : null,
  };
}
