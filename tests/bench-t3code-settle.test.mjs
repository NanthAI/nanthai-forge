// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { forgeArm, inProgressCalls, readCalls } from '../scripts/bench-t3code/forge-arm.mjs';
import { codexUsage, quotaHit } from '../scripts/bench-t3code/agent.mjs';

const fixture = t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-settle-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test(
  'agent dies during land: settle waits for relay receipt, keeps resolve Lanes, counts post-exit landing',
  { timeout: 15_000 },
  async t => {
    const dir = fixture(t),
      root = join(dir, 'task'),
      log = join(dir, 'calls.jsonl');
    const resolveRoot = root + '.forge-client/lanes/resolve';
    mkdirSync(join(resolveRoot, '.forge'), { recursive: true });
    writeFileSync(
      join(resolveRoot, '.forge/hosted-lane.json'),
      JSON.stringify({ selection: { laneId: 'resolve-lane' } }),
    );
    mkdirSync(root);
    let release, ready;
    const waiting = new Promise(done => {
      ready = done;
    });
    const gate = createServer((_req, res) => {
      release = () => res.end();
      ready();
    });
    gate.listen(0, '127.0.0.1');
    await once(gate, 'listening');
    const cli = join(dir, 'cli.mjs');
    writeFileSync(
      cli,
      `await (await fetch('http://127.0.0.1:${gate.address().port}')).text();\nconsole.log(JSON.stringify({action:'land',operationId:'landing-op',result:{}}));`,
    );
    const arm = forgeArm({ cli }, { callLog: log, ws: dir });
    let child;
    t.after(() => {
      release?.();
      child?.kill();
      arm.stopBroker();
      gate.closeAllConnections();
      gate.close();
    });
    const bin = join(dir, 'bin');
    const broker = await arm.binDir(bin);
    const env = await arm.agentEnv(root, 'task', {});
    child = spawn(join(bin, 'nforge'), ['agent', '.', 'land', '--save', '{}'], {
      cwd: resolveRoot,
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    const exited = once(child, 'close');
    await waiting;
    child.kill('SIGKILL');
    await exited;
    const agentExitedAt = Date.now() - 1;
    assert.equal(readCalls(log).length, 0, 'incident: no completed call or operation handle');
    assert.equal(inProgressCalls(log).length, 1, 'start record survives the caller');
    let abandoned = [];
    arm.abandonById = async id => {
      abandoned.push(id);
      return {};
    };
    const deadline = await arm.landing('task', 'task-lane', { deadlineMs: 0 });
    assert.equal(deadline.state, 'in-flight-at-deadline');
    assert.equal((await arm.closeTask(root, 'task-lane', deadline)).skipped, 'landing in flight');
    assert.deepEqual(abandoned, []);
    let observations = 0;
    arm.observe = async operationId => {
      observations++;
      assert.equal(operationId, 'landing-op');
      return {
        phase: 'landed',
        observation: { state: 'landed' },
        timing: { committedAt: new Date().toISOString() },
        acceptance: { head: 'main-head' },
      };
    };
    const settling = arm.landing('task', 'task-lane', { pollMs: 5, deadlineMs: 2000, agentExitedAt });
    assert.equal(observations, 0, 'no server observation before the call publishes its handle');
    const brokerExited = once(broker.child, 'close');
    arm.stopBroker(); // Abnormal shutdown must drain the relay child, too.
    release();
    const landing = await settling;
    assert.equal((await brokerExited)[0], 0);
    assert.equal(landing.landed, true);
    assert.equal(landing.landedAfterAgentExit, true);
    assert.equal(landing.mainHead, 'main-head');
    assert.equal(inProgressCalls(log).length, 0);
    assert.equal(observations, 1);
    await arm.closeTask(root, 'task-lane', landing);
    assert.deepEqual(abandoned, ['task-lane', 'resolve-lane']);
  },
);

test('unknown server observation and missing cleanup evidence preserve the Lane', async t => {
  const dir = fixture(t),
    arm = forgeArm({}, { callLog: join(dir, 'calls'), ws: dir });
  arm.taskOps = () => ['unknown'];
  arm.observe = async () => ({ error: 'unavailable' });
  arm.abandonById = () => assert.fail('must not abandon unknown activity');
  const landing = await arm.landing('task', 'lane', { deadlineMs: 0 });
  assert.deepEqual(landing.inFlight, ['unknown']);
  assert.equal((await arm.closeTask(dir, 'lane', landing)).skipped, 'landing in flight');
  assert.equal((await arm.closeTask(dir, 'lane', null)).skipped, 'landing state unknown');
  arm.observe = async () => ({
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed' },
    error: { code: 'CHECK_FAILED' },
  });
  const failed = await arm.landing('task', 'lane', { deadlineMs: 0 });
  assert.equal(failed.state, 'terminal-failed');
  assert.deepEqual(failed.inFlight, [], 'known terminal errors must not masquerade as pending');
});

test('capacity stops use CLI errors or stderr for both providers, never agent prose', () => {
  for (const message of [
    'Selected model is at capacity. Please try a different model.',
    'server_overloaded',
    'overloaded',
  ]) {
    const stdout = [
      { type: 'error', message },
      { type: 'turn.failed', error: { message } },
    ]
      .map(JSON.stringify)
      .join('\n');
    assert.equal(quotaHit({ provider: 'codex', stdout, stderr: '', usage: codexUsage(stdout) }), true);
    assert.equal(
      quotaHit({
        provider: 'claude',
        stdout: JSON.stringify({ type: 'result', is_error: true, errors: [message] }),
        stderr: '',
        usage: { isError: true },
      }),
      true,
    );
    const claudeProse = [
      { type: 'assistant', message: { content: [{ type: 'text', text: message }] } },
      { type: 'result', is_error: true, subtype: 'error_max_turns', result: message },
    ]
      .map(JSON.stringify)
      .join('\n');
    assert.equal(
      quotaHit({ provider: 'claude', stdout: claudeProse, stderr: '', usage: { isError: true } }),
      false,
    );
    for (const provider of ['codex', 'claude']) {
      assert.equal(quotaHit({ provider, stdout: '', stderr: message }), true);
      const prose = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: message },
      });
      assert.equal(
        quotaHit({ provider, stdout: prose, stderr: '', usage: { ...codexUsage(prose), isError: true } }),
        false,
      );
    }
  }
});

