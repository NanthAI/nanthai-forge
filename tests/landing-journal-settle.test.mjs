// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { until } from './landing-worker-fixture.mjs';
import {
  FinishJournal,
  finishAttempt,
  retainedFinishCommand,
  unfinishedFinishes,
} from '../dist/agent-finish-journal.js';
import { settleFinish, settleLand, requireRecoveryProgress } from '../dist/landing-journal-settle.js';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { ForgeError } from '../dist/errors.js';
import { withQueueSlot } from '../dist/landing-queue.js';
import { LandJournal, pendingLands } from '../dist/land-journal.js';
import { driveLand } from '../dist/land.js';
import { resolveAgentDefaults } from '../dist/agent-defaults.js';
import { observeWorkLocks } from '../dist/work-lock.js';
import { updateHostState } from '../dist/host-binding.js';

async function submitted(f, lane, accept = true) {
  const response = await f.agent.dispatch({
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    message: 'Retain recovery inputs',
    ...(accept ? { accept: true } : {}),
    wait: false,
  });
  const command = retainedFinishCommand(f.store, response.result.operationId);
  return new FinishJournal(f.store, command, command.expectedHead);
}
async function setup(t) {
  const f = await fixture(t, { remote: false, stopChecks: true });
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Journal recovery' })).result;
  writeFileSync(join(lane.path, 'recovery.txt'), 'retained\n');
  return { ...f, lane };
}
async function removeWorkspace(f) {
  await f.agent.dispatch({ action: 'complete', laneId: f.lane.laneId });
  rmSync(f.lane.path, { recursive: true, force: true });
}
const bytes = journal => readFileSync(journal.path, 'utf8');

test('a cleaned completed Lane settles once and replay returns its terminal receipt', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  await removeWorkspace(f);
  const locks = [];
  const settled = await observeWorkLocks(
    span => locks.push(span),
    () => settleFinish(f.store, journal.state.command),
  );
  assert.equal(locks.length, 0, 'settlement takes no Work writer lock');
  assert.equal(settled.code, 'LANE_UNAVAILABLE');
  assert.equal(settled.terminal, true);
  assert.equal(settled.complete, false);
  const saved = bytes(journal);
  assert.deepEqual(await settleFinish(f.store, journal.state.command), settled);
  const replay = await f.agent.dispatch({ action: 'finish', operationId: settled.operationId });
  assert.deepEqual(replay.result, settled);
  assert.equal(bytes(journal), saved);
  assert.equal(existsSync(f.lane.path), false, 'replay never restores or checkpoints the Lane');
  assert.equal(unfinishedFinishes(f.store).length, 0);
  assert.equal(f.store.load().runs.length, 0);
  await assert.rejects(
    f.agent.dispatch({ action: 'finish', operationId: settled.operationId, message: 'Changed' }),
    { code: 'WORK_OPERATION_CHANGED' },
  );
});

test('a deleted Lane record settles before current defaults or checkpoint lookup', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  const select = f.store.select.bind(f.store);
  t.mock.method(f.store, 'select', (kind, id, ...args) =>
    kind === 'lanes' && id === f.lane.laneId ? undefined : select(kind, id, ...args),
  );
  const response = await f.agent.dispatch({
    action: 'finish',
    operationId: journal.state.command.operationId,
  });
  assert.equal(response.result.code, 'LANE_UNAVAILABLE');
  assert.equal(response.result.terminal, true);
});

test('a newer finish supersedes an old finish; a save alone does not; new finishes remain available', async t => {
  const f = await setup(t),
    old = await submitted(f, f.lane);
  writeFileSync(join(f.lane.path, 'recovery.txt'), 'later save\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: f.lane.laneId, message: 'Save alone' });
  assert.equal(await settleFinish(f.store, old.state.command), undefined);
  const newer = await submitted(f, f.lane);
  const settled = await settleFinish(f.store, old.state.command);
  assert.equal(settled.status, 'superseded');
  assert.equal(settled.supersededBy, newer.state.command.operationId);
  assert.equal(await settleFinish(f.store, newer.state.command), undefined);
  const fresh = await submitted(f, f.lane);
  assert.notEqual(fresh.state.command.operationId, old.state.command.operationId);
  assert.equal(fresh.state.result, undefined);
});

test('a missing pinned input State settles without source or check execution', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  rmSync(join(f.store.directory, 'objects', journal.state.attempts[0].head));
  const settled = await settleFinish(f.store, journal.state.command);
  assert.equal(settled.code, 'FINISH_INPUT_UNAVAILABLE');
  assert.equal(settled.terminal, true);
  assert.equal(unfinishedFinishes(f.store).length, 0);
});

test('an explicitly cancelled retained attempt settles and cannot be revived by replay', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  journal.state.attempts[0].status = 'cancelled';
  journal.save();
  const settled = await settleFinish(f.store, journal.state.command);
  assert.equal(settled.status, 'cancelled');
  const replay = await f.agent.dispatch({ action: 'finish', operationId: settled.operationId, wait: false });
  assert.deepEqual(replay.result, settled);
});

