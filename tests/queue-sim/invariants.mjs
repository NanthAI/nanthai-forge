// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { ticketState } from '../landing-ticket-fixture.mjs';
import { moduleUrl } from '../convex-module.mjs';
const { olderLandingAhead } = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
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

/** Structural checks use stored rows and live scheduler state, never the
 * existence of a holder alone as evidence that a stale edge can wake. */
export async function inspectQueue(f) {
  const issues = [],
    rows = requestRows(f),
    byId = new Map(rows.map(r => [r.submissionId, r]));
  const add = (id, row, detail) => issues.push({ id, submission: row.submissionId, detail });
  for (const row of rows) {
    if (!row.orderWait || terminal(row)) continue;
    if (!armed(f, row.alarm?.taskId)) add('L1', row, 'parked without an armed deadline');
    const seen = new Set([row.submissionId]);
    for (let next = row.orderWait; next; next = byId.get(next)?.orderWait) {
      if (seen.has(next)) {
        add('S6', row, 'cycle in stored order waits');
        break;
      }
      seen.add(next);
    }
    const last = row.orderWaits?.at(-1);
    if ((row.orderWaits?.length ?? 0) < 8 && last?.submissionId !== row.orderWait)
      add('S6', row, 'stored holder absent from latest recorded wait');
    const ahead = await decide(f, row);
    if (
      (ahead?.row.submissionId !== row.orderWait || ahead?.held !== last?.held) &&
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
