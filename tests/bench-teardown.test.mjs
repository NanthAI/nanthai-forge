// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { benchCheckouts, teardownBench } from '../scripts/bench-teardown.mjs';
import { main } from '../scripts/bench-landing.mjs';

function work(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-teardown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  // Checkouts: Git work tree, Forge owner, bare seed, nested run checkout and a seed scratch directory.
  for (const path of [
    'forge-owner/.forge/work',
    'github-clone/.git',
    'seed-git/objects',
    'seed-git/refs',
    'runs/r1/checkout/node_modules',
    '.bench-seed-abc',
    'logs',
  ])
    mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, 'seed-git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'forge-owner', 'big.bin'), 'x'.repeat(1000));
  for (const path of ['stdout.log', 'results.json', 'summary.md', 'logs/run.jsonl', 'runs/r1/metrics.json'])
    writeFileSync(join(dir, path), 'keep\n');
  return dir;
}

test('teardown removes checkouts, bare seeds and scratch and keeps logs, json and summaries', t => {
  const dir = work(t);
  const result = teardownBench(dir);
  assert.equal(result.removed.length, 5);
  assert.deepEqual(result.failed, []);
  for (const path of ['forge-owner', 'github-clone', 'seed-git', 'runs/r1/checkout', '.bench-seed-abc'])
    assert.ok(!existsSync(join(dir, path)), path);
  for (const path of ['stdout.log', 'results.json', 'summary.md', 'logs/run.jsonl', 'runs/r1/metrics.json'])
    assert.ok(existsSync(join(dir, path)), path);
  assert.deepEqual(teardownBench(dir).removed, []); // Idempotent.
});

test('dry run lists but removes nothing; .bench-keep protects a directory', t => {
  const dir = work(t);
  writeFileSync(join(dir, 'github-clone', '.bench-keep'), '');
  assert.equal(teardownBench(dir, { dryRun: true }).removed.length, 4);
  assert.equal(benchCheckouts(dir).length, 4);
  assert.ok(existsSync(join(dir, 'forge-owner')));
  teardownBench(dir);
  assert.ok(existsSync(join(dir, 'github-clone')));
});

test('teardown refuses a missing directory and the filesystem root', () => {
  assert.deepEqual(teardownBench(join(tmpdir(), 'bench-teardown-missing-xyz')), { removed: [], failed: [] });
  assert.deepEqual(teardownBench('/'), { removed: [], failed: [] });
});

test('command line prints the result and rejects bad arguments', t => {
  const dir = work(t);
  const script = new URL('../scripts/bench-teardown.mjs', import.meta.url).pathname;
  const bad = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const dry = spawnSync(process.execPath, [script, dir, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).removed.length, 5);
  assert.ok(existsSync(join(dir, 'forge-owner')));
});

test('a failed benchmark run still removes its checkouts but keeps results', async t => {
  const dir = work(t);
  const out = join(dir, 'bench-out.json');
  await assert.rejects(
    main([
      '--source',
      join(dir, 'no-such-owner'),
      '--work',
      dir,
      '--out',
      out,
      '--github-owner',
      'nobody',
      '--sides',
      'forge',
    ]),
    // Whichever way setup fails here (no nforge on PATH, or a missing owner), teardown must still run.
    error => error instanceof Error,
  );
  assert.ok(!existsSync(join(dir, 'forge-owner')));
  assert.ok(existsSync(join(dir, 'stdout.log')));
  assert.ok(existsSync(`${out}.manifest.json`));
});

test('--keep-checkouts leaves them in place after a failed run', async t => {
  const dir = work(t);
  await assert.rejects(
    main([
      '--source',
      join(dir, 'no-such-owner'),
      '--work',
      dir,
      '--out',
      join(dir, 'bench-out.json'),
      '--github-owner',
      'nobody',
      '--sides',
      'forge',
      '--keep-checkouts',
    ]),
  );
  assert.ok(existsSync(join(dir, 'forge-owner')));
});
