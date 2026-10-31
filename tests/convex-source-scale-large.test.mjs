// SPDX-License-Identifier: Apache-2.0
// The two largest source-scale cases, split from convex-source-scale.test.mjs so
// check shards can run them in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { buildSavePages } from '../dist/hosted-save.js';
import { scaleFixture, at, saveInput as save } from './convex-source-scale-fixture.mjs';
test('5,000 changed files / 512 MB on a 28,000-file deep State complete with four bounded workers; parallelism changes no calls', async t => {
  const reports = [];
  for (const parallelism of [1, 4]) {
    const s = await scaleFixture({ parallelism, delay: 2 });
    try {
      const input = await save(s, 5000, 28000),
        id = await s.enqueue(input),
        report = await s.drain();
      assert.equal((await s.job(id)).status, 'completed');
      // The cap bounds fan-out tasks; the driving step can still be returning as they start.
      assert(report.peakWork <= parallelism && report.peakActive <= parallelism + 1);
      assert(report.readBytes >= 5000 * 100 * 1024);
      reports.push({ ...report, parallelism });
      if (parallelism === 4) {
        const saved = JSON.parse(await s.bytes((await s.job(id)).output)).state;
        const sourcePlan = JSON.parse(await s.bytes(input)),
          before = JSON.parse(await s.bytes(sourcePlan.baseline.object));
        const side = await s.putSpec(Buffer.from('main advanced\n'));
        const main = await s.json({
          ...before,
          parents: [sourcePlan.baseline.object.sha256],
          files: [...before.files, { path: 'main-added', blob: side.sha256, mode: 'file' }],
        });
        const inputs = buildComposePages([
            {
              laneId: randomUUID(),
              head: saved.sha256,
              version: 0,
              sourceVersion: 0,
              lifecycleVersion: 0,
              state: { object: saved, recipe: null },
            },
          ]),
          dependencies = buildComposePages([]);
        for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
        const plan = await s.json({
          schema: 1,
          kind: 'forge-hosted-compose-input',
          base: { head: main.sha256, receiptId: 'moved-main' },
          main: { object: main, recipe: null },
          inputs: inputs.manifest,
          dependencies: dependencies.manifest,
          algorithm: 'forge-native-compose-v1',
          message: 'finish',
          at,
        });
        const composeId = await s.enqueue(plan),
          compose = await s.drain();
        assert.equal((await s.job(composeId)).status, 'completed');
        const result = JSON.parse(await s.bytes((await s.job(composeId)).output));
        assert.equal(result.result.status, 'clean');
        assert.equal(JSON.parse(await s.bytes(result.result.state)).files.length, 28001);
        t.diagnostic(JSON.stringify({ finishComposition: compose }));
      }
    } finally {
      s.restore();
    }
  }
  assert.equal(reports[0].calls, reports[1].calls, 'fan-out does not add function or storage calls');
  assert(reports[1].wallMs < reports[0].wallMs, 'concurrent independent windows improve wall time');
  t.diagnostic(
    JSON.stringify({
      reports,
      speedup: reports[0].wallMs / reports[1].wallMs,
      actionGBHours: (reports[1].actionMs / 3600000) * 0.5,
    }),
  );
});
test('10,000-file move changes 20,000 paths without rereading baseline file bodies', async t => {
  const s = await scaleFixture();
  try {
    const pin = await s.putSpec({ size: 1024 * 1024, index: 1 }),
      files = Array.from({ length: 10000 }, (_, i) => ({
        path: `old/a/b/c/${String(i).padStart(6, '0')}`,
        blob: pin.sha256,
        mode: 'file',
      }));
    const baseline = await s.json({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'before move',
      at,
    });
    const changes = files.flatMap(f => [
      { path: f.path, before: { blob: f.blob, mode: f.mode }, after: null },
      {
        path: f.path.replace('old/', 'new/'),
        before: null,
        after: { blob: f.blob, mode: f.mode, content: { object: pin, recipe: null } },
      },
    ]);
    const pages = buildSavePages(changes);
    for (const p of pages.pages) await s.json(p.value);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: baseline, recipe: null },
      pages: pages.root,
      pageCount: pages.pages.length,
      changeCount: changes.length,
      message: 'move',
      at,
    });
    const id = await s.enqueue(input),
      report = await s.drain();
    assert.equal((await s.job(id)).status, 'completed');
    const result = JSON.parse(await s.bytes((await s.job(id)).output)),
      state = JSON.parse(await s.bytes(result.state));
    assert.equal(state.files.length, 10000);
    assert(state.files.every(f => f.path.startsWith('new/')));
    // Cursor/task data now uses R2 too. Count those physical reads, while
    // asserting the actual requirement: no baseline file body was reread.
    assert(report.readObjects >= 2 + pages.pages.length);
    assert.equal(s.readCounts.get(pin.sha256) ?? 0, 0, 'moved file body stays unread');
    assert(report.steps < changes.length / 100);
    t.diagnostic(JSON.stringify({ rename: report }));
  } finally {
    s.restore();
  }
});