test('settlement does not race an active finish driver', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  await removeWorkspace(f);
  let entered, release;
  const started = new Promise(resolve => (entered = resolve));
  const held = new Promise(resolve => (release = resolve));
  const holder = withQueueSlot(
    join(f.store.directory, 'finish-queue', journal.state.command.operationId),
    async () => {
      entered();
      await held;
    },
    { anchor: f.store.directory },
  );
  await started;
  try {
    assert.equal(await settleFinish(f.store, journal.state.command), undefined);
  } finally {
    release();
    await holder;
  }
  assert.equal((await settleFinish(f.store, journal.state.command)).code, 'LANE_UNAVAILABLE');
});

test('owner startup settles old journals once, without operator cleanup or new checks', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  delete journal.state.landingPins;
  delete journal.state.submitted;
  journal.state.attempts[0].status = 'channel-changed';
  journal.state.attempts.push(finishAttempt(journal.state.command, 1, journal.state.attempts[0].head, null));
  journal.save();
  await removeWorkspace(f);
  for (let restart = 0; restart < 2; restart++) {
    const controller = new AbortController();
    const running = watchLandingWorker(f.store, controller.signal);
    try {
      await until(
        f,
        () =>
          landingWorkerStates(f.store).some(s => s.status === 'idle') &&
          JSON.parse(bytes(journal)).result?.settled,
        'startup settles old journal',
      );
    } finally {
      controller.abort();
      await running;
    }
  }
  assert.equal(JSON.parse(bytes(journal)).result.code, 'LANE_UNAVAILABLE');
  assert.equal(f.store.load().runs.length, 0);
  assert.equal(unfinishedFinishes(f.store).length, 0);
});

for (const returned of [false, true])
  test(`transient ${returned ? 'receipt' : 'error'} backs off outside the Work lock despite self wakes`, async t => {
    const f = await setup(t),
      journal = await submitted(f, f.lane, false);
    const dispatch = AgentWorkflow.prototype.dispatch;
    const times = [];
    let probe;
    t.mock.method(AgentWorkflow.prototype, 'dispatch', async function (command) {
      if (command.action !== 'finish') return dispatch.call(this, command);
      times.push(performance.now());
      // This competing operation can take the actual owner writer lock on every attempt.
      f.store.locked(() => assert.ok(true));
      if (times.length === 1)
        probe = new Promise((resolve, reject) =>
          setTimeout(() => {
            try {
              assert.equal(f.store.preparing(), true, 'cooldown holds no Work writer lock');
              f.store.locked(() => assert.ok(true), { waitMs: 0 });
              resolve();
            } catch (error) {
              reject(error);
            }
          }, 50),
        );
      if (times.length < 4) {
        journal.save();
        if (!returned) throw new ForgeError('SOURCE_CHANGED', 'Transient synthetic observation');
        return { revision: f.store.revision(), result: { terminal: false, code: 'SOURCE_CHANGED' } };
      }
      journal.state.result = {
        operationId: command.operationId,
        terminal: true,
        complete: false,
        status: 'failed',
      };
      journal.save();
      return { revision: f.store.revision(), result: journal.state.result };
    });
    const controller = new AbortController();
    const running = watchLandingWorker(f.store, controller.signal);
    try {
      await until(f, () => times.length === 4, 'bounded retries recover without an external event');
      await probe;
      assert.ok(times[1] - times[0] >= 90);
      assert.ok(times[2] - times[1] >= 190);
      assert.ok(times[3] - times[2] >= 390);
      f.store.locked(() => assert.ok(true));
    } finally {
      controller.abort();
      await running;
    }
  });

test('legacy land journals settle unavailable Lanes under their retained parent identity', async t => {
  const f = await setup(t);
  await f.agent.dispatch({ action: 'checkpoint', laneId: f.lane.laneId, message: 'Save input' });
  const command = resolveAgentDefaults(f.store, {
    action: 'land',
    operationId: randomUUID(),
    laneIds: [f.lane.laneId],
    channel: 'main',
  }).command;
  const journal = new LandJournal(f.store, command);
  const aliasCommand = { ...command, operationId: randomUUID() };
  new LandJournal(f.store, aliasCommand);
  await removeWorkspace(f);
  const select = f.store.select.bind(f.store);
  t.mock.method(f.store, 'select', (kind, id, ...args) =>
    kind === 'lanes' && id === f.lane.laneId ? undefined : select(kind, id, ...args),
  );
  await settleLand(f.store, command.operationId);
  const saved = JSON.parse(bytes(journal));
  assert.equal(saved.entries[0].result.code, 'LANE_UNAVAILABLE');
  assert.equal(pendingLands(f.store).length, 0);
  const first = bytes(journal);
  await settleLand(f.store, command.operationId);
  assert.equal(bytes(journal), first);
  const replay = await f.agent.dispatch({ ...command, wait: false });
  assert.equal(replay.result.terminal, true);
  assert.equal(replay.result.complete, false);
  assert.equal(replay.result.entries[0].code, 'LANE_UNAVAILABLE');
  const alias = await f.agent.dispatch({ ...aliasCommand, wait: false });
  assert.equal(alias.result.terminal, true);
  assert.equal(alias.result.complete, false);
  assert.equal(alias.result.entries[0].code, 'LANE_UNAVAILABLE');
});

