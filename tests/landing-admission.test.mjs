// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fixture } from './landing-batch-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';

import { FinishJournal, retainedFinishCommand, unfinishedFinishes } from '../dist/agent-finish-journal.js';
import { pendingLands } from '../dist/land-journal.js';
import { withQueueSlot } from '../dist/landing-queue.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('owner worker did not settle the submission');
}
async function drive(f, observe) {
  const controller = new AbortController();
  const worker = watchLandingWorker(f.store, controller.signal);
  try {
    return await until(observe);
  } finally {
    controller.abort();
    await worker;
  }
}
const runs = f => f.store.load().runs.filter(run => !run.mainCheck);
async function input(f) {
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Async source' })).result;
  writeFileSync(join(lane.path, 'async.txt'), 'durable source\n');
  return {
    lane,
    command: {
      action: 'finish',
      operationId: randomUUID(),
      laneId: lane.laneId,
      message: 'Async source',
      accept: true,
      wait: false,
    },
  };
}

test('async finish replay reads durable admission while its driver owns the queue', async t => {
  const f = await fixture(t, { remote: false });
  const { command } = await input(f);
  await f.agent.dispatch(command);
  await withQueueSlot(
    join(f.store.directory, 'finish-queue', command.operationId),
    async () => {
      const response = await f.agent.dispatch({
        action: 'finish',
        operationId: command.operationId,
        wait: false,
        lockWaitMs: 0,
      });
      assert.equal(response.result.durable, true);
      assert.equal(response.result.terminal, false);
    },
    { anchor: f.store.directory },
  );
  assert.equal(runs(f).length, 0);
  assert.equal(f.store.locked(() => f.store.revision()) > 0, true, 'no Work lock retained');
});

test('check-only async finish is recovered by the owner worker', async t => {
  const f = await fixture(t, { remote: false });
  const { command } = await input(f);
  delete command.accept;
  await f.agent.dispatch(command);
  await drive(f, () => runs(f).find(run => run.status === 'passed') && !unfinishedFinishes(f.store).length);
  const response = (
    await f.agent.dispatch({ action: 'finish', operationId: command.operationId, wait: false })
  ).result;
  assert.equal(response.complete, true);
  assert.equal(runs(f).length, 1);
  assert.equal(f.store.load().channelMoves.length, 0);
});

for (const action of ['finish', 'land']) {
  test(`${action} synchronous observer reads an admitted request while a worker drives`, async t => {
    const f = await fixture(t, { remote: false });
    const { lane, command: finish } = await input(f);
    if (action === 'land')
      await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' });
    const request =
      action === 'finish'
        ? finish
        : { action, operationId: randomUUID(), laneIds: [lane.laneId], wait: false };
    const admitted = (await f.agent.dispatch(request)).result;
    const controller = new AbortController();
    const worker = watchLandingWorker(f.store, controller.signal);
    let settled;
    try {
      settled = (await f.agent.dispatch({ ...request, wait: true })).result;
    } finally {
      controller.abort();
      await worker;
    }
    assert.equal(settled.complete, true);
    const pin = result => (action === 'finish' ? result.submissions[0] : result.entries[0].submissions[0]);
    assert.equal(pin(settled).submissionId, pin(admitted).submissionId);
    assert.equal(runs(f).length, 1);
  });

  test(`${action} failed submission replays its terminal result without a new check`, async t => {
    const f = await fixture(t, { remote: false });
    const { lane, command: finish } = await input(f);
    writeFileSync(join(lane.path, 'bad.txt'), 'synthetic failing input\n');
    if (action === 'land')
      await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Failing save' });
    const request =
      action === 'finish'
        ? finish
        : { action, operationId: randomUUID(), laneIds: [lane.laneId], wait: false };
    await f.agent.dispatch(request);
    await drive(
      f,
      () =>
        runs(f).some(run => run.status === 'failed') &&
        (action === 'finish' ? !unfinishedFinishes(f.store).length : !pendingLands(f.store).length),
    );
    const first = (await f.agent.dispatch(request)).result;
    const replay = (await f.agent.dispatch(request)).result;
    const pins = result =>
      action === 'finish' ? result.submissions : result.entries.flatMap(entry => entry.submissions);
    assert.equal(first.terminal, true);
    assert.equal(first.complete, false);
    assert.equal(pins(first)[0].state, 'terminal-failed');
    assert.deepEqual(pins(first), pins(replay));
    assert.equal(runs(f).length, 1);
    assert.equal(f.store.load().channelMoves.length, 0);
  });
}

test('land replay reads the retained journal while the owner holds its driver slot', async t => {
  const f = await fixture(t, { remote: false });
  const { lane } = await input(f);
  await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' });
  const command = { action: 'land', operationId: randomUUID(), laneIds: [lane.laneId], wait: false };
  await f.agent.dispatch(command);
  await withQueueSlot(
    join(f.store.directory, 'land-queue', command.operationId),
    async () => {
      const replay = await f.agent.dispatch(command);
      assert.equal(replay.result.durable, true);
      assert.equal(replay.result.terminal, false);
    },
    { anchor: f.store.directory },
  );
  assert.equal(runs(f).length, 0);
});

test('passing check before acceptance remains pending in an async receipt', async t => {
  const f = await fixture(t, { remote: false });
  const { command } = await input(f);
  await f.agent.dispatch(command);
  const retained = retainedFinishCommand(f.store, command.operationId);
  const journal = new FinishJournal(f.store, retained, retained.expectedHead);
  journal.state.attempts[0].run = { status: 'passed' };
  journal.save();
  const result = (await f.agent.dispatch(command)).result;
  assert.equal(result.terminal, false);
  assert.equal(result.complete, false);
  assert.equal(result.submissions[0].state, 'pending');
});
