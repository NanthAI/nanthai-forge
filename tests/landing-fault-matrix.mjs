// SPDX-License-Identifier: Apache-2.0
// Issue d910db6b: the landing step x fault matrix. A step is the scheduled task
// that runs plus the landing step its entry is at, observed on healthy hosted
// landings (never a hand-kept list of task names). Faults are in-process: a
// task that throws commits nothing and Convex does not retry it.
import { states } from './hosted-landing-batches-fixture.mjs';

/** The landing steps of the brief, in pipeline order. submit, the CI callback
 * delivery and wait are client calls, covered by their own cases. */
export const LANDING_STEPS = [
  'submit',
  'admission',
  'compose',
  'reserve',
  'check-callback',
  'publish',
  'receipt',
  'wait',
];
/** Healthy landings whose scheduled steps form the matrix. */
export const SCENARIOS = {
  'serial agent finish': { count: 1, batching: false, requestCheck: true },
  'batched cohort': { count: 2, batching: true },
  'pre-queue Lane check': { count: 2, batching: true, admissionCheck: 'full' },
};
/** Outcome of a permanent fault (the step fails every time), per step key. `[]`:
 * the landing still lands (another driver owns it). Codes: every entry lands or
 * ends with one of these typed codes. A key missing here is a new landing step
 * without coverage, and fails the build. Transient faults must always land. */
export const PERMANENT = {
  'projectHostedLandingDriver:drive@admission': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedFinishDriver:drive@admission': [],
  'projectHostedLandingDriver:checkWake@admission': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedFinishDriver:drive@compose': ['LANDING_DRIVER_EXHAUSTED'],
  'projectConvexSource:dispatch@compose': ['SOURCE_RETRY_EXHAUSTED'],
  'projectConvexSource:step@compose': ['SOURCE_RETRY_EXHAUSTED'],
  'projectHostedComposeJobs:complete@compose': ['SOURCE_RETRY_EXHAUSTED'],
  'projectHostedLandingDriver:drive@reserve': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedLandingDriver:drive@check-callback': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedLandingDriver:checkWake@check-callback': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedFinishDriver:drive@publish': ['LANDING_DRIVER_EXHAUSTED'],
  'projectHostedLandingDriver:checkWake@publish': [],
  'projectHostedLandingWouldConflict:mark@publish': [],
  // Accepted work is never rewound. A lost completion tick is replayed once by
  // its stall guard; failing again it ends as a typed status (Issue 13c63abe).
  'projectHostedAcceptance:complete@receipt': [],
  'projectHostedFinishDriver:drive@receipt': [],
  'projectHostedLandingWouldConflict:mark@receipt': [],
};

const settled = state => state.phase === 'landed' || state.phase === 'terminal-failed';
const order = ['admission', 'compose', 'reserve', 'check-callback', 'publish', 'receipt'];
function entryStep(f, state) {
  if (settled(state)) return 'receipt';
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  if (row?.admission && row.admission.status !== 'passed') return 'admission';
  const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === state.id);
  const batchId = state.batchId;
  const batch = batchId
    ? [...f.tables.projectHostedLandingBatches.values()]
        .map(r => JSON.parse(r.value))
        .find(b => b.id === batchId)
    : undefined;
  if (
    state.phase === 'composing' ||
    (finish && JSON.parse(finish.value).pending) ||
    batch?.phase === 'composing'
  )
    return 'compose';
  if (state.phase === 'queued') return 'reserve';
  if (state.phase === 'checking') return 'check-callback';
  return 'publish';
}
/** Source and receipt tasks name their step; the rest take the step of the entry
 * they drive, or of the least advanced live entry for a project-level driver. */
export function stepKey(f, task) {
  if (task.name.startsWith('projectConvexSource') || task.name.startsWith('projectHostedComposeJobs:'))
    return `${task.name}@compose`;
  if (task.name === 'projectHostedLandingDesired:drive') return `${task.name}@compose`;
  if (task.name.startsWith('projectHostedAcceptance:')) return `${task.name}@receipt`;
  const all = states(f);
  const own = all.filter(s => s.id === task.args[0]?.submissionId);
  const live = (own.length ? own : all.filter(s => !settled(s))).map(s => entryStep(f, s));
  const step = live.length ? order[Math.min(...live.map(s => order.indexOf(s)))] : 'receipt';
  return `${task.name}@${step}`;
}

const lose = (f, task) => {
  f.advanceClock?.(Math.max(0, task.scheduledTime - Date.now()));
  f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
};
/** Run until no task is left. CI passes at once, so no step waits on a slow
 * check and a healthy run never wakes the supervisor. `fault(key)` loses the task. */
export async function runLanding(f, fault = () => false, max = 600) {
  const started = Date.now(),
    keys = new Map();
  let ticks = 0;
  for (; ; ticks++) {
    if (ticks >= max) throw new Error(`no bounded end: ${JSON.stringify(states(f).map(s => s.phase))}`);
    for (const run of f.runs().filter(r => r.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (!task) break;
    const key = stepKey(f, task);
    keys.set(key, (keys.get(key) ?? 0) + 1);
    if (fault(key)) lose(f, task);
    else await f.execute(task);
  }
  return { ticks, elapsedMs: Date.now() - started, keys };
}
