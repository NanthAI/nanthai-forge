// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interruptedWait } from '../dist/agent-operation-wait.js';
import { guardedWaitExit, unfinishedWaitMessage } from '../dist/wait-exit-guard.js';
import { removeInstall } from '../dist/dependency-seal.js';

const guard = new URL('../dist/wait-exit-guard.js', import.meta.url).href;

/** A wait child as an agent harness starts it in the background: no TTY, stdin closed. */
function runWait(script) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.destroy();
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => done({ status, signal, stderr }));
  });
}

test('incident 203c1ce5: a wait that exits 0 with unfinished work becomes exit 3 with the reason', () => {
  for (const reply of [
    { result: { status: 'IN_PROGRESS', reason: 'budget' } },
    { result: { status: 'timeout' } },
    { result: { status: 'message' } },
    { result: { inProgress: true } },
  ]) {
    const guarded = guardedWaitExit(reply, undefined);
    assert.equal(guarded.exitCode, 3, JSON.stringify(reply));
    assert.match(guarded.reason, /without a terminal landing state/);
  }
  // Terminal outcomes and every non-zero exit are untouched.
  assert.deepEqual(guardedWaitExit({ result: { status: 'terminal' } }, 0), { exitCode: 0 });
  assert.deepEqual(guardedWaitExit({ result: { status: 'changed' } }, undefined), { exitCode: 0 });
  assert.deepEqual(guardedWaitExit({ result: { status: 'IN_PROGRESS' } }, 3), { exitCode: 3 });
  assert.deepEqual(guardedWaitExit({ result: { status: 'terminal' } }, 2), { exitCode: 2 });
});

test('incident 203c1ce5: an armed wait that exits 0 before its reply reports why and exits non-zero (stdin closed, no TTY)', async () => {
  const run = await runWait(`
    const { armWaitExitGuard } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '/synthetic/lane', 'wait', '{"operationIds":["x y"]}']);
    process.exit(0);
  `);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /ended before the work settled \(exit 3\)/);
  assert.match(run.stderr, /nforge agent \/synthetic\/lane wait '\{"operationIds":\["x y"\]\}'/);
});

test('incident 203c1ce5: a wait whose event loop drains (unsettled await) is not a quiet exit', async () => {
  const run = await runWait(`
    const { armWaitExitGuard } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '{}']);
    await new Promise(() => {});
  `);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ended before the work settled/);
  assert.match(run.stderr, /nforge agent \. wait/);
});

test('control: the same early exit without the guard is a silent exit 0', async () => {
  const run = await runWait(`process.exit(0);`);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
});

test('a settled wait reply exits as its own code, with nothing added', async () => {
  const run = await runWait(`
    const { armWaitExitGuard, settleWaitExit } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '{}']);
    process.exitCode = 3;
    settleWaitExit({ result: { status: 'IN_PROGRESS' } });
  `);
  assert.equal(run.status, 3);
  assert.equal(run.stderr, '');
});

test('a reply that says unfinished but would exit 0 is forced to exit 3 and says so', async () => {
  const run = await runWait(`
    const { armWaitExitGuard, settleWaitExit } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '{}']);
    settleWaitExit({ result: { status: 'IN_PROGRESS' } });
  `);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /without a terminal landing state/);
});

test('an error exit settles the guard: one error, no extra line', async () => {
  const run = await runWait(`
    const { armWaitExitGuard, settleWaitExit } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '{}']);
    settleWaitExit();
    process.exitCode = 1;
  `);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, '');
});

test('a wait whose shell closes before any handler exists exits 3 with the note, not silently by signal', async () => {
  const run = await runWait(`
    const { armWaitExitGuard } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '{}']);
    setInterval(() => {}, 1000); // test-signal: allow a live handle, as a real wait subscription is, so the signal can arrive
    process.kill(process.pid, 'SIGHUP');
  `);
  assert.equal(run.status, 3);
  assert.equal(run.signal, null);
  assert.match(run.stderr, /stopped by SIGHUP/);
});

test('a resume command whose JSON came from stdin says to pass it again', async () => {
  const run = await runWait(`
    const { armWaitExitGuard } = await import(${JSON.stringify(guard)});
    armWaitExitGuard(['agent', '.', 'wait', '--command-file', '-']);
    process.exit(0);
  `);
  assert.match(run.stderr, /pass it again/);
});

test('the resume message names the exit code and the exact command', () => {
  assert.match(unfinishedWaitMessage(13, 'nforge wait abc'), /exit 13.*nforge wait abc/);
});

test('a wait whose shell closes (SIGHUP) resumes like a budget return, never dies silently', () => {
  const stopped = interruptedWait('SIGHUP');
  assert.equal(stopped.exitCode, 3);
  assert.equal(stopped.reason, 'stopped');
  assert.match(stopped.note, /SIGHUP/);
  assert.match(stopped.note, /same command/);
});

test('removeInstall survives a child still writing into the folder (ENOTEMPTY teardown flake)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-teardown-'));
  t.after(() => removeInstall(directory));
  mkdirSync(join(directory, 'late'));
  // The writer only adds files while the folder exists, so a finished remove is never undone.
  const writer = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const end = Date.now() + 1500;
    process.stdout.write('go\\n');
    while (Date.now() < end) {
      try { writeFileSync(join(process.argv[1], 'late', String(Math.random())), 'x'); } catch {}
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer, directory], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise(done => child.stdout.once('data', done));
  removeInstall(directory);
  await new Promise(done => (child.exitCode === null ? child.once('exit', done) : done()));
  assert.equal(existsSync(directory), false);
});
