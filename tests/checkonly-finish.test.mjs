// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { until } from './landing-worker-fixture.mjs';
import { updateHostState } from '../dist/host-binding.js';
import { FinishJournal, retainedFinishCommand, unfinishedFinishes } from '../dist/agent-finish-journal.js';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { withLandingWorker } from '../dist/landing-worker-context.js';
import { CheckQueue } from '../dist/check-queue.js';

async function boundFixture(t) {
  const f = await fixture(t, { remote: false });
  updateHostState(f.store, state => {
    state.binding = {
      projectId: 'synthetic-project',
      operationId: randomUUID(),
      deployment: 'https://fixture.invalid',
      projectUrl: 'https://fixture.invalid/project',
      name: 'Synthetic owner',
      visibility: 'private',
      backupId: 'synthetic-backup',
      autoSync: false,
      sourceAuthority: { mode: 'native-owner', epoch: 0 },
    };
  });
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Check-only replay' })).result;
  writeFileSync(join(lane.path, 'check-only.txt'), 'saved source\n');
  const command = { action: 'finish', laneId: lane.laneId, message: 'Check saved source', wait: false };
  return { ...f, lane, command };
}
const journal = (f, id) =>
  JSON.parse(readFileSync(join(f.store.directory, 'agent-finish', `${id}.json`), 'utf8'));
const driveOnce = (f, command) =>
  withLandingWorker(new AbortController().signal, () => f.agent.dispatch(command));

test('bound check-only worker accepts resolved journal pins from a short native admission', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch({ ...f.command, operationId: randomUUID() })).result;
  const retained = retainedFinishCommand(f.store, first.operationId);
  assert.equal(retained.accept, undefined);
  assert.equal(journal(f, first.operationId).submitted, true);
  const controller = new AbortController();
  const worker = watchLandingWorker(f.store, controller.signal);
  try {
    await until(
      f,
      () => {
        const error = landingWorkerStates(f.store).find(state => state.status === 'error');
        assert.equal(error?.code, undefined, 'resolved pins must not reject worker recovery');
        return journal(f, first.operationId).result?.status === 'passed';
      },
      'check-only finish passes under the bound owner worker',
    );
  } finally {
    controller.abort();
    await worker;
  }
  const replay = (await f.agent.dispatch({ action: 'finish', operationId: first.operationId, wait: false }))
    .result;
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.complete, true);
  assert.equal(replay.terminal, true);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(f.store.load().channelMoves.length, 0);
  assert.equal(unfinishedFinishes(f.store).length, 0);
});

test('landing worker finish admission yields to an earlier asynchronous writer', async t => {
  const f = await boundFixture(t);
  // An async writer already queued on this event loop must advance; the worker's
  // synchronous 0ms admission used to fail with WORK_BUSY instead of waiting behind it.
  const holder = new CheckQueue(join(f.store.directory, 'lock-queue'), {
    limit: 1,
    serializeAdmission: false,
    anchor: f.store.directory,
  });
  let admitted = false,
    writer;
  try {
    assert.equal(holder.position().acquired, true);
    writer = f.store.lockedAsync(() => {
      admitted = true;
    });
    setTimeout(() => holder.release(), 50);
    const first = (await driveOnce(f, f.command)).result;
    assert.equal(admitted, true);
    assert.equal(first.complete, false);
  } finally {
    holder.release();
    await writer;
  }
});

async function completeFinish(f, first) {
  await driveOnce(f, retainedFinishCommand(f.store, first.operationId));
  await f.agent.dispatch({
    action: 'observe',
    operationId: journal(f, first.operationId).attempts[0].operations.run,
    waitMs: 60000,
  });
  await driveOnce(f, retainedFinishCommand(f.store, first.operationId));
  assert.equal(journal(f, first.operationId).result.status, 'passed');
}

test('identical short bound native finish reuses pending and unchanged terminal work', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch(f.command)).result;
  // A later draft must not turn a pending replay into another checkpoint/check.
  writeFileSync(join(f.lane.path, 'check-only.txt'), 'later unsaved source\n');
  const again = (await f.agent.dispatch(f.command)).result;
  assert.equal(again.operationId, first.operationId);
  assert.equal(again.checkpoint.head, first.checkpoint.head);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
  writeFileSync(join(f.lane.path, 'check-only.txt'), 'saved source\n');
  await completeFinish(f, first);
  const terminal = (await f.agent.dispatch(f.command)).result;
  assert.equal(terminal.operationId, first.operationId);
  assert.equal(terminal.complete, true);
  assert.equal(terminal.checkpoint.head, first.checkpoint.head);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
});

