// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { agentPeers } from '../dist/agent-peers.js';
import { integrationPreview } from '../dist/integration-preview.js';
import { recordFixForward, fixMainIntentId } from '../dist/post-accept-fix-forward.js';
import { syncLineage } from '../dist/agent-repair-lineage.js';
import { enqueueLanding } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { fixture as landingFixture } from './landing-batch-fixture.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.txt`), '0\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const start = async () => (await agent.dispatch({ action: 'start', outcome: 'Synthetic repair' })).result;
  const save = async (lane, file, text) => {
    writeFileSync(join(lane.path, file), text);
    return (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Saved source' }))
      .result;
  };
  const main = head =>
    store.locked(() => {
      const tx = store.records();
      tx.append('channelMoves', {
        id: randomUUID(),
        channel: 'main',
        viewId: randomUUID(),
        head,
        previous: null,
        at: new Date().toISOString(),
        status: 'accepted',
        provenance: 'user-declared-local',
      });
      store.commitRecords(tx);
    });
  const initial = await start();
  main(initial.head);
  const context = lane => new CoordinationJournal(store).context(lane?.laneId);
  return { root, agent, store, start, save, main, context };
}

test('higher-order static notice retains exact controls and stays historical after a repair save', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'define-check',
    name: 'static',
    static: true,
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');process.exit(['a','b','c'].every(n=>fs.readFileSync(n+'.txt','utf8')==='1\\n')?1:0)`,
    ],
  });
  const lanes = [await f.start(), await f.start(), await f.start()];
  for (const [i, lane] of lanes.entries()) await f.save(lane, `${['a', 'b', 'c'][i]}.txt`, '1\n');
  writeFileSync(join(lanes[0].path, 'dirty.txt'), 'late unsaved work');
  const result = integrationPreview(f.store, { laneIds: lanes.map(l => l.laneId) }).result;
  assert.equal(result.status, 'clash');
  assert.equal(result.pairs.length, 0);
  const notice = result.notices[0],
    evidence = notice.evidence[0];
  assert.equal(notice.participants.length, 3);
  assert.equal(evidence.kind, 'combined-static');
  assert.equal(evidence.controls.length, 4);
  assert.ok(evidence.controls.every(c => c.status === 'passed'));
  assert.equal(evidence.configuration, result.configuration);
  assert.equal(notice.conflicts.length, 0);
  for (const lane of lanes) assert.equal(f.context(lane).notices[0].noticeId, notice.noticeId);
  assert.equal(readFileSync(join(lanes[0].path, 'dirty.txt'), 'utf8'), 'late unsaved work');
  await f.save(lanes[0], 'a.txt', '0\n');
  await f.agent.dispatch({
    action: 'handoff',
    laneId: lanes[0].laneId,
    summary: 'Repair triple',
    repairs: [notice.noticeId],
  });
  const history = f.context(lanes[1]).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(history.applicability, 'historical');
  assert.equal(history.resolutions[0].laneId, lanes[0].laneId);
  assert.deepEqual(history.resolutions[0].candidates, []);
  assert.equal(integrationPreview(f.store, { laneIds: lanes.map(l => l.laneId) }).result.status, 'clean');
});

