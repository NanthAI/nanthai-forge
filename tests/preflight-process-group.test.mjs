// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 168e4ed8 (friction Lane fe781875; lead 2026-11-22: orphaned typechecks ran 18 min outside
// heavy). A test file past its per-file limit is killed and named, and nothing a preflight command
// started outlives it: not when the command ends, and not when the preflight process itself dies.
// Every wait here is on a socket event: the processes under test hold a connection to this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { finishGates } from '../dist/agent-default-gates.js';
import { readPreflightReceipt } from '../dist/agent-preflight.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { spawnCaptured } from '../dist/agent-preflight-capture.js';

/** A server the processes under test connect to; `closed()` settles when the first one goes away. */
async function holder(t) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connected = once(server, 'connection');
  t.after(() => server.close());
  return {
    port: server.address().port,
    connected,
    closed: async () => once((await connected)[0].resume(), 'close'),
  };
}
async function lane(t, testText, fileTimeoutSeconds, more = {}) {
  const files = {
    'package.json': JSON.stringify({
      type: 'module',
      ...(fileTimeoutSeconds ? { forge: { preflight: { fileTimeoutSeconds } } } : {}),
    }),
    'scripts/forge-check.mjs': '',
    'tests/docs.test.mjs': testText,
    ...more,
  };
  const s = agentFixture(t, {
    base: { ...files, 'README.md': 'Before\n' },
    lane: { ...files, 'README.md': 'After\n' },
  });
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'require' });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  t.mock.method(process.stderr, 'write', () => true);
  return s;
}
const advice = { changedPaths: { paths: ['tests/docs.test.mjs'], complete: true } };

test('Item 168e4ed8: a test file that never resolves is killed at its per-file limit and named in the preflight result', async t => {
  const hold = await holder(t);
  // The open connection keeps the file's process alive: its test never settles.
  const s = await lane(
    t,
    `import test from 'node:test'; import { connect } from 'node:net';\ntest('fixture never resolves', () => new Promise(() => connect(${hold.port}, '127.0.0.1')));\n`,
    2,
  );
  assert.throws(
    () =>
      finishGates(s.root, s.caps.agentDefaults, { laneId: s.lane.laneId, head: s.lane.head }, advice, true),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.match(
        error.message,
        /tests\/docs\.test\.mjs timed out: killed after \d+ s at the per-file limit of 2 s/,
      );
      return true;
    },
  );
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.deepEqual(
    receipt.timedOut.map(item => item.file),
    ['tests/docs.test.mjs'],
  );
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.failure.files, ['tests/docs.test.mjs']);
  // The hung file's process is gone: its connection closed.
  await hold.closed();
});

test('Item 168e4ed8: in one group, only the file past its limit is killed and named; the file that passed stays passed', async t => {
  const hold = await holder(t);
  const s = await lane(
    t,
    `import test from 'node:test'; import { connect } from 'node:net';\ntest('fixture never resolves', () => new Promise(() => connect(${hold.port}, '127.0.0.1')));\n`,
    2,
    { 'tests/quick.test.mjs': "import test from 'node:test';\ntest('passes at once', () => {});\n" },
  );
  const both = { changedPaths: { paths: ['tests/docs.test.mjs', 'tests/quick.test.mjs'], complete: true } };
  assert.throws(
    () => finishGates(s.root, s.caps.agentDefaults, { laneId: s.lane.laneId, head: s.lane.head }, both, true),
    error => error.code === 'PREFLIGHT_REQUIRED',
  );
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.deepEqual(
    receipt.timedOut.map(item => item.file),
    ['tests/docs.test.mjs'],
  );
  assert.deepEqual(receipt.failure.files, ['tests/docs.test.mjs']);
  await hold.closed();
});

test('Item 168e4ed8: a process a passing test leaves running is stopped with its preflight command', async t => {
  const hold = await holder(t);
  // The test passes once its helper is connected to this test, and leaves the helper running.
  const s = await lane(
    t,
    `import test from 'node:test'; import { spawn } from 'node:child_process'; import { once } from 'node:events';\ntest('leaves a helper running', async () => { const helper = spawn(process.execPath, ['-e', "require('node:net').connect(${hold.port}, '127.0.0.1', () => process.stdout.write('up'))"], { stdio: ['ignore', 'pipe', 'ignore'] }); await once(helper.stdout, 'data'); helper.stdout.destroy(); helper.unref(); });\n`,
  );
  finishGates(s.root, s.caps.agentDefaults, { laneId: s.lane.laneId, head: s.lane.head }, advice, true);
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId).passed, true);
  await hold.connected;
  await hold.closed();
});

test('Item 168e4ed8: when the preflight process dies, the command it was running dies with it', async t => {
  const hold = await holder(t);
  const capture = new URL('../dist/agent-preflight-capture.js', import.meta.url).href;
  const tmp = temporaryDirectory(t, 'killed-preflight-');
  // A stand-in preflight: runs one command through the capture helper and blocks on it.
  const preflight = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { spawnCaptured } = await import(${JSON.stringify(capture)});
spawnCaptured(process.execPath, ['-e', "require('node:net').connect(${hold.port}, '127.0.0.1')"], {}, false);`,
    ],
    // Its own temporary root: a killed process cannot remove its capture folder.
    { stdio: 'ignore', env: { ...process.env, TMPDIR: tmp } },
  );
  t.after(() => preflight.kill('SIGKILL'));
  await hold.connected;
  // SIGKILL: no handler of the preflight's own runs; the command's group still goes.
  preflight.kill('SIGKILL');
  await hold.closed();
  // Nor does the capture folder nobody is left to read (forge-preflight-err-*).
  assert.deepEqual(readdirSync(tmp), []);
});

test(
  'Item 168e4ed8: a command that ends between the status poll and the liveness check keeps its exit status',
  { skip: process.platform === 'win32' && 'no wrapper process on Windows' },
  t => {
    // Incident: tests/agent-inline-preflight.test.mjs failed a hosted check once (expected
    // PREFLIGHT_BUDGET_EXCEEDED, got PREFLIGHT_REQUIRED). Its mocked clock made the 10 s liveness check
    // run on every poll; a wrapper that had just written its status and exited (a zombie this blocked
    // loop cannot reap) read as gone, and the passing command reported no status.
    const tmp = temporaryDirectory(t, 'liveness-race-');
    const gate = join(tmp, 'release');
    const realSpawnSync = childProcess.spawnSync;
    let checks = 0;
    t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
      if (command !== '/bin/ps') return realSpawnSync(command, args, options);
      checks++;
      // The command is released and the wrapper ends, status written, before the liveness answer.
      writeFileSync(gate, 'go');
      for (let attempt = 0; attempt < 5_000; attempt++) {
        const state = realSpawnSync(command, args, options);
        if (String(state.stdout).trim().startsWith('Z')) return state;
      }
      throw new Error('the wrapper never ended');
    });
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.spawnSync = realSpawnSync;
      syncBuiltinESMExports();
    });
    const fixed = Date.parse('2026-01-01T00:00:00.000Z');
    let reads = 0;
    t.mock.method(Date, 'now', () => fixed + 11_000 * reads++);
    const run = spawnCaptured(
      process.execPath,
      ['-e', 'const fs = require("node:fs"); while (!fs.existsSync(process.argv[1]));', gate],
      { cwd: tmp },
      false,
    );
    assert(checks > 0, 'the liveness check ran');
    assert.equal(run.status, 0);
    assert.equal(run.errorCode, null);
  },
);
