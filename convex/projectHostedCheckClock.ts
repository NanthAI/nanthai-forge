// SPDX-License-Identifier: Apache-2.0
import type { HostedCheckRun } from '../src/hosted-check';

type CheckClock = { dispatchedAt?: number; startedAt?: number; endedAt?: number };

// Server-only: the check's wire and proof objects keep their original shape.
const clocks = new WeakMap<HostedCheckRun, CheckClock>();

export function hostedCheckClock(run: HostedCheckRun, retained?: CheckClock) {
  if (retained) clocks.set(run, retained);
  return clocks.get(run);
}

export function markCheckDispatch(run: HostedCheckRun, dispatchedAt: number) {
  hostedCheckClock(run, { ...hostedCheckClock(run), dispatchedAt });
}

export function observeCheckStart(run: HostedCheckRun, start: string) {
  const startedAt = Date.parse(start);
  const clock = hostedCheckClock(run);
  const dispatch = clock?.dispatchedAt ?? run.actions?.reservedAt;
  if (
    Number.isFinite(startedAt) &&
    (dispatch === undefined || startedAt >= Math.floor(dispatch / 1000) * 1000) &&
    (clock?.startedAt === undefined || startedAt < clock.startedAt)
  )
    hostedCheckClock(run, { ...clock, startedAt });
}

export function observeCheckEnd(run: HostedCheckRun, end: unknown) {
  if (typeof end !== 'string') return;
  const endedAt = Date.parse(end);
  const clock = hostedCheckClock(run);
  if (
    Number.isFinite(endedAt) &&
    endedAt >= (clock?.startedAt ?? clock?.dispatchedAt ?? run.actions?.reservedAt ?? 0) &&
    (clock?.endedAt === undefined || endedAt > clock.endedAt)
  )
    hostedCheckClock(run, { ...clock, endedAt });
}

/** Completed full checks only. Provider timestamps take precedence over callback arrival. */
export function fullCheckWall(run: HostedCheckRun) {
  if (run.status !== 'passed' && run.status !== 'failed') return;
  const gate = run.gate?.effective ?? run.gate?.mode;
  if (gate !== undefined && gate !== 'full' && gate !== 'audit') return;
  const clock = hostedCheckClock(run);
  const startedAt = clock?.startedAt ?? NaN;
  const endedAt = clock?.endedAt ?? Date.parse(run.endedAt ?? '');
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt)
    return endedAt - startedAt;
}
