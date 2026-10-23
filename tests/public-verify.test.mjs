// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { benchmarkPlan } from '../scripts/bench-landing-shard.mjs';
import { sourceFiles } from '../scripts/test-impact.mjs';
import { publicVerify } from '../scripts/public-verify.mjs';

test('public full-suite partitions are deterministic and cover every file exactly once', () => {
  const files = sourceFiles();
  const expected = readdirSync('tests')
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => `tests/${name}`)
    .sort();
  for (const count of [1, 24, expected.length + 5]) {
    const plan = benchmarkPlan(count, {}, files);
    assert.equal(plan.selection.scope, 'full');
    assert.deepEqual(plan.selection.tests, expected);
    assert.deepEqual(plan.groups.flat().sort(), expected);
    assert.equal(new Set(plan.groups.flat()).size, expected.length);
    assert.equal(plan.groups.length, Math.min(count, expected.length));
    assert.deepEqual(plan.groups, benchmarkPlan(count, {}, new Map([...files].reverse())).groups);
  }
  const added = 'tests/zzz-new-public-test.test.mjs';
  files.set(added, '// Synthetic new file\n');
  const next = benchmarkPlan(24, {}, files);
  assert.deepEqual(next.groups.flat().sort(), [...expected, added].sort());
  assert.equal(next.groups.flat().filter(file => file === added).length, 1);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-public-verify-'));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.RUNNER_TEMP = root;
  return join(root, 'public-verify-plan.json');
}

test('public shards use the Forge executor and consume builds without rerunning static steps', t => {
  const path = fixture(t);
  const expected = benchmarkPlan(24, {});
  for (const shard of ['0', '23', 'static']) {
    const calls = [];
    publicVerify(shard, '24', (command, args, options) =>
      calls.push({ command, args, env: { ...options.env } }),
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'node');
    if (shard === 'static') {
      assert.deepEqual(calls[0].args, ['scripts/verify.mjs']);
      assert.deepEqual(JSON.parse(calls[0].env.FORGE_SELECTED_TESTS).tests, []);
    } else {
      assert.deepEqual(calls[0].args, ['scripts/test-files.mjs', ...expected.groups[Number(shard)]]);
    }
    assert.equal(calls[0].env.FORGE_TEST_WORKERS, '2');
    assert.equal(calls[0].env.FORGE_TEST_EVENTS, '1');
  }
});

test('public verification rejects invalid partitions and propagates command failure', t => {
  fixture(t);
  const execute = () => assert.fail('invalid shard must not execute a command');
  for (const count of [undefined, '0', '-1', '1.5', 'Infinity', '9007199254740992'])
    assert.throws(() => publicVerify('0', count, execute), /positive integer/);
  for (const shard of [undefined, '', '-1', '1.5', '24', '01'])
    assert.throws(() => publicVerify(shard, '24', execute), /Unselected public verification shard/);
  const failure = Object.assign(new Error('Synthetic shard failed'), { status: 1 });
  assert.throws(
    () =>
      publicVerify('0', '24', () => {
        throw failure;
      }),
    error => error === failure,
  );
});