test('canonical acceptance wins over cleaned inputs and retained cancelled observations', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  await removeWorkspace(f);
  journal.state.attempts[0].status = 'cancelled';
  journal.save();
  const select = f.store.select.bind(f.store);
  const acceptanceId = randomUUID();
  t.mock.method(f.store, 'select', (kind, id, ...args) =>
    kind === 'channelMoves' && id === journal.state.attempts[0].operations.accept
      ? { id: acceptanceId, status: 'accepted' }
      : select(kind, id, ...args),
  );
  const receipt = await settleFinish(f.store, journal.state.command);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.complete, true);
  assert.equal(receipt.acceptanceId, acceptanceId);
});

test('a newer check-only finish does not supersede a requested landing', async t => {
  const f = await setup(t),
    old = await submitted(f, f.lane);
  await submitted(f, f.lane, false);
  assert.equal(await settleFinish(f.store, old.state.command), undefined);
});

for (const mode of ['native-owner', 'server'])
  test(`settled native journals replay after ${mode} authority selection without remote execution`, async t => {
    const f = await setup(t);
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
    const journal = await submitted(f, f.lane);
    await removeWorkspace(f);
    const settled = await settleFinish(f.store, journal.state.command);
    updateHostState(f.store, state => {
      state.binding.sourceAuthority = { mode, epoch: mode === 'server' ? 1 : 0 };
    });
    const replay = await f.agent.dispatch({
      action: 'finish',
      operationId: settled.operationId,
      wait: false,
    });
    assert.deepEqual(replay.result, settled);
    assert.equal(f.store.load().runs.length, 0);
  });

test('a permanent execution error is retained once instead of entering the transient cooldown', async t => {
  const f = await setup(t),
    journal = await submitted(f, f.lane);
  const dispatch = AgentWorkflow.prototype.dispatch;
  let calls = 0;
  t.mock.method(AgentWorkflow.prototype, 'dispatch', function (command) {
    if (command.action !== 'finish') return dispatch.call(this, command);
    calls++;
    throw new ForgeError('LANE_UNAVAILABLE', 'Synthetic permanently unavailable Lane workspace');
  });
  const controller = new AbortController();
  const running = watchLandingWorker(f.store, controller.signal);
  try {
    await until(
      f,
      () =>
        JSON.parse(bytes(journal)).result?.settled &&
        landingWorkerStates(f.store).some(s => s.status === 'idle'),
      'permanent execution error settles',
    );
    assert.equal(calls, 1);
    assert.equal(JSON.parse(bytes(journal)).result.code, 'LANE_UNAVAILABLE');
  } finally {
    controller.abort();
    await running;
  }
});

test('transient land entry receipts use the controller cooldown while terminal receipts stay terminal', () => {
  const result = {
    terminal: false,
    entries: [{ status: 'waiting', code: 'WORK_BUSY', message: 'Concurrent owner write' }],
  };
  assert.throws(() => requireRecoveryProgress({ result }), { code: 'WORK_BUSY' });
  assert.doesNotThrow(() => requireRecoveryProgress({ result: { ...result, terminal: true } }));
  assert.doesNotThrow(() =>
    requireRecoveryProgress({
      result: { terminal: false, entries: [{ status: 'waiting', dependencies: [] }] },
    }),
  );
});

test('a settled unavailable land entry leaves independent entries executable', async t => {
  const f = await setup(t);
  await f.agent.dispatch({ action: 'checkpoint', laneId: f.lane.laneId, message: 'Save missing input' });
  const other = (await f.agent.dispatch({ action: 'start', outcome: 'Independent survivor' })).result;
  writeFileSync(join(other.path, 'survivor.txt'), 'independent source\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: other.laneId, message: 'Save survivor' });
  const command = resolveAgentDefaults(f.store, {
    action: 'land',
    operationId: randomUUID(),
    laneIds: [f.lane.laneId, other.laneId],
    channel: 'main',
  }).command;
  const journal = new LandJournal(f.store, command);
  await removeWorkspace(f);
  const select = f.store.select.bind(f.store);
  t.mock.method(f.store, 'select', (kind, id, ...args) =>
    kind === 'lanes' && id === f.lane.laneId ? undefined : select(kind, id, ...args),
  );
  assert.equal(await settleLand(f.store, command.operationId), false);
  const replay = await driveLand(f.work, command);
  assert.equal(
    replay.result.entries.find(entry => entry.inputs.some(pin => pin.laneId === f.lane.laneId)).code,
    'LANE_UNAVAILABLE',
  );
  assert.equal(
    replay.result.entries.find(entry => entry.inputs.some(pin => pin.laneId === other.laneId)).status,
    'accepted',
  );
  assert.equal(replay.result.terminal, true);
  assert.equal(replay.result.complete, false);
  assert.equal(JSON.parse(bytes(journal)).entries[0].result.settled, true);
});
