// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const root of ['.', './', 'absolute-slash', 'absolute', 'symlink', '../project with spaces'])
  test(`public saved reads do not obstruct sync/resolve with root ${root}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-source-placement-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const project = join(directory, 'project with spaces');
    mkdirSync(project);
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        resolve('tests/check-runtime.mjs'),
        resolve('tests/hosted-source-cache-placement-child.mjs'),
        root,
      ],
      {
        cwd: project,
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: 2 << 20,
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
