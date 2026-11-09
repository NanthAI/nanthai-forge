// SPDX-License-Identifier: Apache-2.0
/**
 * One check-run status vocabulary for every reader: web, CLI, MCP and receipts (Issue 68361cd5,
 * checks machine 1 / web W13). The stored `status` stays on the wire unchanged; this module names
 * what it means. Hosted runs add `dispatching` and `unknown`; local Work runs add
 * `runner-budget-exhausted`. Each predicate keeps the member list its callers already used, so
 * differences stay visible here instead of in eleven hand-written lists.
 */
export const checkRunStatuses = [
  'queued',
  'preparing',
  'dispatching',
  'running',
  'unknown',
  'passed',
  'failed',
  'cancelled',
  'interrupted',
  'runner-unavailable',
  'runner-budget-exhausted',
] as const;
export type CheckRunStatus = (typeof checkRunStatuses)[number];

const set = (...items: CheckRunStatus[]): ReadonlySet<string> => new Set(items);
/** Ended: a verdict, a stop, or no runner. Every other status (including `unknown`) is still open. */
const terminal = set(
  'passed',
  'failed',
  'cancelled',
  'interrupted',
  'runner-unavailable',
  'runner-budget-exhausted',
);
/** Local Work runs: a runner holds them (local runs never dispatch or lose a dispatch). */
const localActive = set('queued', 'preparing', 'running');
/** The machine, not the code: no runner, no budget, or the runner died mid-run. */
const infrastructure = set('interrupted', 'runner-unavailable', 'runner-budget-exhausted');
/** Never started: no runner could take it. The code was not judged. */
const neverRan = set('runner-unavailable', 'runner-budget-exhausted');

/** Ended with a stored verdict or stop (passed, failed, cancelled, interrupted, runner-*); an
 * unrecognised status is not terminal. */
export const checkTerminal = (status: string) => terminal.has(status);
/** A local runner still holds it (queued, preparing, running). */
export const checkActive = (status: string) => localActive.has(status);
/** Infrastructure stopped it (interrupted, runner-unavailable, runner-budget-exhausted). */
export const checkInfrastructure = (status: string) => infrastructure.has(status);
/** No runner could start it (runner-unavailable, runner-budget-exhausted). */
export const checkNeverRan = (status: string) => neverRan.has(status);
/** Terminal and not passed: failed, cancelled, interrupted or never ran. */
export const checkUnsuccessful = (status: string) => checkTerminal(status) && status !== 'passed';
/** The code failed or the machine stopped it; a person's cancel is excluded. */
export const checkFailedOrInfrastructure = (status: string) =>
  status === 'failed' || checkInfrastructure(status);

export type StateTone =
  | 'active'
  | 'waiting'
  | 'stale'
  | 'conflict'
  | 'passed'
  | 'failed'
  | 'running'
  | 'plain';
/** What a stored status means once its recorded dispatch and verdict facts are read. `unknown` on
 * the wire has four meanings, each named: a lost dispatch reply, a refused (rate-limited) dispatch,
 * a controller that could not confirm after recovery, and a pass waiting for every shard. */
export type CheckRunState =
  | 'queued'
  | 'preparing'
  | 'dispatching'
  | 'running'
  | 'awaiting-verdict'
  | 'dispatch-unconfirmed'
  | 'dispatch-refused'
  | 'recovery-unconfirmed'
  | 'shards-unconfirmed'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'runner-unavailable'
  | 'runner-budget-exhausted'
  | 'unknown';
type View = { label: string; tone: StateTone; nextStep: string };
const views = {
  queued: { label: 'Queued', tone: 'waiting', nextStep: 'Waits for a check machine; nothing to do.' },
  preparing: { label: 'Preparing', tone: 'running', nextStep: 'A runner is preparing the check; wait.' },
  dispatching: { label: 'Starting', tone: 'running', nextStep: 'The check is being dispatched; wait.' },
  running: { label: 'Checking', tone: 'running', nextStep: 'The check is running; wait for its result.' },
  'awaiting-verdict': {
    label: 'Checking',
    tone: 'running',
    nextStep: "Every shard passed; waiting for the provider's own conclusion. Wait.",
  },
  'dispatch-unconfirmed': {
    label: "Can't confirm",
    tone: 'stale',
    nextStep: "Can't confirm the check started (the dispatch reply was lost). Forge looks it up; wait.",
  },
  'dispatch-refused': {
    label: 'Dispatch refused',
    tone: 'waiting',
    nextStep: 'The CI provider refused the dispatch (rate limit). Forge retries after its wait; wait.',
  },
  'recovery-unconfirmed': {
    label: "Can't confirm",
    tone: 'stale',
    nextStep: "Can't confirm the check started after recovery. The run watchdog settles it; wait.",
  },
  'shards-unconfirmed': {
    label: "Can't confirm",
    tone: 'stale',
    nextStep: "Can't confirm the pass yet: not every shard has reported. Wait for the rest.",
  },
  passed: { label: 'Passed', tone: 'passed', nextStep: 'The check passed on exactly this code.' },
  failed: {
    label: 'Failed',
    tone: 'failed',
    nextStep: 'Read the failing output, fix, save and check again.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'plain',
    nextStep: 'The check was cancelled; run it again when ready.',
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'plain',
    nextStep: 'The runner stopped mid-run; the code was not judged. Run the check again.',
  },
  'runner-unavailable': {
    label: 'Not run',
    tone: 'plain',
    nextStep: 'No runner was available; the code was not judged. Run the check again when one is.',
  },
  'runner-budget-exhausted': {
    label: 'Not run',
    tone: 'plain',
    nextStep: 'The runner budget ran out; the code was not judged. Raise the budget or retry later.',
  },
  unknown: {
    label: "Can't confirm",
    tone: 'stale',
    nextStep: "Can't confirm this check's status (this client does not know it). Read the run before acting.",
  },
} as const satisfies Record<CheckRunState, View>;

export type CheckRunFacts = {
  status: string;
  /** Hosted direct-Actions dispatch facts, when recorded. */
  actions?: { outcome?: string; verdictPending?: boolean } | null | undefined;
  executionId?: string | null;
  recoveryUsed?: boolean;
};
export type CheckRunView = View & { state: CheckRunState; status: string; terminal: boolean };

function stateOf(run: CheckRunFacts): CheckRunState {
  const status = run.status as CheckRunStatus;
  switch (status) {
    case 'unknown':
      // A passed callback before every shard counted keeps the bound execution (callbacks).
      if (run.executionId) return 'shards-unconfirmed';
      if (run.actions?.outcome === 'rejected') return 'dispatch-refused';
      if (run.actions) return 'dispatch-unconfirmed';
      return run.recoveryUsed ? 'recovery-unconfirmed' : 'dispatch-unconfirmed';
    case 'running':
      return run.actions?.verdictPending ? 'awaiting-verdict' : 'running';
    case 'queued':
    case 'preparing':
    case 'dispatching':
    case 'passed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'runner-unavailable':
    case 'runner-budget-exhausted':
      return status;
    default: {
      // A status this client does not know yet is never success, failure or running.
      const unexpected: never = status;
      void unexpected;
      return 'unknown';
    }
  }
}

/** The one reading of a recorded run: state, people's word, tone and the next step. No reads. */
export function checkRunState(run: CheckRunFacts): CheckRunView {
  const state = stateOf(run);
  return { state, status: run.status, terminal: checkTerminal(run.status), ...views[state] };
}
