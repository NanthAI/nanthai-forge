// SPDX-License-Identifier: Apache-2.0
import { postAcceptMoves } from './post-accept-coverage.js';
import { recoveryAllowed } from './optimistic-recovery.js';
import { finishChild } from './agent-finish-journal.js';
import type { WorkData } from './work-types.js';

/** Called under the owner lock. Superseded requests point at the newest audit;
 * cancelled/interrupted audits retain evidence and get a new execution identity. */
export function selectMainAudit(data: WorkData, push?: { channel: string; checkId: string }) {
  const requested = postAcceptMoves(data.channelMoves)
    .filter(move => move.postAccept)
    .map(move => ({ move, checkId: move.postAccept!.checkId }));
  if (push) {
    const main = data.channelMoves
      .filter(move => move.channel === push.channel && move.status === 'accepted')
      .at(-1);
    if (main && !requested.some(item => item.move.id === main.id))
      requested.push({ move: main, checkId: push.checkId });
  }
  const latest = new Map(requested.map(item => [item.move.channel, item]));
  const active = data.runs.find(run => run.mainCheck && !run.recovery && !run.endedAt);
  if (active) {
    const main = data.channelMoves
      .filter(move => move.channel === active.mainCheck!.channel && move.status === 'accepted')
      .at(-1);
    if (main && active.head !== main.head && !recoveryAllowed(data) && !active.cancelRequested) {
      active.cancelRequested = true;
      active.cancellation = {
        reason: 'superseded',
        at: new Date().toISOString(),
        supersededBy: main.viewId,
        actor: { kind: 'system', name: 'Forge main audit scheduler' },
        details: 'New accepted main superseded this audit.',
      };
    }
    return { wait: true as const };
  }
  const newest = [...latest.values()].reverse().find(({ move, checkId }) => {
    const main = data.channelMoves
      .filter(item => item.channel === move.channel && item.status === 'accepted')
      .at(-1)!;
    const prior = move.postAcceptRunId && data.runs.find(run => run.id === move.postAcceptRunId);
    const check = data.checks?.find(item => item.id === checkId);
    return (
      !prior ||
      prior.head !== main.head ||
      !['passed', 'failed'].includes(prior.status) ||
      (check && (prior.check?.id !== check.id || prior.check?.definition !== check.definition))
    );
  });
  if (!newest) return;
  const main = data.channelMoves
    .filter(move => move.channel === newest.move.channel && move.status === 'accepted')
    .at(-1)!;
  const original = data.views.find(view => view.id === newest.move.viewId)!;
  const previous = data.runs.filter(
    run => run.mainCheck?.channel === newest.move.channel && run.head === main.head,
  );
  const runId = finishChild(
    main.id,
    previous.length ? `post-accept-main:${previous.length}` : 'post-accept-main',
  );
  const existing = data.views.find(view => view.id === finishChild(runId, 'main-view'));
  const view = existing ?? {
    id: finishChild(runId, 'main-view'),
    intentId: original.intentId,
    base: main.head,
    composedMain: main.head,
    head: main.head,
    inputs: [],
    dependencies: [],
    mainCheck: { channel: newest.move.channel },
    status: 'clean' as const,
    details: 'Full verification of accepted main; fix forward on failure.',
    at: new Date().toISOString(),
  };
  if (!existing) data.views.push(view);
  main.postAcceptAuditRunId = runId;
  // Preserve the direct pointer for the newest request (including explicit push).
  if (requested.some(item => item.move.id === main.id)) main.postAcceptRunId = runId;
  data.schema = Math.max(data.schema, 13) as WorkData['schema'];
  return { view, runId, checkId: newest.checkId };
}
