// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { moduleUrl } from './convex-module.mjs';

test('Issue e165787c: publication keeps one listing range at Firefox scale and at one million files', async t => {
  const worker = fileURLToPath(new URL('./github-publication-memory-worker.mjs', import.meta.url));
  const action = moduleUrl('../convex/projectGithubImportArchive.ts');
  for (const files of [487_756, 1_000_000]) {
    await t.test(`${files} files`, subtest => {
      const directory = temporaryDirectory(subtest, 'forge-github-publication-');
      const run = mode =>
        execFileSync(
          process.execPath,
          [
            '--max-old-space-size=128',
            '--max-semi-space-size=8',
            '--expose-gc',
            worker,
            mode,
            String(files),
            directory,
            action,
          ],
          { encoding: 'utf8' },
        );
      run('prepare');
      const result = JSON.parse(run('publish').trim());
      subtest.diagnostic(JSON.stringify(result));
      assert.equal(result.files, files);
      assert.ok(result.pages >= Math.ceil(files / 65_536));
      assert.ok(Number.isFinite(result.listingBytes) && result.listingBytes < 16 * 1024 * 1024);
    });
  }
});