for (const saved of [false, true])
  test(`identical short native finish checks new ${saved ? 'checkpointed' : 'unsaved'} source after completion`, async t => {
    const f = await boundFixture(t);
    const first = (await f.agent.dispatch(f.command)).result;
    await completeFinish(f, first);
    writeFileSync(join(f.lane.path, 'check-only.txt'), 'new source to check\n');
    const checkpoint = saved
      ? (await f.agent.dispatch({ action: 'checkpoint', laneId: f.lane.laneId, message: 'New saved head' }))
          .result
      : null;
    const fresh = (await f.agent.dispatch(f.command)).result;
    assert.notEqual(fresh.operationId, first.operationId);
    assert.equal(fresh.supersedes, first.operationId);
    assert.notEqual(fresh.checkpoint.head, first.checkpoint.head);
    if (saved) assert.equal(fresh.checkpoint.head, checkpoint.head);
    assert.equal(fresh.complete, false, 'a new source cannot receive the old green');
    const pendingReplay = (await f.agent.dispatch(f.command)).result;
    assert.equal(pendingReplay.operationId, fresh.operationId);
    assert.equal(pendingReplay.supersedes, first.operationId);
    await completeFinish(f, fresh);
    const terminal = (await f.agent.dispatch(f.command)).result;
    assert.equal(terminal.operationId, fresh.operationId);
    assert.equal(terminal.complete, true);
    assert.equal(terminal.supersedes, first.operationId);
    const data = f.store.load();
    const view = data.views.find(view => view.id === terminal.view.viewId);
    assert.equal(view.inputs[0].head, fresh.checkpoint.head);
    assert.equal(data.runs.filter(run => !run.mainCheck).length, 2);
    assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, saved ? 3 : 2);
    // Explicit IDs retain the old exact meaning even after newer work completes.
    const old = (await f.agent.dispatch({ ...f.command, operationId: first.operationId })).result;
    assert.equal(old.operationId, first.operationId);
    assert.equal(old.checkpoint.head, first.checkpoint.head);
  });

test('resolved native replay preserves explicit inputs and rejects changes to pinned fields', async t => {
  const f = await boundFixture(t);
  const parent = (await f.agent.dispatch({ action: 'start', outcome: 'Dependency' })).result;
  const first = (
    await f.agent.dispatch({ ...f.command, after: { intentId: parent.intentId }, operationId: randomUUID() })
  ).result;
  const retained = retainedFinishCommand(f.store, first.operationId);
  const replay = (await f.agent.dispatch({ ...retained, wait: false })).result;
  assert.equal(replay.operationId, first.operationId);
  for (const change of [
    { message: 'Changed message' },
    { expectedHead: 'f'.repeat(64) },
    { checkId: randomUUID() },
    { expectedDefinition: 'f'.repeat(64) },
    { after: { intentId: randomUUID() } },
    { accept: true },
  ])
    await assert.rejects(f.agent.dispatch({ ...retained, ...change, wait: false }), {
      code: 'WORK_OPERATION_CHANGED',
    });
});

test('legacy short native admission without an automatic index reuses its original operation', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch(f.command)).result;
  const directory = join(f.store.directory, 'native-submissions');
  for (const name of readdirSync(directory).filter(name => name.startsWith('auto-')))
    rmSync(join(directory, name));
  writeFileSync(
    join(directory, `${first.operationId}.json`),
    JSON.stringify({
      command: {
        action: 'finish',
        laneId: f.lane.laneId,
        message: f.command.message,
        operationId: first.operationId,
      },
      result: first,
    }),
  );
  const replay = (await f.agent.dispatch(f.command)).result;
  assert.equal(replay.operationId, first.operationId);
});