test('retained landing diagnosis links a separate repair Lane and new exact-Candidate evidence', async t => {
  const f = await landingFixture(t, { remote: false });
  const broken = await f.candidate('bad.txt');
  await drainLandingBatches(f.work, 'main');
  const journal = new CoordinationJournal(f.store);
  const notice = journal
    .context(broken.lane.laneId)
    .notices.find(n => n.evidence?.some(e => e.kind === 'check'));
  assert.ok(notice);
  const evidence = notice.evidence[0],
    run = f.store.select('runs', evidence.runId);
  assert.equal(evidence.head, run.head);
  assert.equal(evidence.definition, run.check.definition);
  assert.equal(evidence.environment, run.environment.fingerprint);
  assert.equal(evidence.cause, 'check-failed');
  assert.deepEqual(evidence.logs, { operationId: run.id, streams: ['stdout', 'stderr'] });
  assert.equal(evidence.selection.known, !!run.checkSelection);
  const peers = agentPeers(f.store, { laneId: broken.lane.laneId, detail: true });
  assert.equal(peers.conflicts.find(n => n.noticeId === notice.noticeId).evidence[0].runId, run.id);
  const repair = await f.candidate('fixed.txt', 'repair\n', false);
  const handoff = {
    action: 'handoff',
    operationId: randomUUID(),
    laneId: repair.lane.laneId,
    summary: 'Declared repair',
    repairs: [notice.noticeId],
  };
  const first = (await f.agent.dispatch(handoff)).result;
  const projected = journal.context(broken.lane.laneId).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(projected.resolutions[0].head, repair.checkpoint.head);
  assert.ok(projected.resolutions[0].candidates.every(c => c.checks.length === 0));
  assert.equal(f.store.select('runs', run.id).status, 'failed');
  assert.ok(journal.context(repair.lane.laneId).notices.some(n => n.noticeId === notice.noticeId));
  await assert.rejects(f.agent.dispatch({ action: 'accept', viewId: repair.view.id }), {
    code: 'CHECK_REQUIRED',
  });
  await f.agent.dispatch({ action: 'run', viewId: repair.view.id, checkId: f.check.checkId });
  const checked = journal.context(broken.lane.laneId).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(checked.resolutions[0].candidates[0].checks[0].status, 'passed');
  assert.notEqual(checked.resolutions[0].candidates[0].checks[0].runId, run.id);
  const accepted = (await f.agent.dispatch({ action: 'accept', viewId: repair.view.id })).result;
  const landed = journal.context(broken.lane.laneId).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(landed.resolutions[0].candidates[0].acceptances[0].head, accepted.head);
  assert.match(landed.resolutions[0].candidates[0].acceptances[0].undo, /compensating/);
  // A cumulative Candidate belongs to the last entry's Intent, while retaining
  // this repair's exact saved input. Queue recomposition must keep live edits.
  writeFileSync(join(repair.lane.path, 'dirty.txt'), 'unsaved during recomposition');
  await enqueueLanding(f.work, repair.command, repair.view);
  const sibling = await f.candidate('sibling.txt');
  await drainLandingBatches(f.work, 'main');
  const combined = f.main();
  const combinedView = f.store.select('views', combined.viewId);
  assert.equal(combinedView.intentId, sibling.lane.intentId);
  assert.notEqual(combinedView.intentId, repair.lane.intentId);
  const composedRepair = journal
    .context(broken.lane.laneId)
    .notices.find(n => n.noticeId === notice.noticeId);
  assert.ok(
    composedRepair.resolutions[0].candidates.some(
      c => c.viewId === combined.viewId && c.acceptances.some(a => a.id === combined.id),
    ),
  );
  assert.equal(readFileSync(join(repair.lane.path, 'dirty.txt'), 'utf8'), 'unsaved during recomposition');
  writeFileSync(join(repair.lane.path, 'later.txt'), 'new save');
  await f.agent.dispatch({ action: 'checkpoint', laneId: repair.lane.laneId, message: 'Later source' });
  const historical = journal.context(broken.lane.laneId).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(historical.resolutions[0].applicability, 'historical');
  assert.deepEqual((await f.agent.dispatch(handoff)).result, first);
  await assert.rejects(f.agent.dispatch({ ...handoff, repairs: [] }), { code: 'WORK_OPERATION_CHANGED' });
});

test('unknown repair references fail explicitly without changing source or creating notes', async t => {
  const f = await fixture(t),
    lane = await f.start(),
    before = f.store.revision();
  await assert.rejects(
    f.agent.dispatch({
      action: 'handoff',
      laneId: lane.laneId,
      summary: 'Unknown notice',
      repairs: ['f'.repeat(64)],
    }),
    { code: 'NOT_FOUND' },
  );
  assert.equal(f.store.revision(), before);
  assert.deepEqual(f.store.select('intents', lane.intentId).notes, []);
});

test('saved-head and dirty guards keep late work; sync and undo retain notice lineage', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  const savedA = await f.save(a, 'a.txt', 'A\n');
  const savedB = await f.save(b, 'a.txt', 'B\n');
  const notice = agentPeers(f.store, { laneId: b.laneId, detail: true }).conflicts[0];
  assert.equal(notice.evidence[0].kind, 'text');
  assert.ok(notice.conflicts[0].base.blob);
  f.main(savedA.head);
  const later = await f.save(b, 'b.txt', 'later save\n');
  await assert.rejects(
    f.agent.dispatch({
      action: 'sync',
      operationId: randomUUID(),
      laneId: b.laneId,
      expectedHead: savedB.head,
    }),
    { code: 'LANE_STALE' },
  );
  writeFileSync(join(b.path, 'c.txt'), 'late unsaved\n');
  await assert.rejects(f.agent.dispatch({ action: 'sync', laneId: b.laneId, expectedHead: later.head }), {
    code: 'LANE_DIRTY',
  });
  assert.equal(readFileSync(join(b.path, 'c.txt'), 'utf8'), 'late unsaved\n');
  assert.equal(f.store.select('lanes', b.laneId).pendingMerge, undefined);
  await f.agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'Keep late edits' });
  const sync = (await f.agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
  assert.equal(sync.status, 'conflict');
  const pending = f.context(b).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(pending.applicability, 'historical');
  assert.equal(pending.syncs[0].status, 'conflict');
  assert.deepEqual(pending.syncs[0].undo, {
    action: 'undo-sync',
    laneId: b.laneId,
    syncOperationId: sync.operationId,
    force: false,
  });
  writeFileSync(join(b.path, 'c.txt'), 'edits after conflict\n');
  const undo = { ...pending.syncs[0].undo, operationId: randomUUID() };
  await assert.rejects(f.agent.dispatch(undo), { code: 'LANE_DIRTY' });
  assert.equal(readFileSync(join(b.path, 'c.txt'), 'utf8'), 'edits after conflict\n');
  const restored = (await f.agent.dispatch({ ...undo, force: true })).result;
  assert.equal(restored.status, 'undone');
  const undoneNotice = f.context(b).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(undoneNotice.syncs[0].undoneBy[0].operationId, undo.operationId);
  assert.equal(undoneNotice.syncs[0].status, 'conflict');
  const source = new NativeSource(f.root),
    preserved = f.store
      .select('lanes', b.laneId)
      .checkpoints.find(c => c.message === 'Preserve edits before forced undo-sync');
  const file = source.state(preserved.head).files.find(file => file.path === 'c.txt');
  assert.equal(source.object(file.blob).toString(), 'edits after conflict\n');
  assert.equal(f.store.select('channelMoves', f.store.load().channelMoves.at(-1).id).head, savedA.head);
});

