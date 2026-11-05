// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlDepsKey } from '../scripts/control-deps-key.mjs';
import { summarizeCacheRuns } from '../scripts/actions-cache-report.mjs';

const runtime = { platform: 'linux', arch: 'x64', versions: { node: '24.22.1' } };
const key = (t, lock, manifest = '{}', other = runtime) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-deps-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package-lock.json'), lock);
  writeFileSync(join(root, 'package.json'), manifest);
  return controlDepsKey(root, other);
};

test('the control dependency key follows the lockfile, platform and Node version only', t => {
  const base = key(t, '{"lockfileVersion":3}');
  assert.match(base, /^forge-control-deps-v2-linux-x64-node-24\.22\.1-[0-9a-f]{64}$/);
  assert.equal(key(t, '{"lockfileVersion":3}', '{"name":"other manifest"}'), base);
  assert.notEqual(key(t, '{"lockfileVersion":3,"packages":{}}'), base);
  assert.notEqual(key(t, '{"lockfileVersion":3}', '{}', { ...runtime, arch: 'arm64' }), base);
  assert.notEqual(key(t, '{"lockfileVersion":3}', '{}', { ...runtime, versions: { node: '24.23.0' } }), base);
});

test('workflow: only the default branch writes the dependency cache, before Candidate code, from the control key', () => {
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  const saves = [
    ...workflow.matchAll(
      / {6}- if: ([^\n]*)\n {8}uses: actions\/cache\/save@[a-f0-9]{40}[^\n]*\n {8}with:\n {10}path: \|\n {12}control\/node_modules/g,
    ),
  ];
  assert.equal(saves.length, 1);
  assert.match(
    saves[0][1],
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(saves[0][1], /steps\.deps\.outputs\.cache-hit != 'true'/);
  // Restores in test and pack jobs never save, and no job restores a prefix or a Candidate-keyed entry.
  assert.doesNotMatch(workflow, /restore-keys:/);
  assert.equal((workflow.match(/key: \$\{\{ steps\.deps-key\.outputs\.key \}\}/g) ?? []).length, 4);
  const plan = workflow.split('\n  hosted-plan:\n')[1].split(/\n  hosted-check:\n/)[0];
  assert(plan.indexOf('actions/cache/save@') < plan.indexOf('- id: plan'));
});

const job = (name, steps) => ({ name, conclusion: 'success', steps });
const restore = (seconds = 3) => ({
  name: 'Run actions/cache/restore@abc',
  conclusion: 'success',
  startedAt: '2026-11-05T10:00:00Z',
  completedAt: `2026-11-05T10:00:0${seconds}Z`,
});
const install = conclusion => ({ name: 'Run npm ci --ignore-scripts', conclusion });

test('the cache report counts a job as a miss exactly when its npm ci step ran', () => {
  const run = (createdAt, updatedAt, jobs) => ({ createdAt, updatedAt, jobs });
  const summary = summarizeCacheRuns([
    run('2026-11-05T10:00:00Z', '2026-11-05T10:08:00Z', [
      job('hosted-plan', [restore(), install('skipped')]),
      job('forge-hosted-0', [restore(5), install('skipped')]),
      job('forge-hosted-static', [restore(2), install('success')]),
      job('forge-static', [{ name: 'Run actions/checkout', conclusion: 'success' }]),
    ]),
    run('2026-11-05T11:00:00Z', '2026-11-05T11:10:00Z', [
      job('hosted-plan', [restore(), install('skipped')]),
    ]),
  ]);
  assert.equal(summary.jobs, 4);
  assert.equal(summary.misses, 1);
  assert.equal(summary.hitRate, 0.75);
  assert.equal(summary.restoreSecondsMedian, 3);
  assert.equal(summary.wallMinutesMedian, 10);
  assert.equal(summarizeCacheRuns([]).hitRate, null);
});
