// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const failure of ['none', 'exit', 'signal', 'ordinary']) {
  test(`synthetic static verification preserves ${failure} outcome with queued builds`, t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verify-static-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path, text) => writeFileSync(join(root, path), text);
    for (const directory of ['scripts', 'tests', 'node_modules/typescript/bin'])
      mkdirSync(join(root, directory), { recursive: true });
    for (const name of ['verify.mjs', 'verify-queue.mjs'])
      write(`scripts/${name}`, readFileSync(`scripts/${name}`));
    write('tests/worker-budget.mjs', 'export const workerBudget = () => 2;');
    write('scripts/test-files.mjs', 'export const fileTimeout = () => 1000;');
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        scripts: Object.fromEntries(
          ['build:core', 'build:web', 'check', 'format:check', 'lint'].map(name => [
            name,
            'node -e "process.exit(0)"',
          ]),
        ),
      }),
    );
    write(
      'node_modules/typescript/bin/tsc',
      failure === 'signal'
        ? "process.kill(process.pid, 'SIGKILL');"
        : `process.exit(${failure === 'exit' ? 137 : failure === 'ordinary' ? 7 : 0});`,
    );
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_STATIC_WORKERS: '2',
        FORGE_SELECTED_TESTS: JSON.stringify({ scope: 'full', tests: [] }),
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      failure === 'none' ? 0 : failure === 'ordinary' ? 1 : 137,
      result.stdout + result.stderr,
    );
    assert.match(result.stdout, /\[build:core\] ok/);
    assert.match(result.stdout, /\[test\] ok/);
  });
}