test('pending check-only receipt identifies its owner, dependency, or exact run without driving it', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch(f.command)).result;
  assert.equal(first.waitingOn.kind, 'owner');
  assert.equal(first.waitingOn.root, f.store.root);
  assert.equal(first.waitingOn.operationId, first.operationId);
  assert.equal(first.waitingOn.worker.workers, 0);
  const parent = (await f.agent.dispatch({ action: 'start', outcome: 'Waited dependency' })).result;
  const blocked = (
    await f.agent.dispatch({ ...f.command, operationId: randomUUID(), after: { intentId: parent.intentId } })
  ).result;
  assert.deepEqual(blocked.waitingOn, {
    kind: 'dependency',
    dependencies: [{ laneId: f.lane.laneId, after: { intentId: parent.intentId } }],
  });
  // Use another Lane so this run has no declared dependency. Gate the command
  // on a private fixture file so its live state does not depend on timing.
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Gated check' })).result;
  const gate = join(f.store.directory, 'release-check');
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.check.checkId,
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(0)}},10)`,
    ],
  });
  const pending = (await f.agent.dispatch({ ...f.command, laneId: lane.laneId, operationId: randomUUID() }))
    .result;
  try {
    await driveOnce(f, retainedFinishCommand(f.store, pending.operationId));
    const observed = (
      await f.agent.dispatch({ action: 'finish', operationId: pending.operationId, wait: false })
    ).result;
    assert.equal(observed.waitingOn.kind, 'run');
    assert.equal(observed.waitingOn.runId, journal(f, pending.operationId).attempts[0].operations.run);
    assert.equal(observed.run.runId, observed.waitingOn.runId);
    assert.equal(observed.terminal, false);
  } finally {
    writeFileSync(gate, 'release\n');
  }
  await f.agent.dispatch({
    action: 'observe',
    operationId: journal(f, pending.operationId).attempts[0].operations.run,
    waitMs: 60000,
  });
});

test('bound accepting finish replays resolved acceptance pins and shorthand without changing its request', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch({ ...f.command, accept: true, operationId: randomUUID() })).result;
  const retained = retainedFinishCommand(f.store, first.operationId);
  assert.deepEqual(retained.accept, { channel: 'main', expectedPrevious: null });
  for (const input of [retained, { action: 'finish', operationId: first.operationId, accept: true }]) {
    const replay = (await f.agent.dispatch({ ...input, wait: false })).result;
    assert.equal(replay.operationId, first.operationId);
    assert.equal(replay.checkpoint.head, first.checkpoint.head);
  }
  await assert.rejects(
    f.agent.dispatch({
      ...retained,
      accept: { channel: 'main', expectedPrevious: 'f'.repeat(64) },
      wait: false,
    }),
    { code: 'WORK_OPERATION_CHANGED' },
  );
});

test('concurrent identical short native admissions retain one operation and one checkpoint', async t => {
  const f = await boundFixture(t);
  const [first, second] = await Promise.all([f.agent.dispatch(f.command), f.agent.dispatch(f.command)]);
  assert.equal(first.result.operationId, second.result.operationId);
  assert.equal(first.result.checkpoint.head, second.result.checkpoint.head);
  assert.equal(unfinishedFinishes(f.store).length, 1);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
});

for (const shorthand of [false, true])
  test(`a lost ${shorthand ? 'shorthand' : 'explicit'} reply between checkpoint and finish journal retains the original default head`, async t => {
    const f = await boundFixture(t);
    const command = { ...f.command, ...(shorthand ? {} : { operationId: randomUUID() }) };
    const save = FinishJournal.prototype.save;
    let lose = true;
    t.mock.method(FinishJournal.prototype, 'save', function () {
      if (lose) {
        lose = false;
        throw new Error('synthetic loss before finish journal publication');
      }
      return save.call(this);
    });
    await assert.rejects(f.agent.dispatch(command), /synthetic loss/);
    assert.equal(
      readdirSync(join(f.store.directory, 'agent-finish')).filter(name => /^[0-9a-f-]+\.json$/.test(name))
        .length,
      0,
    );
    const checkpoint = f.store.select('lanes', f.lane.laneId).checkpoints[0];
    if (!shorthand) assert.equal(checkpoint.operation.id, command.operationId);
    writeFileSync(join(f.lane.path, 'check-only.txt'), 'later unsaved source\n');
    const replay = (await f.agent.dispatch(command)).result;
    assert.equal(replay.operationId, checkpoint.operation.id);
    assert.equal(replay.checkpoint.head, checkpoint.head);
    assert.equal(retainedFinishCommand(f.store, replay.operationId).expectedHead, checkpoint.parent);
    assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
  });

test('a terminal journal reconciles a lost native result publication without another check', async t => {
  const f = await boundFixture(t);
  const first = (await f.agent.dispatch(f.command)).result;
  await completeFinish(f, first);
  const path = join(f.store.directory, 'native-submissions', `${first.operationId}.json`);
  const retained = JSON.parse(readFileSync(path, 'utf8'));
  delete retained.result;
  writeFileSync(path, JSON.stringify(retained));
  const replay = (await f.agent.dispatch(f.command)).result;
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.complete, true);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});
