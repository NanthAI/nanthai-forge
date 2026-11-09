// SPDX-License-Identifier: Apache-2.0
import type { HostedLandingState, HostedLandingAttempt } from '../../../src/hosted-landing';
import type { HostedCheckRun } from '../../../src/hosted-check';
import type { HostedAcceptance } from '../../../src/hosted-acceptance';
import type { Tone } from '../ui/status';
import { landingStateOf, type LandingStateName } from '../../../src/landing-state';
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
  /** The shared landing state (src/landing-state.ts); null before any submission. */
  state: LandingStateName | null;
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
const kinds = {
  queued: 'pending',
  checking: 'pending',
  'waiting-for-runner': 'pending',
  landing: 'pending',
  'held-review': 'pending',
  'held-dependency': 'pending',
  'held-main-red': 'pending',
  landed: 'landed',
  conflict: 'conflict',
  'check-failed': 'check',
  'not-run': 'not-run',
  cancelled: 'cancelled',
  'stale-head': 'rejected',
  rejected: 'rejected',
  superseded: 'superseded',
  unknown: 'rejected',
} as const satisfies Record<LandingStateName, LandingState['kind']>;
/** The review page's reading of a submission: words, tone and state from the shared landing derive.
 * Before any submission the pill is green "Ready" only with a passing check on this Candidate
 * (web W5): a failed or missing check says so, and the person can still decide. */
export function landingState(
  read?: LandingRead | null,
  superseded = false,
  checkStatus?: string | null,
): LandingState {
  if (superseded && read?.request.observation.state !== 'landed')
    return {
      title: 'Not landed',
      label: 'Superseded',
      tone: 'stale',
      pending: false,
      kind: 'superseded',
      state: 'superseded',
    };
  if (!read) {
    const label =
      checkStatus === 'passed' ? 'Ready' : checkStatus === 'failed' ? 'Check failed' : 'Needs a check';
    const tone = checkStatus === 'passed' ? 'passed' : checkStatus === 'failed' ? 'failed' : 'waiting';
    return { title: 'Your decision', label, tone, pending: false, kind: 'ready', state: null };
  }
  const view = landingStateOf(read.request);
  const kind = kinds[view.state];
  return {
    title: kind === 'landed' ? 'Landed' : view.pending ? 'Landing' : 'Not landed',
    label: view.label,
    tone: view.tone,
    pending: view.pending,
    kind,
    state: view.state,
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
