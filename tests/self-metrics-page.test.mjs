// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageMetrics, METRICS_PAGE_MAX } from '../dist/self-metrics-page.js';

const period = { from: '2026-11-05T21:00:00.000Z', to: '2026-11-05T23:20:00.000Z' };
const rows = n => Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, pad: 'x'.repeat(200) }));
const surface = () => ({
  schema: 1,
  period,
  totals: {
    waste: { byCause: [], rows: rows(25) },
    5.1: { landings: 30, rows: rows(30) },
    5.7: { modes: [{ mode: 'a', rows: rows(3) }] },
    flakes: { files: [], filesTotal: 0 },
  },
  days: [{ day: '2026-11-05', metrics: { waste: { rows: rows(25) }, 5.1: { rows: rows(30) } } }],
});

test('metrics paging: no limit or cursor returns the report unchanged', () => {
  const whole = surface();
  assert.equal(pageMetrics(whole, period, {}), whole);
  assert.equal(pageMetrics(whole, period, { limit: undefined, cursor: undefined }), whole);
});

test('metrics paging: one shared offset walks every row list; totals stay whole; days drop rows', () => {
  const seen = { waste: [], landings: [] };
  let cursor,
    pages = 0,
    first;
  do {
    const page = pageMetrics(surface(), period, { limit: 12, ...(cursor ? { cursor } : {}) });
    first ??= page;
    pages++;
    assert(page.totals.waste.rows.length <= 12 && page.totals['5.1'].rows.length <= 12);
    assert.equal(page.totals['5.1'].landings, 30, 'counts are the whole window on every page');
    assert.equal(page.totals.waste.rowsTotal, 25);
    seen.waste.push(...page.totals.waste.rows.map(r => r.id));
    seen.landings.push(...page.totals['5.1'].rows.map(r => r.id));
    assert.deepEqual(page.days[0].metrics.waste.rows, []);
    assert.equal(page.days[0].metrics.waste.rowsOmitted, 25);
    assert(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(
    seen.waste,
    rows(25).map(r => r.id),
  );
  assert.deepEqual(
    seen.landings,
    rows(30).map(r => r.id),
  );
  assert.equal(first.page.rowsTotal, 30);
  assert.equal(first.totals['5.7'].modes[0].rows.length, 3, 'nested row lists page too');
});

test('metrics paging: a cursor from another window or without a limit is refused', () => {
  const page = pageMetrics(surface(), period, { limit: 5 });
  const other = { ...period, to: '2026-11-06T00:00:00.000Z' };
  assert.throws(
    () => pageMetrics(surface(), other, { limit: 5, cursor: page.page.nextCursor }),
    /does not belong/,
  );
  assert.throws(() => pageMetrics(surface(), period, { cursor: page.page.nextCursor }), /first page/);
  assert.throws(() => pageMetrics(surface(), period, { limit: 5, cursor: 'garbage' }), /does not belong/);
  assert(METRICS_PAGE_MAX >= 100);
});
