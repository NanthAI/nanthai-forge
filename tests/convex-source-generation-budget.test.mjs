// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture } from './convex-source-scale-fixture.mjs';
import { generationGraph } from './source-generation-fixture.mjs';
for (const kind of ['closed-side', 'wide-closed-history'])
  test(`${kind}: worker State/call/byte budgets are independent of 0/10/400/800 history`, async t => {
    let baseline;
    for (const count of [0, 10, 400, 800])
      for (const conflict of [false, true]) {
        const { s, left, right, initial, historical } = generationGraph(kind, count, conflict),
          oracle = await s.compose(initial, { complete: true }),
          worker = await scaleFixture();
        try {
          for (const [id, bytes] of s.objects) await worker.putSpec(bytes, undefined, s.generations[id]);
          const jobId = await worker.enqueue(initial.input),
            report = await worker.drain(),
            job = await worker.job(jobId);
          assert.equal(job.status, 'completed');
          assert.deepEqual(await worker.bytes(job.output), oracle.output);
          if (JSON.parse(oracle.output).result.status === 'clean')
            assert.deepEqual(await worker.bytes(JSON.parse(oracle.output).result.state), oracle.headBytes);
          for (const id of historical)
            assert.equal(worker.readCounts.get(id) ?? 0, 0, 'irrelevant State bytes are never read');
          if (!conflict) {
            const head = JSON.parse(oracle.output).result.state.sha256;
            assert.equal(
              [...worker.tables.projectObjects.values()].find(row => row.digest === head).stateGeneration,
              1 + Math.max(s.generations[left], s.generations[right]),
            );
          }
          const budget = { readObjects: report.readObjects };
          baseline ??= {};
          baseline[Number(conflict)] ??= budget;
          assert.deepEqual(budget, baseline[Number(conflict)]);
          assert(report.functionCalls <= 24);
          assert(report.documentsRead <= 236);
          assert(report.documentsWritten <= 65);
          assert(report.readBytes < 32768, `bounded near graph and cursor bytes ${report.readBytes}`);
          assert.equal(report.storageCalls, 0);
          t.diagnostic(JSON.stringify({ kind, count, conflict, ...report }));
        } finally {
          worker.restore();
        }
      }
  });

test('generation-enabled healthy nearby merges keep the original call/read/write ceilings at 4.99/9.98 MB', async t => {
  const { asymmetricHistory } = await import('./source-asymmetric-scale-fixture.mjs');
  for (const count of [29000, 58000]) {
    const s = await scaleFixture();
    try {
      const h = await asymmetricHistory(s, count, 10, false, 1, true),
        id = await s.enqueue(h.input),
        report = await s.drain(),
        job = await s.job(id);
      assert.equal(job.status, 'completed');
      assert(report.functionCalls <= 24);
      assert(report.documentsRead <= 245);
      assert(report.documentsWritten <= 66);
      assert.equal([...s.readCounts].filter(([id]) => h.historical.has(id)).length, 0);
      assert(report.maxRssBytes < 400 * 1024 * 1024);
      assert.equal(report.storageCalls, 0);
      const result = JSON.parse(await s.bytes(job.output)),
        state = [...s.tables.projectObjects.values()].find(row => row.digest === result.result.state.sha256);
      assert.equal(state.stateGeneration, Math.max(...h.generations.values()) + 1);
      const idle = s.calls.length;
      await s.drain();
      assert.equal(s.calls.length, idle);
      t.diagnostic(JSON.stringify({ count, generationEnabled: true, ...report }));
    } finally {
      s.restore();
    }
  }
});