// Execute the actual run-cell functions without importing the live driver or bench data.
const source = readFileSync(new URL('../scripts/bench-t3code/run-cell.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('run-cell.mjs', source, ts.ScriptTarget.Latest, true);
const fn = name =>
  ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);

test('run-cell task-error and abnormal cleanup observe before close and retain in-flight workspaces', async () => {
  for (const path of ['task-error', 'abnormal']) {
    const calls = [],
      records = [],
      lanes = new Map([['lane', { root: '/synthetic/task', task: 'task' }]]);
    const landing = { landed: false, state: 'in-flight-at-deadline', inFlight: ['call:pending'] };
    const context = {
      join,
      Date,
      Map,
      Object,
      String,
      Promise,
      console,
      arm: 'forge',
      ws: '/synthetic',
      dir: '/synthetic/evidence',
      tasks: [],
      config: {},
      bin: '/synthetic/bin',
      shared: null,
      depsEnv: {},
      objectCache: '/synthetic/cache',
      lanes,
      records,
      crashing: false,
      agentsStarted: true,
      forge: {
        startLane: async () => 'lane',
        agentEnv: async () => {
          throw Error('synthetic setup failure');
        },
        landing: async () => {
          calls.push('observe');
          return landing;
        },
        closeTask: async (_root, _lane, state) => {
          assert.equal(state, landing);
          calls.push('close');
          return { skipped: 'landing in flight' };
        },
        removeRoot: () => assert.fail('must retain active workspace'),
        stopBroker: () => {},
      },
      event: () => {},
      killAgents: () => [],
      writeResult: () => {},
      process: { env: {}, exit: () => {} },
      removeWorkspace: () => assert.fail('must retain active workspace'),
      landingFields: value => ({ landing: value }),
    };
    context.cleanupWorkspace = runInNewContext(`(${fn('cleanupWorkspace')})`, context);
    if (path === 'task-error') {
      const dispatch = runInNewContext(`(${fn('dispatch')})`, context);
      const record = await dispatch({ id: 'task', prompt: 'synthetic' }, 1);
      assert.equal(record.landing, landing);
      assert.equal(record.evidence.retainedWorkspace, '/synthetic/task');
    } else await runInNewContext(`(${fn('crash')})`, context)('synthetic crash');
    assert.deepEqual(calls, ['observe', 'close']);
  }
});

test('call-start journal stays local at dogfood scale and double scale', t => {
  const dir = fixture(t),
    log = join(dir, 'calls');
  for (const count of [575, 1150]) {
    const started = performance.now(),
      heap = process.memoryUsage().heapUsed;
    const entries = Array.from({ length: count }, (_, i) => [
      { callId: `call-${i}`, task: 'task', root: '/synthetic', startedAt: 'start' },
      { callId: `call-${i}`, endedAt: 'end' },
    ]).flat();
    entries.push({ callId: 'pending', task: 'other', root: '/synthetic/other', startedAt: 'start' });
    writeFileSync(log + '.progress.jsonl', entries.map(JSON.stringify).join('\n'));
    assert.deepEqual(
      inProgressCalls(log).map(c => c.callId),
      ['pending'],
    );
    assert.ok(readFileSync(log + '.progress.jsonl').byteLength < count * 160);
    t.diagnostic(
      `${count} completed calls: ${entries.length} local records, zero Convex calls/documents or byte-placement changes; ${(performance.now() - started).toFixed(1)} ms, heap delta ${process.memoryUsage().heapUsed - heap} bytes, peak RSS ${process.resourceUsage().maxRSS * 1024} bytes`,
    );
  }
});

test('final cell sweep preserves task workspaces retained at the landing deadline', async () => {
  let deferred = false;
  const context = {
    forge: {},
    records: [{ evidence: { retainedWorkspace: '/synthetic/task' } }],
    ws: '/synthetic',
    dir: '/synthetic/evidence',
    event: event => {
      deferred = event.event === 'cleanup-deferred';
    },
    removeWorkspace: () => assert.fail('must retain active workspace through final sweep'),
  };
  await runInNewContext(`(${fn('cleanupWorkspace')})`, context)('cell-done');
  assert.equal(deferred, true);
});
