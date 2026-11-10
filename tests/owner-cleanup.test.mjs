// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Use a standalone process so no unrelated referenced handle can hide an unref'd join.
test('cleanup joins a late detached child before removing its owner', async () => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { cleanupOwner } from ${JSON.stringify(new URL('./owner-cleanup.mjs', import.meta.url).href)};
    import { spawn } from 'node:child_process';
    import { mkdtempSync, existsSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-late-'));
    let writer;
    setImmediate(() => {
      const child = writer = spawn(process.execPath, ['-e', "setTimeout(()=>require('fs').writeFileSync('done', 'done'), 100)"], { cwd: root, stdio: 'ignore', detached: true });
      child.unref();
    });
    await cleanupOwner(root);
    if (writer?.exitCode !== 0) throw new Error('Writer did not finish before removal');
    if (existsSync(root)) throw new Error('Owner survived cleanup');
    console.log('joined');
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', bytes => (output += bytes));
  child.stderr.on('data', bytes => (errors += bytes));
  const status = await new Promise(resolve => child.once('close', resolve));
  assert.equal(status, 0, errors);
  assert.match(output, /joined/);
});