test('existing Fix-main Intent supplies repair lineage without another task or model execution', async t => {
  const f = await landingFixture(t, { remote: false });
  const broken = await f.candidate('bad.txt');
  await drainLandingBatches(f.work, 'main');
  const original = f.store.load().runs.find(run => run.status === 'failed');
  f.store.locked(() => {
    const data = f.store.load();
    const run = data.runs.find(run => run.id === original.id);
    run.mainCheck = { channel: 'main' };
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId: run.viewId,
      head: run.head,
      previous: null,
      at: run.endedAt,
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    assert.equal(recordFixForward(data), true);
    data.revision++;
    f.store.save(data);
  });
  const intentId = fixMainIntentId({ ...original, mainCheck: { channel: 'main' } });
  const before = f.store.load().intents.length;
  const repair = (await f.agent.dispatch({ action: 'start', intentId, outcome: 'Fix current main' })).result;
  const notices = new CoordinationJournal(f.store).context(repair.laneId).notices;
  const notice = notices.find(n => n.repairIntentId === intentId);
  assert.ok(notice);
  assert.equal(notices.filter(n => n.noticeId === notice.noticeId).length, 1);
  assert.ok(notice.resolutions.some(r => r.laneId === repair.laneId));
  assert.equal(f.store.load().intents.length, before);
  const revision = f.store.revision();
  new CoordinationJournal(f.store).context(repair.laneId);
  assert.equal(f.store.revision(), revision);
});

test('ask remains parked; auto sync and undo expose the original guarded source transition', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    preset: 'trusted',
    laneUpdates: 'ask',
  });
  const a = await f.start(),
    b = await f.start();
  await f.save(a, 'a.txt', 'A\n');
  await f.agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'Land A', accept: true });
  const saved = await f.save(b, 'b.txt', 'B\n');
  const waiting = (
    await f.agent.dispatch({ action: 'finish', laneId: b.laneId, message: 'Ask update', accept: true })
  ).result;
  assert.equal(waiting.status, 'sync-required');
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), '0\n');
  assert.deepEqual(syncLineage(f.store.select('lanes', b.laneId), saved.head), []);
  await f.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), laneUpdates: 'auto' });
  const done = (
    await f.agent.dispatch({ action: 'finish', laneId: b.laneId, message: 'Auto update', accept: true })
  ).result;
  assert.equal(done.status, 'accepted');
  const lineage = syncLineage(f.store.select('lanes', b.laneId), saved.head);
  assert.equal(lineage[0].operationId, done.sync.operationId);
  assert.equal(lineage[0].head, done.sync.head);
  const undo = { ...lineage[0].undo, operationId: randomUUID() };
  await f.agent.dispatch(undo);
  assert.equal(
    syncLineage(f.store.select('lanes', b.laneId), saved.head)[0].undoneBy[0].operationId,
    undo.operationId,
  );
});

test('saving a conflict resolution retains original sync replay and guarded undo identity', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  const main = await f.save(a, 'a.txt', 'A\n');
  const saved = await f.save(b, 'a.txt', 'B\n');
  const notice = agentPeers(f.store, { laneId: b.laneId, detail: true }).conflicts[0];
  f.main(main.head);
  const request = { action: 'sync', operationId: randomUUID(), laneId: b.laneId, expectedHead: saved.head };
  assert.equal((await f.agent.dispatch(request)).result.status, 'conflict');
  const resolution = await f.save(b, 'a.txt', 'Resolved A and B\n');
  const revision = f.store.revision();
  const replay = (await f.agent.dispatch(request)).result;
  assert.equal(replay.status, 'conflict');
  assert.equal(replay.resolvedHead, resolution.head);
  assert.equal(f.store.revision(), revision);
  const context = f.context(b).notices.find(n => n.noticeId === notice.noticeId);
  assert.equal(context.syncs[0].head, resolution.head);
  assert.equal(context.syncs[0].operationId, request.operationId);
  assert.equal(context.syncs[0].resolvedHead, resolution.head);
  await assert.rejects(
    f.agent.dispatch({ action: 'start', operationId: request.operationId, outcome: 'Reused sync identity' }),
    { code: 'WORK_OPERATION_CHANGED' },
  );
  const undone = (
    await f.agent.dispatch({ action: 'undo-sync', laneId: b.laneId, syncOperationId: request.operationId })
  ).result;
  assert.equal(undone.head, saved.head);
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'B\n');
  assert.equal(
    f.context(b).notices.find(n => n.noticeId === notice.noticeId).syncs[0].undoneBy[0].operationId,
    undone.operationId,
  );
});
