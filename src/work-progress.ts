// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';

type Identity = { operationId?: string; actor?: string; runId?: string; phase?: string };
type Progress = Identity & {
  began: number;
  phaseBegan: number;
  currentPhase?: string;
  last: Map<string, { key: string; at: number }>;
};
const reporter = new AsyncLocalStorage<(phase: string) => boolean | void>();
/** Observe existing wait-loop callbacks without creating another poller. */
export function withWorkProgressReporter<T>(report: (phase: string) => boolean | void, run: () => T): T {
  return reporter.run(report, run);
}
export function observeWorkProgress() {
  reporter.getStore()?.('observation');
}
const context = new AsyncLocalStorage<Progress>();
export function withWorkProgress<T>(identity: Identity, run: () => T): T {
  const previous = context.getStore();
  const now = Date.now();
  return context.run(
    {
      began: now,
      phaseBegan: now,
      last: new Map(),
      ...previous,
      ...identity,
      ...(identity.phase && identity.phase !== previous?.phase
        ? { phaseBegan: now, currentPhase: identity.phase }
        : {}),
    },
    run,
  );
}
export const workProgressIdentity = (): Identity => {
  const value = context.getStore();
  return value
    ? {
        ...(value.operationId ? { operationId: value.operationId } : {}),
        ...(value.actor ? { actor: value.actor } : {}),
        ...(value.runId ? { runId: value.runId } : {}),
        ...(value.phase ? { phase: value.phase } : {}),
      }
    : {};
};
/** Call from polling loops, including synchronous lock admission. No timer can
 * report while an Atomics.wait loop owns the JS thread. */
export function workProgress(phase: string, details: string, key = phase) {
  if (reporter.getStore()?.(phase)) return;
  const scope = context.getStore(),
    now = Date.now(),
    // A fresh retry run must announce itself; lock-holder diagnostics stay once per lock.
    progressKey = scope?.runId && phase !== 'waiting for lock' ? `${key}:${scope.runId}` : key,
    previous = scope?.last.get(progressKey);
  if (scope && scope.currentPhase !== phase) {
    scope.currentPhase = phase;
    scope.phaseBegan = now;
  }
  const lock = phase === 'waiting for lock';
  if (previous && (lock || previous.key === details) && now - previous.at < 5000) return;
  scope?.last.set(progressKey, { key: details, at: now });
  const message =
    lock && previous ? `progress ${details.slice(details.indexOf('queue position='))}` : details;
  const identity = scope?.operationId ? `operation=${scope.operationId} ` : '';
  process.stderr.write(
    `${phase}: ${identity}${scope?.runId ? `run=${scope.runId} ` : ''}${message} elapsed=${Math.floor((now - (scope?.phaseBegan ?? now)) / 1000)}s totalAge=${Math.floor((now - (scope?.began ?? now)) / 1000)}s\n`.replace(
      /[\r\n]+(?=.)/g,
      ' ',
    ),
  );
}
