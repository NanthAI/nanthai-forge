// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { ticketState } from '../landing-ticket-fixture.mjs';
import { moduleUrl } from '../convex-module.mjs';
import { hostedCheckTerminal } from '../../dist/hosted-check.js';
const { holdsLandingOrder, olderLandingAhead } = await import(
  moduleUrl('../convex/projectHostedLandingOrder.ts')
);
const terminal = row => ['landed', 'terminal-failed'].includes(row.phase);
export const requestRows = f => [...f.tables.projectHostedLandingRequests.values()];
export const armed = (f, id) =>
  Boolean(id && ['pending', 'inProgress'].includes(f.tables._scheduled_functions.get(id)?.state.kind));
export const pendingClaim = (f, id) =>
  [...f.tables.projectHostedFinishes.values()].some(
    row => row.submissionId === id && armed(f, row.wake?.taskId),
  );
/** L5b's window (Item 9a04d916): one pre-queue check wall. A bench full check takes about
 * 3 min (t27456: 163 s); 5 min leaves room for compose and dispatch and stays well under
 * the 15-minute stall alarm, which is the silence L5b exists to reject. */
export const CHECK_WALL_MS = 5 * 60_000;
const dueBy = (f, id, by) => armed(f, id) && f.tables._scheduled_functions.get(id).scheduledTime <= by;
/** A finish wake that will act within one check wall. A far-future wake (an
 * order-hold expiry, a reuse lease) is as silent as the alarm. */
const claimDue = (f, id, by) =>
  [...f.tables.projectHostedFinishes.values()].some(
    row => row.submissionId === id && dueBy(f, row.wake?.taskId, by),
  );

/** Run the production decision with mutation/scheduler access removed. Inspection
 * must never repair the state it is intended to check. Fixture reads are not
 * included in production cost measurements. */
export async function decide(f, row) {
  return f.runAcceptance(
    'queueInvariantRead',
    async ctx => {
      const readonly = {
        db: { get: ctx.db.get.bind(ctx.db), query: ctx.db.query.bind(ctx.db) },
      };
      return olderLandingAhead(readonly, row, ticketState(f, row), Date.now(), []);
    },
    {},
  );
}

/** The stall alarm's window (LANDING_STALL_MS): a finish wake due later than this is a hold-expiry
 * timer, not a driver, for L1. */
export const STALL_MS = 15 * 60_000;
const armedTasks = (f, name, match) =>
  [...f.tables._scheduled_functions.values()].some(
    task => armed(f, task._id) && task.name === name && match(task.args?.[0] ?? {}),
  );
/** A check that still owns its own progress (review e7137e30 finding 1): the entry is checking a
 * non-terminal run, and that run has a bounded driver: an armed verdict confirmation, an armed
 * execution watchdog once the provider accepted the dispatch, or a runner lease with its exact
 * armed expiry (function, fence and until match). Any other task that names the run, or
 * a bare lease timestamp, drives nothing. */
export function liveCheck(f, row, now = Date.now()) {
  if (row.phase !== 'checking' || !row.runId) return false;
  const saved = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === row.runId);
  const run = saved && JSON.parse(saved.value);
  if (!run || hostedCheckTerminal(run)) return false;
  if (armed(f, run.actions?.confirm)) return true;
  if (run.actions?.outcome === 'accepted' && armed(f, run.actions.watchdog)) return true;
  // The armed expiry owns the lease even at or just past `until`, until it runs (review a66aa1ce 3).
  const until = run.lease?.until ?? run.ownerDeadline;
  return (
    until !== undefined &&
    armedTasks(
      f,
      'projectHostedCheckLease:expire',
      args => args.runId === run.id && args.fence === run.fence && args.until === until,
    )
  );
}
const finishOf = (f, id) => [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === id);
/** What drives an entry that waits on no one: its armed stall alarm, a finish wake due within the
 * stall window, a live check, or the queue's wake or lease while it is runnable. */
function driver(f, row, queue, now) {
  if (armed(f, row.alarm?.taskId)) return 'alarm';
  if (claimDue(f, row.submissionId, now + STALL_MS)) return 'wake';
  if (liveCheck(f, row, now)) return 'check';
  if (row.runnable && (armed(f, queue?.wake?.taskId) || (queue?.lease?.until ?? 0) > now)) return 'queue';
  return null;
}
/** A landing reservation still parks same-file landings (reservationAhead's holder rules and
 * writeLanding's `reserving`): set, not held for red main, finish-driven, not stalled and not
 * waiting for review. A dependency wait, a suspect or an error do not end it (review a66aa1ce 3). */
