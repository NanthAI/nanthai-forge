// SPDX-License-Identifier: Apache-2.0
// A Git command killed at its wait budget is a timeout (names FORGE_GIT_TIMEOUT_MS), not a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workGit } from '../dist/work-git.js';
import { gitFailure, gitTimeout } from '../dist/work-git-command.js';
import { nativeGitRunner } from '../dist/native-git-runner.js';

test('an ETIMEDOUT child error is WORK_GIT_TIMEOUT whichever caller reports it', () => {
  const e = gitFailure({ code: 'ETIMEDOUT', signal: 'SIGTERM', stderr: '' }, ['bundle', 'create']);
  assert.equal(e.code, 'WORK_GIT_TIMEOUT');
  assert.match(e.message, /Git bundle exceeded its \d+ms wait budget \(FORGE_GIT_TIMEOUT_MS\)/);
  assert.equal(gitFailure({ status: 128, stderr: 'fatal: x' }, ['bundle']).code, 'WORK_GIT_FAILED');
});

test('a progressing Git bundle can outlive the wait budget and a stalled one still fails (6b812713)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = () =>
    Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
  let active = child();
  const spawn = t.mock.method(childProcess, 'spawn', () => active);
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  let childExit = [null, 'SIGKILL'];
  t.mock.method(process, 'kill', () => {
    active.emit('close', ...childExit);
    return true;
  });
  const runner = nativeGitRunner(false),
    half = Math.floor(gitTimeout() / 2);
  const bundle = () => runner.git('.', ['bundle', 'create', '--progress', 'fixture.bundle', 'HEAD']);
  const running = bundle();
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(half);
    active.stderr.write(`Writing objects: ${i}% (${i}/100)\r`);
  }
  active.emit('close', 0, null);
  await running;

  active = child();
  const stalled = assert.rejects(bundle(), error => error.code === 'WORK_GIT_TIMEOUT');
  t.mock.timers.tick(half);
  active.stderr.write('warning: synthetic diagnostic\n');
  t.mock.timers.tick(gitTimeout() - half);
  await stalled;

  active = child();
  childExit = [0, null];
  const otherHandlers = new Set(process.listeners('SIGINT'));
  const interrupted = assert.rejects(bundle(), error => {
    assert.equal(error.code, 'WORK_GIT_FAILED');
    assert.match(error.message, /signal=SIGINT/);
    return true;
  });
  const stop = process.listeners('SIGINT').find(listener => !otherHandlers.has(listener));
  assert.ok(stop);
  stop('SIGINT');
  await interrupted;
});

test('workGit past its budget reports WORK_GIT_TIMEOUT', t => {
  const root = mkdtempSync(join(tmpdir(), 'work-git-timeout-'));
  const saved = process.env.FORGE_GIT_TIMEOUT_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.FORGE_GIT_TIMEOUT_MS;
    else process.env.FORGE_GIT_TIMEOUT_MS = saved;
    rmSync(root, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', root]);
  // A repository-local alias stands in for a slow command (a large bundle).
  execFileSync('git', ['-C', root, 'config', 'alias.slow', '!sleep 5']);
  process.env.FORGE_GIT_TIMEOUT_MS = '1000';
  assert.throws(
    () => workGit(root, ['slow']),
    e => e.code === 'WORK_GIT_TIMEOUT',
  );
});
