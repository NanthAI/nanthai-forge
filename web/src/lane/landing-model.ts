// SPDX-License-Identifier: Apache-2.0
import type { HostedLandingState, HostedLandingAttempt } from '../../../src/hosted-landing';
import type { HostedCheckRun } from '../../../src/hosted-check';
import type { HostedAcceptance } from '../../../src/hosted-acceptance';
import type { Tone } from '../ui/status';
export type LandingRead = {
  request: HostedLandingState;
  attempt: HostedLandingAttempt;
  run: HostedCheckRun | null;
  pendingAttempt: { at: string; number: number } | null;
  receipt: HostedAcceptance | null;
  ahead: string | null;
  reverseCandidateId?: string | null;
  message?: string | null;
};
export type LandingState = {
  title: string;
  label: string;
  tone: Tone;
  pending: boolean;
  kind:
    | 'ready'
    | 'pending'
    | 'landed'
    | 'check'
    | 'conflict'
    | 'not-run'
    | 'superseded'
    | 'cancelled'
    | 'rejected';
};
export function landingState(read?: LandingRead | null, superseded = false): LandingState {
  const observation = read?.request.observation;
  if (observation?.state === 'landed')
    return { title: 'Landed', label: 'Accepted', tone: 'passed', pending: false, kind: 'landed' };
  if (superseded || observation?.state === 'superseded')
    return { title: 'Not landed', label: 'Superseded', tone: 'stale', pending: false, kind: 'superseded' };
  if (!read) return { title: 'Your decision', label: 'Ready', tone: 'passed', pending: false, kind: 'ready' };
  if (observation?.state === 'pending') {
    const reason = observation.pendingReason;
    return {
      title: 'Landing',
      label:
        reason === 'pending-infra'
          ? 'Check waiting for a runner'
          : reason === 'checking'
            ? 'Checking'
            : read.request.phase === 'ready'
              ? 'Landing'
              : reason === 'waiting-for-review'
                ? 'Waiting for review'
                : 'Queued',
      tone:
        reason === 'pending-infra'
          ? 'stale'
          : reason === 'checking' || read.request.phase === 'ready'
            ? 'running'
            : 'waiting',
      pending: true,
      kind: 'pending',
    };
  }
  const cause = observation?.cause;
  const kind =
    cause === 'conflict' || read.request.error?.code === 'COMPOSITION_CONFLICT'
      ? 'conflict'
      : cause === 'check-failed' || read.request.error?.code === 'CHECK_FAILED'
        ? 'check'
        : cause === 'infra' || read.request.error?.code === 'CHECK_NOT_PASSED'
          ? 'not-run'
          : read.request.error?.code === 'LANDING_CANCELLED'
            ? 'cancelled'
            : 'rejected';
  return {
    title: 'Not landed',
    label:
      kind === 'conflict'
        ? 'Conflict'
        : kind === 'check'
          ? 'Check failed'
          : kind === 'not-run'
            ? 'Not run'
            : kind === 'cancelled'
              ? 'Cancelled'
              : 'Not landed',
    tone: kind === 'conflict' ? 'conflict' : kind === 'check' ? 'failed' : 'stale',
    pending: false,
    kind,
  };
}
export function mainAncestryGate(input: {
  included?: boolean | null;
  indexedMain?: string | null;
  currentMain?: string | null;
}) {
  const ok =
    input.included === true && input.currentMain !== undefined && input.currentMain === input.indexedMain;
  return {
    ok,
    title: ok
      ? 'Includes everything on main'
      : input.included === false
        ? 'Needs an update from main'
        : 'Main ancestry unavailable',
    body: '',
  };
}
export const clockTime = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export function elapsed(from: string, to?: string | null) {
  if (!to) return '';
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export function landingRunSummary(
  run: HostedCheckRun,
): import('../../../src/work-hosted-summary').HostedRunSummary {
  return {
    id: run.id,
    viewId: run.request.candidateId,
    head: run.request.expectedHead,
    main: { head: null, included: null },
    checkId: run.check.id,
    checkName: run.check.name,
    cause: undefined,
    status:
      run.status === 'preparing' || run.status === 'dispatching' || run.status === 'unknown'
        ? 'running'
        : run.status,
    startedAt: run.at,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    exitCode: run.exitCode,
  };
}

/** A newer save resumes work without changing the old Candidate's source pins. */
export function feedbackWorking(
  sent: boolean,
  inputs: readonly { laneId: string; head: string }[],
  lanes: readonly { id: string; head: string }[],
) {
  return (
    sent &&
    inputs.some(input => {
      const lane = lanes.find(lane => lane.id === input.laneId);
      return lane && lane.head !== input.head;
    })
  );
}