const reserving = (row, state) =>
  !row.hold &&
  row.reservedUntil !== undefined &&
  Boolean(state.request.finish) &&
  !state.observation.stall &&
  state.observation.pendingReason !== 'waiting-for-review';
const holdsReservation = (row, state, now) => reserving(row, state) && row.reservedUntil > now;
/** Follow stored `orderWait` edges to the first unparked entry. A terminal, missing or looping
 * end, or a hop that no longer holds the order, is dead whatever any claim says (lead, review
 * e7137e30 finding 2). */
export function parkedChainEnd(f, row, byId, queue, now = Date.now(), depth = 0) {
  const seen = new Set([row.submissionId]);
  let end = row;
  while (end.orderWait) {
    const next = byId.get(end.orderWait);
    if (!next || terminal(next) || seen.has(next.submissionId))
      return {
        end: next ?? null,
        live: false,
        dead: true,
        why: next ? (terminal(next) ? next.phase : 'cycle') : 'missing',
      };
    seen.add(next.submissionId);
    // A waiter is woken when the entry it waits on leaves the order (its exit wake). An entry that
    // no longer holds the order (held for red main, stalled, failed) owes its waiters nothing more,
    // unless it still holds a live landing reservation, which keeps same-file waiters parked.
    const state = ticketState(f, next);
    if (!holdsLandingOrder(next, state, now) && !holdsReservation(next, state, now)) {
      // Past its expiry a reservation that writeLanding still keeps (`reserving` ignores expiry)
      // parks its direct waiter until that waiter's reservation-expiry claim (due at reservedUntil)
      // re-claims and reservationAhead skips it; order waiters on it wait for its exit wake. So
      // the hop is an end: live if it is driven itself, else excused only by the direct waiter's
      // own claim (review be5ac889 finding 2).
      if (reserving(next, state)) {
        const why = entryLive(f, next, byId, queue, now, depth);
        return why
          ? { end: next, live: true, dead: false, why }
          : { end: next, live: false, dead: false, why: `${next.phase}, reservation expired`, claimant: end };
      }
      return { end: next, live: false, dead: true, why: `${next.phase}, holds no order` };
    }
    end = next;
  }
  const why = entryLive(f, end, byId, queue, now, depth);
  return { end, live: Boolean(why), dead: false, why: why ?? `${end.phase}, undriven` };
}
/** An unparked entry owns progress through a driver, or it waits on an event that still has an
 * owner: a red-main hold while main is red or its release page is armed (Fix D), or a dependency
 * wait whose parent is itself live, or whose ended parent's dependents page is armed. */
function entryLive(f, row, byId, queue, now, depth) {
  const own = driver(f, row, queue, now);
  if (own) return own;
  if (depth > 16) return null;
  if (row.hold === 'main-red') {
    const audit = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === row.projectId);
    if (audit?.red) return 'main red';
    return armedTasks(f, 'projectHostedMainAudit:releaseHeld', args => args.projectId === row.projectId)
      ? 'release page'
      : null;
  }
  const finish = finishOf(f, row.submissionId);
  if (finish?.waiting && finish.parentSubmissionId) {
    const parent = byId.get(finish.parentSubmissionId);
    if (!parent || terminal(parent))
      return armedTasks(
        f,
        'projectHostedFinishDriver:dependents',
        args => args.submissionId === finish.parentSubmissionId,
      )
        ? 'dependents page'
        : null;
    const chain = parkedChainEnd(f, parent, byId, queue, now, depth + 1);
    return chain.live ? `parent ${chain.why}` : null;
  }
  return null;
}
/** L1 (Item 687d1eda, option B; strengthened by review e7137e30): a waiting entry holds no timer,
 * so an idle queue costs nothing; what it waits on owns progress. A parked row's stored chain must
 * end at a live entry (a dead end fails outright; a live but undriven end is excused only by the
 * row's own claim due within one check wall). A row held for red main, and a dependency waiter,
 * must wait on an event that still has an owner. Returns the violation detail, or null. */
