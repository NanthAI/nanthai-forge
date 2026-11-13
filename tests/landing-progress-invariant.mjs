// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { ticketState } from './landing-ticket-fixture.mjs';

/** Inspect durable rows only. A test driving a fake provider supplies its exact
 * scheduled completion IDs as externalRuns; a nonterminal run by itself is NOT
 * proof of progress. deliveredContinuations contains only continuations actually
 * read from the agent status/wait adapter, never a private/advisory flag. */
export function assertLandingProgress(
  f,
  { externalRuns = new Set(), deliveredContinuations = new Set() } = {},
) {
  const rows = new Map(
    [...f.tables.projectHostedLandingRequests.values()].map(row => [row.submissionId, row]),
  );
  const tasks = f.tables._scheduled_functions;
  const liveTask = id => id && ['pending', 'inProgress'].includes(tasks.get(id)?.state.kind);
  const finish = id => [...f.tables.projectHostedFinishes.values()].find(row => row.submissionId === id);
  const queue = [...f.tables.projectHostedLandingQueues.values()].find(
    row => row.projectId === f.projectId && row.channel === 'main',
  );
  const batches = new Map(
    [...f.tables.projectHostedLandingBatches.values()].map(row => [row.batchId, JSON.parse(row.value)]),
  );
  function reachable(id, seen = new Set()) {
    if (seen.has(id)) return false;
    seen = new Set([...seen, id]);
    const row = rows.get(id);
    if (!row) return false;
    const state = ticketState(f, row);
    if (['landed', 'terminal-failed'].includes(state.phase)) return false;
    if (deliveredContinuations.has(id)) return true;
    if (liveTask(finish(id)?.wake?.taskId)) return true;
    if (row.runnable && liveTask(queue?.wake?.taskId)) return true;
    if (row.orderWait && reachable(row.orderWait, seen)) return true;
    const pending = finish(id);
    if (pending?.parentSubmissionId && pending.waiting && reachable(pending.parentSubmissionId, seen))
      return true;
    const runId = row.runId;
    if (runId) {
      if (externalRuns.has(runId)) return true;
      const runRow = [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === runId);
      const run = runRow && JSON.parse(runRow.value);
      if (liveTask(run?.actions?.watchdog)) return true;
      const wake = [...f.tables.projectHostedLandingCheckWakes.values()].find(row => row.runId === runId);
      if (liveTask(wake?.wake?.taskId)) return true;
      if (
        [...tasks.values()].some(
          task =>
            ['pending', 'inProgress'].includes(task.state.kind) &&
            task.args?.some(arg => arg?.runId === runId),
        )
      )
        return true;
    }
    const batch = state.batchId && batches.get(state.batchId);
    if (batch && batch.leaderId !== id && reachable(batch.leaderId, seen)) return true;
    if (batch?.predecessor && reachable(batch.predecessor.submissionId, seen)) return true;
    return false;
  }
  for (const [id, row] of rows) {
    const state = ticketState(f, row);
    if (!['landed', 'terminal-failed'].includes(state.phase))
      assert(
        reachable(id),
        `Stranded landing ${id}: ${state.phase}; no durable scheduled work/event chain or delivered recovery continuation`,
      );
  }
}
