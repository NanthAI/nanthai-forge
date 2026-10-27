// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { callsFixture } from './projectWorkIndex-calls-fixture.mjs';

test('dogfood-shaped summaries bound function calls while reusing owner diffstats and provenance', async t => {
  const f = callsFixture(),
    output = {};
  assert.deepEqual(
    [
      f.data.lanes.length,
      f.data.views.length,
      f.data.runs.length,
      f.data.lanes.reduce((n, l) => n + l.checkpoints.length, 0),
    ],
    [555, 2167, 1471, 2789],
  );
  for (let field = 0; field < 3; field++) {
    const name = ['lanes', 'views', 'runs'][field];
    const cursor = { phase: 'summaries', field, record: 0, source: 0 };
    const start = performance.now(),
      prior = structuredClone(f.metrics.calls);
    let summaries = 0;
    while (cursor.phase === 'summaries' && cursor.field === field) {
      const entries = await f.page(cursor);
      for (const entry of entries.filter(e => e.collection === name)) {
        const value = JSON.parse(entry.value);
        if (name === 'views')
          assert.deepEqual(value.changes, {
            files: 40,
            add: 40,
            del: 40,
            exact: true,
            provenance: 'owner-reported',
          });
        summaries++;
      }
      if (name === 'views' && entries.length)
        assert(
          entries.some(e => e.collection === 'viewFiles'),
          'changed-file provenance is retained',
        );
    }
    const calls = Object.fromEntries(
      Object.entries(f.metrics.calls).map(([k, v]) => [k, v - (prior[k] ?? 0)]),
    );
    const totalCalls = Object.values(calls).reduce((n, v) => n + v, 0);
    assert.equal(summaries, f.data[name].length);
    if (name === 'views') assert(totalCalls / summaries <= 2, JSON.stringify(calls));
    assert(totalCalls / summaries <= 10, `${name}: ${totalCalls / summaries} calls/summary`);
    output[name] = {
      records: summaries,
      calls,
      totalCalls,
      callsPerRecord: totalCalls / summaries,
      ms: performance.now() - start,
    };
  }
  assert.equal(f.metrics.calls['projectWorkIndexBuildDiffstats:compare'] ?? 0, 0);
  assert.equal(f.metrics.sourceFileReads, 0);
  assert(f.metrics.maxPins <= 100);
  assert(f.metrics.maxBatchBytes <= 2 * 1024 * 1024);
  // The measured old path used 488,819 function calls for this exact shape.
  assert(Object.values(output).reduce((n, field) => n + field.totalCalls, 0) <= 488819 / 20);
  t.diagnostic(JSON.stringify({ output, metrics: f.metrics }));
});

test('missing owner diffstats never trigger build-time source-file reads', async () => {
  const f = callsFixture(0.01, false);
  const cursor = { phase: 'summaries', field: 1, record: 0, source: 0 };
  let views = 0;
  while (cursor.phase === 'summaries' && cursor.field === 1) {
    for (const entry of await f.page(cursor))
      if (entry.collection === 'views') {
        assert.equal(JSON.parse(entry.value).changes, undefined);
        views++;
      }
  }
  assert.equal(views, f.data.views.length);
  assert.equal(f.metrics.sourceFileReads, 0);
  assert.equal(f.metrics.calls['projectWorkIndexBuildDiffstats:compare'] ?? 0, 0);
});
