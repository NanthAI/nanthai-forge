// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';

async function history(s, count) {
  const content = await s.putSpec(Buffer.from('synthetic file\n'));
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/synthetic/module-${String(i).padStart(6, '0')}.ts`,
    mode: 'file',
    blob: content.sha256,
  }));
  const small = [{ path: 'root.txt', mode: 'file', blob: content.sha256 }];
  const state = (parents, message, entries) =>
    s.json({
      schema: 1,
      kind: 'forge-source-state',
      parents: parents.map(p => p.sha256),
      files: entries,
      message,
      at,
    });
  // Large historical trees were deleted on both tips. The ancestry children
  // must verify them; final merge assembly needs only the small shared base.
  const root = await state([], 'root', small),
    leftBase = await state([root], 'left-base', small),
    rightBase = await state([root], 'right-base', small),
    left = await state([root, leftBase], 'left-history', files),
    right = await state([root, rightBase], 'right-history', files),
    selected = await state([left], 'selected', [
      ...small,
      { path: 'selected.txt', mode: 'file', blob: content.sha256 },
    ]);
  let main = await state([right], 'main', [
    ...small,
    { path: 'main-0.txt', mode: 'file', blob: content.sha256 },
  ]);
  return {
    manifestBytes: left.size,
    selected,
    faultPin: left,
    async plan(race) {
      if (race)
        main = await state([main], `main-${race}`, [
          ...small,
          ...Array.from({ length: race + 1 }, (_, i) => ({
            path: `main-${i}.txt`,
            mode: 'file',
            blob: content.sha256,
          })),
        ]);
      const inputs = buildComposePages([
        {
          laneId: randomUUID(),
          head: selected.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: selected, recipe: null },
        },
      ]);
      const dependencies = buildComposePages([]);
      for (const p of [...inputs.pages, ...dependencies.pages]) await s.json(p.value);
      return s.json({
        schema: 1,
        kind: 'forge-hosted-compose-input',
        base: { head: main.sha256, receiptId: `main-${race}` },
        main: { object: main, recipe: null },
        inputs: inputs.manifest,
        dependencies: dependencies.manifest,
        algorithm: 'forge-native-compose-v1',
        message: 'compose original selection',
        at,
      });
    },
  };
}
for (const count of [29000, 58000]) {
  test(`${count} files: multiple-parent ancestry and repeated main races stay within worker and call budgets`, async t => {
    const reports = [];
    for (const fault of [false, true]) {
      const s = await scaleFixture();
      try {
        const h = await history(s, count),
          parts = [];
        for (let race = 0; race < 2; race++) {
          const id = await s.enqueue(await h.plan(race));
          if (fault && race === 0)
            s.failRequestOnce.push(
              (message, item) =>
                message.kind === 'fetch' &&
                item.name === 'projectConvexSourceTask:run' &&
                message.args.url.includes(h.faultPin.sha256),
            );
          const first = await s.drain({ idle: false });
          if ((await s.job(id)).status !== 'completed') {
            await s.invoke('projectConvexSourceStore:dispatch', { projectId: s.projectId, jobId: id });
            const repair = await s.drain();
            for (const key of [
              'calls',
              'functionCalls',
              'documentsRead',
              'documentsWritten',
              'readObjects',
              'readBytes',
            ])
              first[key] += repair[key];
            first.maxStepMs = Math.max(first.maxStepMs, repair.maxStepMs);
            first.maxRssBytes = Math.max(first.maxRssBytes, repair.maxRssBytes);
          }
          assert.equal(
            s.failRequestOnce.length,
            0,
            JSON.stringify({ count, fault, manifestBytes: h.manifestBytes, first, calls: s.calls }),
          );
          const job = await s.job(id);
          assert.equal(job.status, 'completed');
          const result = JSON.parse(await s.bytes(job.output));
          assert.equal(result.result.status, 'clean');
          assert.equal(JSON.parse(await s.bytes(result.result.state)).files.length, race + 3);
          assert.equal(s.tables.projectSourceSteps.size, race + 1, 'one execution per requested composition');
          assert(first.maxRssBytes < 400 * 1024 * 1024 && first.maxStepMs < 60000);
          assert.equal(first.storageCalls, 0);
          parts.push(first);
        }
        const totals = parts.reduce((out, r) => {
          for (const key of ['functionCalls', 'documentsRead', 'documentsWritten'])
            out[key] = (out[key] ?? 0) + r[key];
          return out;
        }, {});
        reports.push({
          fault,
          count,
          manifestBytes: h.manifestBytes,
          ...totals,
          maxRssBytes: Math.max(...parts.map(r => r.maxRssBytes)),
          maxStepMs: Math.max(...parts.map(r => r.maxStepMs)),
          failedActions: parts.reduce((n, r) => n + r.failedActions, 0),
          maxFailedRssBytes: Math.max(...parts.map(r => r.maxFailedRssBytes)),
          maxFailedStepMs: Math.max(...parts.map(r => r.maxFailedStepMs)),
        });
        assert(s.metrics.every(m => m.maxRssBytes < 400 * 1024 * 1024 && m.elapsedMs < 60000));
        assert.equal(s.ready.length, 0);
        const idleCalls = s.calls.length;
        await s.drain();
        assert.equal(s.calls.length, idleCalls);
      } finally {
        s.restore();
      }
    }
    const [healthy, repair] = reports;
    // One failed bounded quantum plus its accounting call/read; the retry row
    // carries the counter in its existing write. Completed siblings never rerun.
    assert(repair.functionCalls <= healthy.functionCalls + 4, JSON.stringify(reports));
    assert(repair.documentsRead <= healthy.documentsRead + 23, JSON.stringify(reports));
    assert(repair.documentsWritten <= healthy.documentsWritten + 1, JSON.stringify(reports));
    t.diagnostic(
      JSON.stringify({
        reports,
        faultOverhead: {
          calls: repair.functionCalls - healthy.functionCalls,
          reads: repair.documentsRead - healthy.documentsRead,
          writes: repair.documentsWritten - healthy.documentsWritten,
        },
      }),
    );
  });
}