export function l1Issue(f, row, byId, queue, now = Date.now()) {
  if (terminal(row)) return null;
  if (row.orderWait) {
    const chain = parkedChainEnd(f, row, byId, queue, now);
    if (chain.live) return null;
    const claimant = (chain.claimant ?? row).submissionId;
    if (!chain.dead && claimDue(f, claimant, now + CHECK_WALL_MS)) return null;
    return `parked chain ends at ${chain.end?.submissionId ?? 'nothing'} (${chain.why}): no alarm, wake or live check`;
  }
  const waiting = row.hold === 'main-red' || finishOf(f, row.submissionId)?.waiting;
  if (!waiting || entryLive(f, row, byId, queue, now, 0)) return null;
  return row.hold === 'main-red'
    ? 'held for red main while main is green and no release page is armed'
    : 'dependency wait on a parent that owns no progress';
}

/** Structural checks use stored rows and live scheduler state, never the
 * existence of a holder alone as evidence that a stale edge can wake. */
export async function inspectQueue(f) {
  const issues = [],
    rows = requestRows(f),
    byId = new Map(rows.map(r => [r.submissionId, r]));
  const queue = [...f.tables.projectHostedLandingQueues.values()].find(row => row.projectId === f.projectId);
  const add = (id, row, detail) => issues.push({ id, submission: row.submissionId, detail });
  for (const row of rows) {
    const l1 = l1Issue(f, row, byId, queue);
    if (l1) add('L1', row, l1);
  }
  for (const row of rows) {
    if (!row.orderWait || terminal(row)) continue;
    const seen = new Set([row.submissionId]);
    for (let next = row.orderWait; next; next = byId.get(next)?.orderWait) {
      if (seen.has(next)) {
        add('S6', row, 'cycle in stored order waits');
        break;
      }
      seen.add(next);
    }
    const last = row.orderWaits?.at(-1);
    // A wake handed this Ready waiter on (`orderWaitHanded`, 43b51a5e): a mark, not a recorded wait.
    // Its next claim records the wait, so until then only the holder must match the decision.
    const handed = row.orderWaitHanded !== undefined && row.orderWaitHanded === row.orderWait;
    if ((row.orderWaits?.length ?? 0) < 8 && last?.submissionId !== row.orderWait && !handed)
      add('S6', row, 'stored holder absent from latest recorded wait');
    const ahead = await decide(f, row);
    if (
      (ahead?.row.submissionId !== row.orderWait || (!handed && ahead?.held !== last?.held)) &&
      !pendingClaim(f, row.submissionId)
    )
      add('L2', row, `stale edge: stored ${last?.held ?? 'unrecorded'}, current ${ahead?.held ?? 'none'}`);
  }
  return issues;
}

/** L5: a live row needs real scheduled work, a provider completion owned by the
 * test driver, or a freshly validated wait leading to one of those.
 * `alarmOwns: false` (L5b, Item 9a04d916): the 15-minute stall alarm is a
 * backstop, not an owner, and a finish owner counts only if it is due within one
 * check wall. A submitted landing whose only driver is the alarm, or a wake far
 * in the future, would see no progress and no notice for longer than that. */
