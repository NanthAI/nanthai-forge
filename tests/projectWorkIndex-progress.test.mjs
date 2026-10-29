// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressFixture } from './projectWorkIndex-progress-fixture.mjs';
test('dogfood-shaped synthetic Work index: measured bounded build', async t => {
  const f = progressFixture();
  const started = performance.now();
  let result;
  do {
    result = await f.drive();
  } while (typeof result !== 'string');
  const metadata = JSON.parse(f.s.tables.projectWorkGenerations.get(result).metadata);
  assert.equal(metadata.counts.intents, 625);
  assert.equal(metadata.counts.lanes, 555);
  assert.equal(metadata.counts.checkpoints, 2789);
  assert.equal(metadata.counts.views, 2167);
  assert.equal(metadata.counts.runs, 1471);
  assert.equal(metadata.counts['runs:payload'], 2580);
  assert.equal(metadata.counts.automaticActions, 2001);
  assert(f.metrics.steps < 7451 / 3, 'at least threefold fewer durable steps than the measured baseline');
  assert(f.metrics.maxRpcBytes < 600000);
  assert.equal(
    [...f.s.tables.projectWorkRecords.values()].filter(r => r.collection.startsWith('_build')).length,
    0,
  );

  t.diagnostic(
    JSON.stringify({
      ...f.metrics,
      elapsedMs: performance.now() - started,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      scheduled: f.s.scheduled.length,
      counts: metadata.counts,
    }),
  );
});

test('a killed driver resumes from its committed cursor in a fresh process', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'forge-index-kill-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(root, 'saved.bin');
  const run = mode =>
    spawnSync(process.execPath, ['tests/projectWorkIndex-progress-worker.mjs', mode, path], {
      encoding: 'utf8',
    });
  const killed = run('kill');
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const resumed = run('resume');
  assert.equal(resumed.status, 0, resumed.stderr);
  t.diagnostic(resumed.stdout.trim());
});

test('pending builds expose committed phase counts and do no work while idle', async () => {
  const f = progressFixture(0.04);
  let result = await f.drive();
  assert.equal(result.pending, true);
  const before = structuredClone(f.metrics);
  const generation = [...f.s.tables.projectWorkGenerations.values()][0];
  const cursor = generation.ensureCursor;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.metrics, before);
  assert.equal(generation.ensureCursor, cursor);
  assert.equal(f.s.scheduled.length, 0, 'no build timer, scheduler or poller');
  const seen = [];
  do {
    if (result.pending) {
      const progress = JSON.parse(result.progress);
      assert.equal(progress.step, [...f.s.tables.projectWorkGenerations.values()][0].nextBatch);
      assert(progress.done <= progress.total);
      seen.push(progress);
    }
    result = await f.drive();
  } while (typeof result !== 'string');
  assert(seen.some(p => p.buildPhase === 'summaries' && p.total > 0));
});
