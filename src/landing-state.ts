// SPDX-License-Identifier: Apache-2.0
import { landingHold, type LandingHold } from './hosted-landing-hold.js';
import type { StateTone } from './check-run-state.js';
import type { PendingReason, SubmissionCause } from './landing-submission-state.js';
/**
 * One reading of a submission (Issue 68361cd5, landing machines 1-2, web W1/W2): the web landing
 * page, the cockpit queue facts, CLI JSON and MCP all name the same state, word and next step.
 * Pure: it reads the record already in hand (hosted `observation`/`phase`/`error`, or the shared
 * submission projection's `state`/`pendingReason`/`cause`) and never drives landing.
 */
export type LandingStateName =
  | 'queued'
  | 'checking'
  | 'waiting-for-runner'
  | 'landing'
  | 'held-review'
  | 'held-dependency'
  | 'held-main-red'
  | 'landed'
  | 'conflict'
  | 'check-failed'
  | 'not-run'
  | 'cancelled'
  | 'stale-head'
  | 'rejected'
  | 'superseded'
  | 'unknown';
type View = { label: string; tone: StateTone; pending: boolean; nextStep: string };
const views = {
  queued: {
    label: 'Queued',
    tone: 'waiting',
    pending: true,
    nextStep: 'Waits for its turn on main; it lands or stops by itself. Nothing to do.',
  },
  checking: {
    label: 'Checking',
    tone: 'running',
    pending: true,
    nextStep: 'The check is running on this Candidate; wait for its result.',
  },
  'waiting-for-runner': {
    label: 'Waiting for a runner',
    tone: 'waiting',
    pending: true,
    nextStep: 'No check machine has picked it up yet; the code was not judged. Wait; Forge retries.',
  },
  landing: {
    label: 'Landing',
    tone: 'running',
    pending: true,
    nextStep: 'The check passed; it is being accepted into main. Wait.',
  },
  'held-review': {
    label: 'Waiting for review',
    // Not green: the check passed, but nothing landed until a person accepts it.
    tone: 'waiting',
    pending: true,
    nextStep: 'The check passed; a person accepts it. Hand the owner the approve link and keep waiting.',
  },
  'held-dependency': {
    label: 'Waiting for parent',
    tone: 'waiting',
    pending: true,
    nextStep: 'Lands after the Candidate it depends on; no action needed.',
  },
  'held-main-red': {
    label: 'Held: main is red',
    tone: 'waiting',
    pending: true,
    nextStep:
      "Main's full check is red; this landing resumes by itself when main is green again. Nothing to do in this Lane; fixing main releases it.",
  },
  landed: { label: 'Landed', tone: 'passed', pending: false, nextStep: 'On main; nothing to do.' },
  conflict: {
    label: 'Conflict',
    tone: 'conflict',
    pending: false,
    nextStep: 'Resolve the conflict in the Lane, save and land again.',
  },
  'check-failed': {
    label: 'Check failed',
    tone: 'failed',
    pending: false,
    nextStep: 'Read the failing output, fix in the same Lane and land again.',
  },
  'not-run': {
    label: 'Not run',
    tone: 'plain',
    pending: false,
    nextStep: 'The check could not run; the code was not judged. Land again to retry.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'plain',
    pending: false,
    nextStep: 'This landing was withdrawn; land again when ready.',
  },
  'stale-head': {
    label: 'Not landed',
    tone: 'stale',
    pending: false,
    nextStep: 'Main or the Lane moved after submission; land again from the current head.',
  },
  rejected: {
    label: 'Not landed',
    tone: 'stale',
    pending: false,
    nextStep: 'Policy did not accept it; read the error, fix and land again.',
  },
  superseded: {
    label: 'Superseded',
    tone: 'stale',
    pending: false,
    nextStep: 'A later save replaced this submission; land the current head.',
  },
  unknown: {
    label: "Can't confirm",
    tone: 'stale',
    pending: false,
    nextStep: "Can't confirm this landing's state; read its status before acting.",
  },
} as const satisfies Record<LandingStateName, View>;

/** Fields any landing record carries: hosted state JSON, or the submission projection. */
export type LandingRecord = {
  id?: string;
  operationId?: string;
  phase?: string | null;
  observation?: { state?: string; pendingReason?: string | null; cause?: string | null } | null;
  error?: { code?: string; message?: string } | null;
  /** Projection-shaped records (src/landing-submission-state.ts) carry these at the top level. */
  state?: string;
  pendingReason?: string | null;
  cause?: string | null;
};
export type LandingView = View & { state: LandingStateName; hold: LandingHold | null };

function pendingState(reason: string | null | undefined, phase: string | null | undefined): LandingStateName {
  switch (reason) {
    case 'pending-infra':
      return 'waiting-for-runner';
    case 'checking':
      return 'checking';
    case 'waiting-for-review':
      return 'held-review';
    case 'waiting-for-dependency':
      return 'held-dependency';
    case 'queued':
    case null:
    case undefined:
      return phase === 'ready' ? 'landing' : 'queued';
    default:
      return 'unknown';
  }
}

function stateOf(record: LandingRecord): LandingStateName {
  const observed = record.observation ?? record;
  const code = record.error?.code;
  switch (observed.state) {
    case 'landed':
      return 'landed';
    case 'superseded':
      return 'superseded';
    case 'pending':
      // The gate parks a ready entry while main is red (B2/B3): held, not landing or queued.
      return code === 'MAIN_RED' ? 'held-main-red' : pendingState(observed.pendingReason, record.phase);
    case 'terminal-failed': {
      const cause = observed.cause;
      if (cause === 'conflict' || code === 'COMPOSITION_CONFLICT') return 'conflict';
      if (cause === 'check-failed' || code === 'CHECK_FAILED') return 'check-failed';
      if (cause === 'infra' || code === 'CHECK_NOT_PASSED') return 'not-run';
      if (code === 'LANDING_CANCELLED') return 'cancelled';
      return cause === 'stale-head' ? 'stale-head' : 'rejected';
    }
    default:
      return 'unknown';
  }
}

/** The one landing state, word, tone and next step; a hold names its stored reason. No reads. */
export function landingStateOf(record: LandingRecord | null | undefined, laneId?: string): LandingView {
  const state = record ? stateOf(record) : 'unknown';
  const hold = record ? landingHold(record, laneId) : null;
  const view = views[state];
  return { state, ...view, nextStep: hold?.next ?? view.nextStep, hold };
}

/** Additive JSON for CLI and MCP replies: the same state word and next step people see. */
export const landingStateField = (record: LandingRecord | null | undefined, laneId?: string) => {
  const { state, label, nextStep } = landingStateOf(record, laneId);
  return { state, label, nextStep };
};

/** The outcome a stored `superseded` observation records: it ended without landing (stale head).
 * Readers present it instead of failing (landing B1). */
export const supersededOutcome = {
  state: 'terminal-failed',
  pendingReason: null,
  cause: 'stale-head',
} as const satisfies {
  state: 'terminal-failed';
  pendingReason: PendingReason | null;
  cause: SubmissionCause;
};
