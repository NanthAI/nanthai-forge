// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
// Synthetic home paths exercise display redaction without using a developer's machine paths.
const fixtureHome = posix.join('/', 'Users', 'fixture');
const { checksModel, checkCommand, acceptanceChecks } = await import(
  moduleUrl('../web/src/settings/checks-model.ts')
);
const now = Date.parse('2026-10-15T12:00:00Z');
test('Checks promotes acceptance and recent checks, folds older definitions, counts local-day runs and failures', () => {
  const checks = [
    { id: 'old', name: 'Old agent experiment' },
    { id: 'required', name: 'verify' },
    { id: 'recent', name: 'Recent check' },
    { id: 'unused', name: 'Unused check' },
  ];
  const runs = [
    { id: 'a', checkId: 'old', startedAt: '2026-09-01T00:00:00Z', status: 'passed' },
    { id: 'b', checkId: 'required', startedAt: '2026-09-02T00:00:00Z', status: 'passed' },
    { id: 'c', checkId: 'recent', startedAt: '2026-10-15T11:00:00Z', status: 'failed' },
  ];
  const required = acceptanceChecks([{ automatic: { runId: 'b' } }], runs);
  const model = checksModel(checks, runs, required, now);
  assert.deepEqual(
    model.active.map(check => check.id),
    ['required', 'recent'],
  );
  assert.deepEqual(
    model.older.map(check => check.id),
    ['old', 'unused'],
  );
  assert.equal(model.today, 1);
  assert.equal(model.failed, 1);
  assert.equal(checksModel(checks, runs, required, now, 'unused').older[0].id, 'unused');
});
test('command labels hide machine paths, retain relative arguments and never mutate execution inputs', () => {
  const args = [
    `${fixtureHome}/projects/nanthai-forge/scripts/forge-check.mjs`,
    `--config=${fixtureHome}/other/config.json`,
    'scripts/local.mjs',
  ];
  const copy = [...args];
  assert.equal(
    checkCommand(`${fixtureHome}/.cache/runtime/bin/node`, args, ['NanthAi Forge']),
    'node scripts/forge-check.mjs --config=~/other/config.json scripts/local.mjs',
  );
  assert.equal(checkCommand('/opt/bin/node', ['/tmp/scratch.mjs']), 'node ~/…/scratch.mjs');
  assert.equal(
    checkCommand('node', [`${fixtureHome}/project/.forge/work/check-id/workspace/scripts/check.mjs`]),
    'node scripts/check.mjs',
  );
  assert.equal(
    checkCommand('node', [`${fixtureHome}/owner/.forge/work/lane-abc/scripts/check.mjs`]),
    'node scripts/check.mjs',
  );
  assert.deepEqual(args, copy);
});

test('historical one-off acceptance checks do not masquerade as the current main check', () => {
  const runs = [
    { id: 'old-run', checkId: 'one-off', startedAt: '2026-09-01T00:00:00Z', status: 'passed' },
    { id: 'current-run', checkId: 'verify', startedAt: '2026-10-15T11:00:00Z', status: 'passed' },
  ];
  const required = acceptanceChecks(
    [
      { channel: 'main', at: '2026-09-01T00:00:00Z', automatic: { runId: 'old-run' } },
      { channel: 'main', at: '2026-10-15T11:10:00Z', automatic: { runId: 'current-run' } },
    ],
    runs,
  );
  assert.deepEqual([...required], ['verify']);
});

test('long external paths keep the script filename visible in the short command', () => {
  const command = checkCommand(`${fixtureHome}/.cache/node/bin/node`, [
    `${fixtureHome}/projects/.forge-runtime/work-context/review-build/artifacts/another-directory/check-runtime.mjs`,
  ]);
  assert.equal(command, 'node ~/…/check-runtime.mjs');
});

test('runner infrastructure outcomes never count as failed tests', () => {
  const runs = ['runner-unavailable', 'runner-budget-exhausted'].map((status, i) => ({
    id: `infra-${i}`,
    checkId: 'verify',
    startedAt: '2026-10-15T11:00:00Z',
    status,
  }));
  const model = checksModel([{ id: 'verify', name: 'verify' }], runs, new Set(), now);
  assert.equal(model.today, 2);
  assert.equal(model.failed, 0);
});
