// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from './landing-batch-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
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

for (const action of ['finish', 'land']) {
  test(`${action} durable admission survives lost response and replays terminal work`, async t => {
    const f = await fixture(t, { remote: false });
    const { lane, command: finish } = await input(f);
    if (action === 'land')
      await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' });
    const command =
      action === 'finish'
        ? finish
        : { action, operationId: randomUUID(), laneIds: [lane.laneId], wait: false };
    const admitted = (await f.agent.dispatch(command)).result;
    assert.equal(admitted.durable, true);
    if (action === 'land') assert.equal(admitted.replay.command.wait, false);
    assert.equal(admitted.terminal, false);
    assert.equal(admitted.complete, false);
    assert.equal(admitted.landingWorker.workers, 0);
    assert.match(admitted.message, /not running.*remains queued/);
    assert.equal(runs(f).length, 0, 'admission starts no check');
    assert.equal(f.store.load().channelMoves.length, 0);
    assert.equal(action === 'finish' ? unfinishedFinishes(f.store).length : pendingLands(f.store).length, 1);
    const replay = (await f.agent.dispatch(command)).result;
    const submissions = value =>
      action === 'finish' ? value.submissions : value.entries.flatMap(entry => entry.submissions);
    assert.deepEqual(submissions(replay), submissions(admitted));
    // A newer unsaved edit must not be recaptured when the service adopts the request.
    writeFileSync(join(lane.path, 'async.txt'), 'new unsaved edit\n');
    await drive(f, () => f.store.load().channelMoves.find(move => move.channel === 'main'));
    const terminal = (await f.agent.dispatch(command)).result;
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.complete, true);
    assert.equal(runs(f).length, 1);
    assert.equal(f.content('async.txt'), 'durable source\n');
    assert.equal(readFileSync(join(lane.path, 'async.txt'), 'utf8'), 'new unsaved edit\n');
    const synchronous = (await f.agent.dispatch({ ...command, wait: true })).result;
    assert.equal(synchronous.complete, true);
    assert.deepEqual(submissions(synchronous), submissions(terminal));
    assert.equal(runs(f).length, 1, 'same submitted work');
    assert.equal(f.store.load().channelMoves.length, 1);
    await assert.rejects(f.agent.dispatch({ ...command, message: 'Changed request' }), {
      code: 'WORK_OPERATION_CHANGED',
    });
  });
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

test('CLI exits after durable admission and owner work survives the client process', async t => {
  const f = await fixture(t, { remote: false });
  const { command } = await input(f);
  const child = spawn(
    process.execPath,
    [resolve('dist/cli.js'), 'agent', f.root, 'finish', JSON.stringify(command)],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', bytes => (output += bytes));
  child.stderr.on('data', bytes => (errors += bytes));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  const result = JSON.parse(output).result;
  assert.equal(result.durable, true);
  assert.equal(runs(f).length, 0);
  await drive(f, () => f.store.load().channelMoves.find(move => move.channel === 'main'));
  assert.equal(runs(f).length, 1);
});

test('MCP existing task registration admits finish and land without running checks', async t => {
  const f = await fixture(t, { remote: false });
  const { lane, command } = await input(f);
  const tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, options, handler) {
        tools.set(name, { options, handler });
      },
    },
    f.root,
  );
  try {
    const tool = tools.get('forge_task');
    for (const request of [
      command,
      { action: 'land', operationId: randomUUID(), laneIds: [lane.laneId], wait: false },
    ]) {
      const parsed = tool.options.inputSchema.command.parse(request);
      assert.equal(parsed.wait, false);
      const response = await tool.handler({ command: parsed });
      assert.equal(response.isError, undefined);
      assert.equal(JSON.parse(response.content[0].text).result.durable, true);
    }
    assert.equal(runs(f).length, 0);
  } finally {
    close();
  }
});

for (const action of ['finish', 'land']) {
  test(`${action} synchronous observer resumes an admitted request without a worker`, async t => {
    const f = await fixture(t, { remote: false });
    const { lane, command: finish } = await input(f);
    if (action === 'land')
      await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' });
    const request =
      action === 'finish'
        ? finish
        : { action, operationId: randomUUID(), laneIds: [lane.laneId], wait: false };
    const admitted = (await f.agent.dispatch(request)).result;
    const settled = (await f.agent.dispatch({ ...request, wait: true })).result;
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

test('client killed before receiving its enqueue response leaves recoverable work', async t => {
  const f = await fixture(t, { remote: false });
  const { command } = await input(f);
  const module = new URL('../dist/agent-workflow.js', import.meta.url).href;
  const script = `import { AgentWorkflow } from ${JSON.stringify(module)};
await new AgentWorkflow(process.argv[1]).dispatch(JSON.parse(process.argv[2]));
process.send('durable');
await new Promise(resolve=>setInterval(resolve,60000));`;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, f.root, JSON.stringify(command)],
    { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await once(child, 'message'); // No receipt is sent to the client.
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    const replay = (await f.agent.dispatch(command)).result;
    assert.equal(replay.durable, true);
    assert.equal(replay.terminal, false);
    await drive(f, () => f.store.load().channelMoves.find(move => move.channel === 'main'));
    assert.equal(runs(f).length, 1);
    assert.equal((await f.agent.dispatch(command)).result.complete, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

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
