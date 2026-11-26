// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeFunctionReference } from 'convex/server';
import { retainedHostedValues } from '../dist/hosted-agent-journal.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { testDeploymentOrigin } from './trusted-origin.mjs';

const cli = fileURLToPath(new URL('../dist/cli-entry.js', import.meta.url));
const capabilities = 'projectHostedAgent:capabilities';

async function fixture(t, succeeds, pauseDiscovery = false) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    if (req.url === '/check') {
      entered.resolve();
      await release.promise;
      res.writeHead(succeeds ? 200 : 500).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { path, args } = JSON.parse(Buffer.concat(chunks).toString());
      if (path === capabilities && pauseDiscovery) {
        entered.resolve();
        await release.promise;
      }
      const method = req.url === '/api/query' ? 'query' : 'mutation';
      const value =
        path === 'projectHostedOverlaps:read'
          ? {
              behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'complete' },
              changedPaths: { paths: hosted.laneFiles.map(file => file.path), complete: true },
            }
          : await hosted.exchange.client[method](makeFunctionReference(path), args[0]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', value, logLines: [] }));
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ status: 'error', errorMessage: error.message, logLines: [] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = testDeploymentOrigin('http://127.0.0.1:' + server.address().port);
  const hosted = agentFixture(t, {
    lane: {
      'package.json': JSON.stringify({ scripts: { test: 'node --test tests/check.test.mjs' } }),
      'tests/check.test.mjs': `import assert from 'node:assert/strict';
assert.equal((await fetch('${url}/check')).status, 200);
`,
    },
  });
  hosted.address.url = url;
  await hosted.transport().dispatch('open', { laneId: hosted.lane.laneId });
  t.after(() => {
    release.resolve();
    server.closeAllConnections();
    server.close();
  });
  function run(action, command, flags = []) {
    const child = spawn(
      process.execPath,
      [cli, 'agent', hosted.root, action, ...flags, JSON.stringify(command)],
      {
        cwd: hosted.root,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORGE_AGENT_WAKE: 'off', FORGE_LOCAL_HEAVY_SLOTS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => child.kill());
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    const done = once(child, 'close').then(([code, signal]) => ({
      code,
      signal,
      stderr,
      reply: stdout ? JSON.parse(stdout.trim().split('\n').at(-1)) : undefined,
    }));
    return {
      child,
      done,
      async see(pattern) {
        while (!pattern.test(stderr))
          await Promise.race([
            once(child.stderr, 'data'),
            done.then(result => assert.fail(result.stderr || 'CLI exited before reporting its wait command')),
          ]);
      },
    };
  }
  hosted.calls.length = 0;
  return { hosted, entered, release, run };
}

test(
  'a killed preflight client leaves its failed result and the local wait wakes without Convex',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, false);
    const operationId = randomUUID();
    const run = f.run('preflight', { operationId });
    await run.see(/preflight:.*wait.*operationIds/);
    await Promise.race([f.entered.promise, run.done.then(result => assert.fail(JSON.stringify(result)))]);
    if (process.platform === 'win32') run.child.kill('SIGKILL');
    else process.kill(-run.child.pid, 'SIGKILL');
    assert.equal((await run.done).signal, 'SIGKILL');
    const pending = await f.run('wait', { operationIds: [operationId], timeoutSeconds: 0 }).done;
    assert.equal(pending.code, 3, pending.stderr);
    assert.equal(pending.reply.result.status, 'IN_PROGRESS');
    const watched = f.run('wait', { operationIds: [operationId] });
    await watched.see(/preflight: waiting/);
    const calls = f.hosted.calls.length;
    f.release.resolve();
    const failed = await watched.done;
    assert.equal(failed.code, 2, failed.stderr);
    assert.match(failed.stderr, /preflight result: FAILED[^\n]*AssertionError/);
    assert.equal(failed.reply.operationId, operationId);
    assert.equal(failed.reply.result.localPreflight.outcome, 'failed');
    assert.equal(failed.reply.result.localPreflight.tests, 1);
    const read = await f.run('wait', { operationIds: [operationId], timeoutSeconds: 0 }).done;
    assert.deepEqual(read.reply.result, failed.reply.result);
    assert.equal(f.hosted.calls.length, calls, 'both reads of the original run are local');
    assert.equal(f.hosted.calls.filter(call => call.name === capabilities).length, 1);
  },
);

test(
  'a background preflight returns one wake and the original id replays the completed result',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, true);
    const operationId = randomUUID();
    f.release.resolve();
    const started = await f.run('preflight', { operationId }, ['--no-wait']).done;
    assert.equal(started.code, 0, started.stderr);
    assert.equal(started.reply.result.status, 'IN_PROGRESS');
    assert.equal(started.reply.result.wake.command, started.reply.result.waitCommand);
    const { action, ...wait } = started.reply.result.next;
    assert.equal(action, 'wait');
    const done = await f.run(action, wait).done;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stderr, /preflight result: passed/);
    assert.equal(done.reply.result.localPreflight.outcome, 'passed');
    const calls = f.hosted.calls.length;
    const replay = await f.run('preflight', { operationId }).done;
    assert.deepEqual(replay.reply.result, done.reply.result);
    assert.equal(f.hosted.calls.length, calls);
  },
);

test(
  'foreground preflight returns the full run and ends with its result line',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, true);
    f.release.resolve();
    const done = await f.run('preflight', {}, ['--wait', '--detail']).done;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stderr.trim().split('\n').at(-1), /^preflight result: passed/);
    assert.equal(done.reply.result.plan.status, 'planned');
    assert.equal(done.reply.result.receipt.passed, true);
    assert.equal(done.reply.result.localPreflight.tests, 1);
  },
);

test(
  'a local wake exits when the preflight executor dies without its own result',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, true, true);
    const operationId = randomUUID();
    const run = f.run('preflight', { operationId }, ['--wait']);
    await Promise.race([f.entered.promise, run.done.then(result => assert.fail(result.stderr))]);
    const watched = f.run('wait', { operationIds: [operationId] });
    await watched.see(/preflight: waiting/);
    const executor = retainedHostedValues(f.hosted.root, operationId, 'preflight')['preflight-executor'];
    process.kill(executor.pid, 'SIGKILL');
    const done = await watched.done;
    f.release.resolve();
    assert.equal(done.code, 1, done.stderr);
    assert.match(done.stderr, /preflight result: refused.*ended without a result/);
    assert.equal((await run.done).code, 1);
  },
);

test(
  'a batch wait returns both a hosted landing and a retained local preflight',
  { timeout: 10_000 },
  async t => {
    const f = await fixture(t, true);
    f.release.resolve();
    const preflightId = randomUUID();
    const run = await f.run('preflight', { operationId: preflightId }, ['--wait']).done;
    assert.equal(run.code, 0, run.stderr);
    const landed = await f.hosted.transport().dispatch('finish', { laneId: f.hosted.lane.laneId });
    const submission = f.hosted.operations.get(landed.operationId);
    Object.assign(submission, {
      phase: 'landed',
      observation: { state: 'landed', pendingReason: null, cause: null },
      acceptance: { receiptId: 'fixture-accepted', head: f.hosted.lane.head },
    });
    const batch = await f.run('wait', {
      operationIds: [preflightId, landed.operationId],
      timeoutSeconds: 0,
    }).done;
    assert.equal(batch.code, 0, batch.stderr);
    assert.equal(batch.reply.result.submission.phase, 'landed');
    const [preflight] = batch.reply.result.preflights;
    assert.equal(preflight.operationId, preflightId);
    assert.equal(preflight.result.outcome, 'passed');
  },
);
