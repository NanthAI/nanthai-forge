// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, on, EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { makeFunctionReference } from 'convex/server';
import { selectCliBuild } from '../dist/cli-installation.js';
import { processAlive } from '../dist/local-process.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { trustedDist } from './release-trust-fixture.mjs';
import { testDeploymentOrigin } from './trusted-origin.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

async function fixture(t, pauseEnqueue = false) {
  const hosted = agentFixture(t);
  hosted.caps.features = ['landing-client-hold'];
  const faults = [];
  const enqueue = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  t.after(enqueue.resolve);
  const server = createServer(async (request, response) => {
    let name;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { path, args } = JSON.parse(Buffer.concat(chunks).toString());
      name = path;
      const ref = makeFunctionReference(path);
      const value =
        path === 'projectHostedLaneHistory:resolveLaneId'
          ? (hosted.calls.push({ name: path }), { ids: [hosted.lane.laneId] })
          : await (request.url === '/api/query'
              ? hosted.exchange.client.query(ref, args[0])
              : hosted.exchange.client.mutation(ref, args[0]));
      if (path === 'projectHostedLanding:enqueue') {
        const { operationId } = typeof value === 'string' ? JSON.parse(value) : value;
        const retained = hosted.operations.get(operationId);
        Object.assign(retained, {
          phase: 'landed',
          observation: { state: 'landed', pendingReason: null, cause: null },
          acceptance: { receiptId: 'fixture-accepted', head: hosted.lane.head },
        });
        submitted.resolve();
        if (pauseEnqueue) await enqueue.promise;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', value, logLines: [] }));
    } catch (error) {
      faults.push(`${name}: ${error.message}`);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'error', errorMessage: error.message, logLines: [] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = {
    ...hosted.address,
    url: testDeploymentOrigin(`http://127.0.0.1:${server.address().port}`),
  };
  const installation = realpathSync(temporaryDirectory(t, 'forge-held-land-cli-'));
  const dist = trustedDist().dist,
    build = dirname(dist);
  writeFileSync(join(build, '.cli-installation'), installation);
  writeFileSync(join(build, '.commit'), hosted.main.head);
  writeFileSync(join(installation, 'source.json'), JSON.stringify(address));
  selectCliBuild(installation, build);
  mkdirSync(hosted.root);
  const hold = join(installation, '.freeze');
  const command = { ...address, candidateId: hosted.candidate.id, composeOperationId: randomUUID() };
  const workers = () => {
    const path = `${hosted.root}.forge-client/agent/measurement-land.json`;
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  async function workerWaiting(operationId) {
    const path = `${hosted.root}.forge-client/agent/land/held-${operationId}.err`;
    const watcher = watch(path);
    try {
      const changes = on(watcher, 'change');
      while (!readFileSync(path, 'utf8').includes('waits for measurement hold')) await changes.next();
    } finally {
      watcher.close();
    }
  }
  function cli(action, flags, body) {
    const child = spawn(
      process.execPath,
      [join(dist, 'cli-entry.js'), 'agent', hosted.root, action, ...flags, JSON.stringify(body)],
      {
        cwd: hosted.root,
        env: {
          ...process.env,
          FORGE_AGENT_WAKE: 'off',
          FORGE_WORK_LOCK_WAIT_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const lines = new EventEmitter();
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      lines.emit('stderr');
    });
    const done = once(child, 'close').then(([code]) => ({
      code,
      stderr,
      receipt: stdout ? JSON.parse(stdout.trim().split('\n').at(-1)) : undefined,
    }));
    const observed = async text => {
      while (!stderr.includes(text)) {
        await Promise.race([
          once(lines, 'stderr'),
          done.then(result => assert.fail(result.stderr || 'CLI exited before reporting the hold')),
        ]);
      }
    };
    return { child, done, observed };
  }
  const sent = () => hosted.calls.filter(call => call.name === 'projectHostedLanding:enqueue');
  const submissions = () => sent().map(call => JSON.parse(call.args.request));
  const heldDurations = () => sent().map(call => call.args.heldMs);
  return {
    hosted,
    address,
    hold,
    command,
    cli,
    submissions,
    heldDurations,
    faults,
    submitted,
    enqueue,
    workers,
    workerWaiting,
  };
}

test(
  'measurement-held land returns a wait receipt and replays into one submission of the same operation',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, true);
    writeFileSync(f.hold, 'project measured-project\n');
    const request = { ...f.command, laneId: f.hosted.lane.laneId.slice(0, 8) };
    const run = (command = request) => f.cli('land', ['--save', '--no-wait'], command).done;
    const first = await run();
    assert.equal(first.code, 0, first.stderr);
    const { operationId, result } = first.receipt;
    assert.equal(result.hold.path, f.hold);
    assert.match(result.waitCommand, new RegExp(operationId));
    assert.deepEqual((await run({ ...request, operationId })).receipt, first.receipt);
    assert.deepEqual((await run({ ...request, message: 'Changed replay message' })).receipt, first.receipt);
    const wait = { ...f.address, operationIds: [operationId], until: 'acceptance' };
    const peek = await f.cli('wait', [], { ...wait, timeoutSeconds: 0 }).done;
    assert.equal(peek.code, 3, peek.stderr);
    assert.equal(peek.receipt.result.phase, 'measurement-hold');
    assert.deepEqual(peek.receipt.result.hold, result.hold);
    assert.deepEqual(f.hosted.calls, [], 'no release or hosted requests while held');

    const awaiting = f.cli('wait', [], wait);
    await awaiting.observed('held by measurement');
    await f.workerWaiting(operationId);
    rmSync(f.hold);
    await f.submitted.promise;
    const replay = await run();
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(replay.receipt.operationId, operationId);
    assert.equal(replay.receipt.result.phase, 'submitting');
    f.enqueue.resolve();
    const settled = await awaiting.done;
    assert.equal(
      settled.code,
      0,
      [settled.stderr, ...f.faults, ...f.hosted.calls.map(call => call.name)].join('\n'),
    );
    assert.equal(settled.receipt.result.submissions[0].submission.operationId, operationId);
    assert.equal(settled.receipt.result.submissions[0].submission.phase, 'landed');
    assert.deepEqual(
      f.submissions().map(request => request.operationId),
      [operationId],
    );
    assert(Number.isSafeInteger(f.workers()[0].heldMs), 'the detached worker durably records its hold');
    assert.deepEqual(f.heldDurations(), [f.workers()[0].heldMs]);
    assert.equal(
      f.hosted.calls.filter(call => call.name === 'projectHostedLaneHistory:resolveLaneId').length,
      1,
    );
  },
);

test(
  'a foreground replay recovers a stopped held submitter and a later hold replays the completed ID',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t);
    writeFileSync(f.hold, 'first measurement\n');
    const run = (command = f.command) => f.cli('land', ['--save', '--no-wait'], command).done;
    const first = await run();
    assert.equal(first.code, 0, first.stderr);
    const { operationId } = first.receipt;
    assert.equal(first.receipt.result.phase, 'measurement-hold');
    const [held] = f.workers();
    process.kill(held.worker.pid, 'SIGKILL');
    while (processAlive(held.worker)) await setImmediate();
    rmSync(f.hold);
    const foreground = f.cli('land', ['--save'], f.command);
    const settled = await foreground.done;
    assert.equal(settled.code, 0, settled.stderr);
    assert.equal(settled.receipt.result.submissions[0].submission.operationId, operationId);
    assert.notEqual(f.workers()[0].worker.pid, held.worker.pid, 'active wait recovered the stopped worker');
    assert(Number.isSafeInteger(held.holdStartedAt));
    assert.equal(f.workers()[0].holdStartedAt, held.holdStartedAt);
    assert.equal(f.workers()[0].heldMs, null, 'the replacement could not observe the end of the hold');
    assert.deepEqual(f.heldDurations(), [undefined], 'missing release time remains unknown on the wire');

    writeFileSync(f.hold, 'later measurement\n');
    const completed = await run({ ...f.command, operationId });
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(completed.receipt.result.phase, 'submission-finished');
    assert.equal(completed.receipt.operationId, operationId);
    const wait = { ...f.address, operationIds: [operationId], until: 'acceptance' };
    const observed = await f.cli('wait', [], wait).done;
    assert.equal(observed.code, 0, observed.stderr);
    assert.equal(observed.receipt.result.submissions[0].submission.operationId, operationId);
    assert.deepEqual(
      f.submissions().map(request => request.operationId),
      [operationId],
    );
  },
);

test(
  'ordinary land remains blocked before submitting while measurement holds another project',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t);
    writeFileSync(f.hold, 'project measured-project\n');
    const fwd = f.cli('land', ['--save'], f.command);
    await fwd.observed('waits for measurement hold');
    assert.equal(fwd.child.exitCode, null);
    assert.deepEqual(f.hosted.calls, []);
    rmSync(f.hold);
    const settled = await fwd.done;
    assert.equal(
      settled.code,
      0,
      [settled.stderr, ...f.faults, ...f.hosted.calls.map(call => call.name)].join('\n'),
    );
    assert.equal(settled.receipt.result.submission.phase, 'landed');
    assert.equal(f.heldDurations().length, 1);
    assert(
      Number.isSafeInteger(f.heldDurations()[0]),
      'the foreground duration reaches the detached submitter',
    );
    assert.deepEqual(
      f.submissions().map(request => request.operationId),
      [settled.receipt.operationId],
    );
  },
);

test('a recent CLI submits zero when it proceeds without a measurement hold', async t => {
  const f = await fixture(t);
  const settled = await f.cli('land', ['--save'], f.command).done;
  assert.equal(settled.code, 0, settled.stderr);
  assert.deepEqual(f.heldDurations(), [0]);
});
