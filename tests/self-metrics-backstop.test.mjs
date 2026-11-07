// SPDX-License-Identifier: Apache-2.0
// Issue 71767c9b line 5: every proved-reuse acceptance and every later failed
// full main audit is counted, so a broken proof shows up in self-metrics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { formatMetrics } from '../dist/self-metrics-format.js';
import { calculateBackstopMetrics } from '../dist/self-metrics-backstop.js';
import { fixture, period, at, empty } from './self-metrics-hosted-fixture.mjs';

function accept(f, id, minutes, revision, reused = false) {
  f.landing(id, at(minutes), at(minutes));
  const row = f.tables.projectHostedAcceptances.at(-1);
  row.value = JSON.stringify({
    ...JSON.parse(row.value),
    snapshot: { revision },
    ...(reused ? { crossHeadProof: { algorithm: 'clean-disjoint-v2' } } : {}),
  });
}
const event = (f, kind, minutes, sequence, culprit) =>
  f.put(
    'projectHostedMainAuditEvents',
    {
      projectId: 'project',
      kind,
      at: at(minutes),
      head: `head-${sequence}`,
      runId: `audit-${sequence}`,
      sequence,
      ...(culprit ? { culprit } : {}),
    },
    at(minutes),
  );

test('reuse acceptances and later main-audit failures are counted with no extra call or write', async () => {
  const f = fixture();
  event(f, 'green', -60, 1); // bounds the first in-window failure's audited range
  accept(f, 'exact', 10, 2);
  accept(f, 'reused', 20, 3, true);
  event(f, 'red', 30, 3);
  event(f, 'culprit', 40, 3, 'reused');
  event(f, 'green', 50, 4);
  accept(f, 'later', 60, 5);
  event(f, 'red', 70, 5);
  event(f, 'flake', 80, 5);
  const first = JSON.parse(
    await f.query('projectSelfMetrics:page', { stream: 'acceptances', ...period, cursor: null }),
  );
  assert.deepEqual(
    first.page.map(r => [r.id, r.reused, r.revision]),
    [
      ['later', false, 5],
      ['reused', true, 3],
      ['exact', false, 2],
    ],
  );
  assert.equal(first.audits.complete, true);
  assert.deepEqual(
    first.audits.events.map(e => e.kind),
    ['flake', 'red', 'green', 'culprit', 'red', 'green'],
  );
  const runs = JSON.parse(
    await f.query('projectSelfMetrics:page', { stream: 'runs', ...period, cursor: null }),
  );
  assert.equal(runs.audits, undefined, 'events ride only on the first acceptances page');

  const calls = f.meter.calls;
  const { records } = await readHostedMetricPages(f.query, period);
  const before = fixture();
  await readHostedMetricPages(before.query, period);
  assert.equal(f.meter.calls - calls, before.meter.calls, 'the projection adds no call');
  assert.equal(f.meter.writes, 0);
  const result = metricsSurface(records, period);
  assert.deepEqual(
    { ...result.totals.B, gaps: undefined },
    {
      partial: false,
      gaps: undefined,
      sourceRecords: 6,
      reuseAcceptances: 1,
      mainCheckFailures: 2,
      failuresAfterReuse: 1,
      flakeCleared: 1,
      culprits: 1,
      reuseCulprits: 1,
    },
  );
  assert.match(
    formatMetrics(result),
    /B {3}1 reuse acceptances; 2 main-check failures \(1 after reuse, 1 flake, 1 culprits, 1 on reuse\)/,
  );
});

test('an old server without the projection reports unknown, never zero', async () => {
  const f = fixture();
  f.landing('old', at(10), at(10));
  const { records } = await readHostedMetricPages(async (name, args) => {
    const page = JSON.parse(await f.query(name, args));
    delete page.audits;
    for (const row of page.page) delete row.reused;
    return JSON.stringify(page);
  }, period);
  const metric = metricsSurface(records, period).totals.B;
  assert.equal(metric.partial, true);
  assert.equal(metric.reuseAcceptances, null);
  assert.equal(metric.mainCheckFailures, null);
  assert.equal(metric.reuseCulprits, null);
  assert(metric.gaps.some(gap => gap.includes('reuse projection')));
});

test('a failure with no bounding green in the page is partial; native history is not applicable', () => {
  const records = {
    ...empty(),
    source: { kind: 'hosted' },
    moves: [{ id: 'r', at: at(10), head: 'r', kind: 'landing', inputs: [], reused: true, revision: 7 }],
    mainAudits: { events: [{ kind: 'red', at: at(20), sequence: 9 }], complete: false },
  };
  const hosted = calculateBackstopMetrics(records, period);
  assert.equal(hosted.partial, true);
  assert.equal(hosted.failuresAfterReuse, 1);
  const native = calculateBackstopMetrics({ ...records, source: { kind: 'native' } }, period);
  assert.deepEqual([native.partial, native.reuseAcceptances, native.mainCheckFailures], [false, null, null]);
});
