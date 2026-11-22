// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const worker = fileURLToPath(new URL('./github-publication-memory-worker.mjs', import.meta.url));
const mib = 1024 * 1024;
const cgroup = process.env.FORGE_GITHUB_PUBLICATION_CGROUP === '1';
const control = process.env.FORGE_GITHUB_PUBLICATION_CONTROL;
const image = 'node:24.22.1-alpine';
const bind = (directory, suffix = '') => [
  '--mount',
  `type=bind,source=${directory},target=${directory}${suffix}`,
];

async function fixture(t, files, directory, container) {
  const args = [worker, 'fixture', String(files), directory];
  const dependencies = bind(realpathSync(join(root, 'node_modules')), ',readonly');
  const child = container
    ? spawn(
        'docker',
        [
          'run',
          '--rm',
          '--init',
          '--name',
          container,
          '--network',
          'none',
          ...bind(root, ',readonly'),
          ...dependencies,
          ...bind(directory),
          image,
          'node',
          ...args,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
    : spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (container) execFileSync('docker', ['stop', '-t', '2', container], { stdio: 'ignore' });
    else child.kill();
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const origin = await Promise.race([
    once(lines, 'line').then(([line]) => line),
    exited.then(([code]) => {
      throw new Error(`Publication fixture exited (${code})`);
    }),
  ]);
  lines.close();
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  return origin;
}

test('Issues c6426ee9 and e165787c: publication reaches ready using bounded listing and pin ranges', async t => {
  const scratch = join(root, '.forge', 'scratch');
  if (cgroup) {
    mkdirSync(scratch, { recursive: true });
    process.env.FORGE_TEST_MODULE_DIRECTORY = mkdtempSync(join(scratch, 'publication-modules-'));
  }
  const action = moduleUrl('../convex/projectGithubImportArchive.ts');
  let previous;
  let controlFailed = false;
  for (const files of [487_756, 1_000_000]) {
    await t.test(`${files} files`, async subtest => {
      const directory = cgroup
        ? mkdtempSync(join(scratch, 'publication-replay-'))
        : temporaryDirectory(subtest, 'forge-github-publication-');
      execFileSync(process.execPath, [worker, 'prepare', String(files), directory]);
      const container = cgroup ? 'forge-import-fixture-' + randomUUID() : undefined;
      const origin = await fixture(subtest, files, directory, container);
      const dependencies = bind(realpathSync(join(root, 'node_modules')), ',readonly');
      const commands = (mode, entry, compatibility = '') => {
        const args = [worker, mode, String(files), directory, entry, origin, compatibility];
        return container
          ? [
              'docker',
              [
                'run',
                '--rm',
                '--memory',
                '435m',
                '--memory-swap',
                '435m',
                '--network',
                'container:' + container,
                ...bind(root, ',readonly'),
                ...dependencies,
                image,
                'node',
                ...(compatibility === 'control' ? ['--expose-gc'] : []),
                ...args,
              ],
            ]
          : [
              process.execPath,
              ['--max-old-space-size=128', '--max-semi-space-size=8', '--expose-gc', ...args],
            ];
      };
      for (const mode of container ? ['publish', 'retry-pins', 'retry-state'] : ['publish']) {
        const [bin, args] = commands(mode, action);
        const result = JSON.parse(execFileSync(bin, args, { encoding: 'utf8' }).trim());
        subtest.diagnostic(JSON.stringify(result));
        assert.equal(result.files, files);
        assert.equal(result.ready, true);
        assert.ok(result.queryCalls <= Math.ceil(files / 2000) + (mode === 'publish' ? 1 : 32));
        assert.ok(result.mutationCalls <= Math.ceil(files / 4000) + 8);
        assert.ok(result.pages >= Math.ceil(files / 65_536));
        if (cgroup) {
          assert.equal(result.cgroup.limit, 435 * mib);
          assert.equal(result.cgroup.swap, 0);
          assert.ok(result.cgroup.peak <= result.cgroup.limit);
          continue;
        }
        assert.ok(result.listingBytes < 16 * mib);
        for (const [phase, { heapUsed, arrayBuffers }] of Object.entries(result.retained)) {
          if (!previous) continue;
          const earlier = previous.retained[phase];
          assert.ok(earlier, phase);
          const growth = heapUsed + arrayBuffers - earlier.heapUsed - earlier.arrayBuffers;
          assert.ok(
            growth / (files - previous.files) <= 120,
            `${phase}: ${growth} additional retained bytes`,
          );
        }
        previous = result;
      }
      if (container && control) {
        // The older code may reach ready by reclaiming cache and collecting
        // aggressively. The live listing still violates the retention guard.
        const [bin, args] = commands('publish', control, 'control');
        const run = spawnSync(bin, args, { encoding: 'utf8' });
        assert.ok(run.status === 0 || run.status === 137, run.stderr);
        const result = run.status === 0 ? JSON.parse(run.stdout) : null;
        const failed = run.status === 137 || result?.listingBytes >= 16 * mib;
        controlFailed ||= failed;
        subtest.diagnostic(
          JSON.stringify({
            control: 'pre-795a3bb1',
            files,
            exit: run.status,
            failed,
            listingBytes: result?.listingBytes,
            cgroup: result?.cgroup,
          }),
        );
      }
    });
  }
  if (cgroup && control)
    assert.ok(controlFailed, 'pre-795a3bb1 passed both the hard limit and listing-retention guard');
});