export async function assertQueueProgress(
  f,
  { externalRuns = new Set(), deliveredContinuations = new Set(), alarmOwns = true } = {},
) {
  const rows = requestRows(f),
    byId = new Map(rows.map(row => [row.submissionId, row]));
  const queue = [...f.tables.projectHostedLandingQueues.values()].find(row => row.projectId === f.projectId);
  const claimed = alarmOwns ? id => pendingClaim(f, id) : id => claimDue(f, id, Date.now() + CHECK_WALL_MS);
  const waits = new Map();
  for (const row of rows.filter(row => row.orderWait && !terminal(row))) {
    const ahead = await decide(f, row);
    if (ahead?.row.submissionId === row.orderWait) waits.set(row.submissionId, row.orderWait);
  }
  const finish = id => [...f.tables.projectHostedFinishes.values()].find(row => row.submissionId === id);
  const batches = new Map(
    [...f.tables.projectHostedLandingBatches.values()].map(row => [row.batchId, JSON.parse(row.value)]),
  );
  function driven(id, seen = new Set()) {
    if (seen.has(id) || seen.size >= 16) return false;
    const row = byId.get(id);
    if (!row || terminal(row)) return false;
    seen = new Set([...seen, id]);
    if (deliveredContinuations.has(id) || claimed(id) || (alarmOwns && armed(f, row.alarm?.taskId)))
      return true;
    if (row.runnable && (armed(f, queue?.wake?.taskId) || queue?.lease?.until > Date.now())) return true;
    if (waits.has(id) && driven(waits.get(id), seen)) return true;
    const pending = finish(id);
    if (pending?.parentSubmissionId && pending.waiting && driven(pending.parentSubmissionId, seen))
      return true;
    if (row.runId) {
      if (externalRuns.has(row.runId)) return true;
      const check = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === row.runId);
      if (check && armed(f, JSON.parse(check.value).actions?.watchdog)) return true;
      if (
        [...f.tables._scheduled_functions.values()].some(
          task => armed(f, task._id) && task.args?.some(arg => arg?.runId === row.runId),
        )
      )
        return true;
    }
    const state = ticketState(f, row),
      batch = state.batchId && batches.get(state.batchId);
    if (batch && batch.leaderId !== id && driven(batch.leaderId, seen)) return true;
    return Boolean(batch?.predecessor && driven(batch.predecessor.submissionId, seen));
  }
  for (const row of rows.filter(row => !terminal(row)))
    assert(
      driven(row.submissionId),
      `${alarmOwns ? 'L5' : 'L5b'}: stranded ${row.submissionId}: ${row.phase}; ${alarmOwns ? 'stale wait is not a driver' : 'no owner is due within one check wall (the stall alarm is not one)'}`,
    );
}

/** Stateful checks distinguish a check generation from metadata-only attempts. */
export function queueHistory(f) {
  let main = f.currentMain();
  const moves = [],
    generations = new Map(),
    lost = new Map(),
    settled = new Map();
  return {
    moves,
    lost,
    check() {
      const rows = requestRows(f),
        issues = [];
      const add = (id, row, detail) => issues.push({ id, submission: row.submissionId, detail });
      const next = f.currentMain();
      if (next.receipt.id !== main.receipt.id) {
        assert.equal(next.receipt.previousHead, main.head, 'S1: receipt replaces observed main head');
        assert.equal(
          next.receipt.previousReceiptId,
          main.receipt.id,
          'S1: receipt replaces observed receipt',
        );
        const accepted = [...f.tables.projectHostedAcceptances.values()]
          .map(r => JSON.parse(r.value))
          .find(a => a.id === next.receipt.id);
        assert(accepted, 'S1: main move has an acceptance receipt');
        const owner = rows.find(row => row.submissionId === accepted.submissionId);
        moves.push({ submission: accepted.submissionId, sequence: owner?.sequence });
        const run = [...f.tables.projectHostedCheckRuns.values()]
          .map(r => JSON.parse(r.value))
          .find(r => r.id === accepted.check?.runId);
        assert(run?.status === 'passed' || accepted.checkSkipped, 'S2: acceptance has passed check evidence');
        if (run && !accepted.crossHeadProof)
          assert.equal(run.plan.head, accepted.candidate.head, 'S2: exact checked head');
        main = next;
      }
      for (const row of rows) {
        if (settled.has(row.submissionId))
          assert.equal(row.phase, settled.get(row.submissionId), 'S10: terminal phase is immutable');
        if (terminal(row)) {
          settled.set(row.submissionId, row.phase);
          assert(!armed(f, row.alarm?.taskId), 'S10: terminal alarm is retired');
          if (pendingClaim(f, row.submissionId)) add('S10', row, 'terminal row retains a finish wake');
        }
        const previous = generations.get(row.submissionId);
        if (previous && row.runId && previous.run !== row.runId) {
          const changed = moves.slice(previous.move);
          if (changed.length && changed.every(m => m.sequence > row.sequence)) {
            const count = (lost.get(row.submissionId) ?? 0) + 1;
            lost.set(row.submissionId, count);
            if (count > 2) add('S4', row, `${count} generations lost to newer main moves`);
          }
        }
        if (row.runId && previous?.run !== row.runId)
          generations.set(row.submissionId, { run: row.runId, move: moves.length });
        const attempts = [...f.tables.projectHostedLandingAttempts.values()]
          .filter(a => a.submissionId === row.submissionId)
          .map(a => JSON.parse(a.value));
        const races = new Set(attempts.filter(a => a.recheckReason).map(a => a.candidate?.id));
        if (races.size > 3) add('S5', row, `${races.size} main-race recompositions`);
      }
      return issues;
    },
  };
}
