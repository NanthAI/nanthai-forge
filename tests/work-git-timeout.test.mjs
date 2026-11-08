// SPDX-License-Identifier: Apache-2.0
// A Git command killed at its wait budget is a timeout (names FORGE_GIT_TIMEOUT_MS), not a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workGit } from '../dist/work-git.js';
import { gitFailure } from '../dist/work-git-command.js';

test('an ETIMEDOUT child error is WORK_GIT_TIMEOUT whichever caller reports it', () => {
  const e = gitFailure({ code: 'ETIMEDOUT', signal: 'SIGTERM', stderr: '' }, ['bundle', 'create']);
  assert.equal(e.code, 'WORK_GIT_TIMEOUT');
  assert.match(e.message, /Git bundle exceeded its \d+ms wait budget \(FORGE_GIT_TIMEOUT_MS\)/);
  assert.equal(gitFailure({ status: 128, stderr: 'fatal: x' }, ['bundle']).code, 'WORK_GIT_FAILED');
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
