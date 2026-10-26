// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { recordMetricObservation, githubHostedZeroBill } from '../dist/self-metrics-observations.js';
import { readSelfMetricReceipts } from '../dist/self-metrics-journal.js';
import { recordMetricPublication, recordMetricCache } from '../dist/self-metrics-source-observations.js';
const at = (hhmm, day = '25') => `2026-10-${day}T${hhmm}:00.000Z`;
const period = { from: at('00:00'), to: at('00:00', '26') };
const base = () => ({
  moves: [],
  submissions: [],
  runs: [],
  receipts: [],
  observations: [],
  gaps: [],
  coverage: {
    overlaps: period.from,
    overlapAnswers: period.from,
    authority: period.from,
    surfaces: period.from,
    fullResults: period.from,
    mirrorResults: period.from,
  },
});
const move = (id, head, at, inputs = [], extra = {}) => ({ id, head, at, inputs, kind: 'landing', ...extra });
const save = (id, laneId, head, hhmm, overlaps = []) => ({
  type: 'save',
  id,
  laneId,
  head,
  at: at(hhmm),
  overlaps,
  complete: true,
});
const delivery = (id, laneId, head, hhmm, paths = ['shared.ts']) => ({
  type: 'overlap-delivery',
  id,
  laneId,
  head,
  at: at(hhmm),
  paths,
  noticeIds: [],
  via: 'lifecycle',
});

test('metric 4: overlapping saves, timely delivery, median and acknowledgements use exact saved heads', () => {
  const r = base(),
    peer = [{ laneId: 'A', head: 'a1', paths: ['shared.ts'] }];
  r.observations = [
    save('b1', 'B', 'h1', '10:00', peer),
    save('b2', 'B', 'h2', '10:10', peer),
    save('c1', 'C', 'c1', '10:20', peer),
    save('unrelated', 'D', 'd1', '11:00'),
    delivery('d1', 'B', 'h1', '10:01'),
    delivery('late', 'B', 'h1', '10:11'),
    delivery('wrong-head', 'B', 'other', '10:11'),
    delivery('d2', 'B', 'h2', '10:12'),
    delivery('wrong-file', 'C', 'c1', '10:21', ['elsewhere.ts']),
    { type: 'overlap-answer', id: 'ack', at: at('10:13'), deliveryId: 'd2', disposition: 'routed-around' },
  ];
  r.observations.push(r.observations[0], r.observations[4]);
  const m = calculateSelfMetrics(r, period).metric4;
  assert.equal(m.overlappingSaves, 3);
  assert.equal(m.delivered, 2);
  assert.equal(m.deliveryRate, 2 / 3);
  assert.equal(m.medianDeliverySeconds, 90);
  assert.equal(m.acknowledgementRate, 0.5);
  assert.equal(m.rows[2].deliveryId, null);
  r.observations = [
    save('b1', 'B', 'h1', '10:00', peer),
    save('b2', 'B', 'h2', '10:10'),
    delivery('late', 'B', 'h1', '10:10'),
  ];
  assert.equal(calculateSelfMetrics(r, period).metric4.delivered, 0);
});

test('metric 4: missing or incomplete save coverage is partial, never an established zero', () => {
  const r = base();
  delete r.coverage.overlaps;
  const m = calculateSelfMetrics(r, period).metric4;
  assert.equal(m.overlappingSaves, null);
  assert.equal(m.partial, true);
  r.observations = [{ ...save('s', 'B', 'h', '10:00'), complete: false }];
  assert.equal(calculateSelfMetrics(r, period).metric4.partial, true);
});

test('metric 7: both revision directions retain per-day p50/p95, pending revisions and epoch boundaries', () => {
  const r = base();
  for (const mode of ['owner-hosted', 'hosted-cache']) {
    const rev = (id, side, revision, hhmm, stream = 'epoch-1') => ({
      type: 'revision',
      id: `${mode}:${id}`,
      mode,
      stream,
      side,
      revision,
      at: at(hhmm),
    });
    r.observations.push(
      rev('initial', 'replica', 10, '09:00'),
      rev('11', 'authority', 11, '10:00'),
      rev('12', 'authority', 12, '10:01'),
      rev('caught', 'replica', 12, '10:03'),
      rev('13', 'authority', 13, '11:00'),
      rev('other-epoch', 'replica', 999, '11:01', 'epoch-2'),
    );
  }
  const m = calculateSelfMetrics(r, period).metric7;
  for (const result of m.modes) {
    assert.deepEqual(result.days, [
      {
        day: '2026-10-25',
        revisions: 3,
        pending: 1,
        revisionLagP50: 1,
        revisionLagP95: 2,
        secondsP50: 120,
        secondsP95: 180,
      },
    ]);
    assert.equal(result.rows[2].seconds, null);
  }
});

test('metric 7: Closed without landing page replay counts contradiction minutes once across surfaces and UTC windows', () => {
  const r = base(),
    surface = (id, hhmm, displayed, extra = {}) => ({
      type: 'surface',
      id,
      at: at(hhmm),
      surface: 'hosted Intent page',
      entity: 'intent-closed-without-landing',
      authority: 'active-unlanded',
      displayed,
      ...extra,
    });
  r.observations = [
    surface('closed', '10:00', 'Closed without landing'),
    surface('also', '10:05', 'completed', { surface: 'MCP' }),
    surface('fixed-page', '10:10', 'active-unlanded'),
    surface('fixed-mcp', '10:15', 'active-unlanded', { surface: 'MCP' }),
  ];
  assert.equal(calculateSelfMetrics(r, period).metric7.contradictionMinutes, 15);
  assert.equal(
    calculateSelfMetrics(r, { from: at('10:07'), to: at('10:12') }).metric7.contradictionMinutes,
    5,
  );
  delete r.coverage.surfaces;
  assert.equal(calculateSelfMetrics(r, period).metric7.partial, true);
  assert.equal(calculateSelfMetrics(r, period).metric7.contradictionMinutes, 15);
});

test('metric 8: monthly invoices join exact landing/run identities, shared overhead, list price and estimator error', () => {
  const r = base(),
    a = { laneId: 'A', head: 'a', intentId: 'I' },
    b = { laneId: 'B', head: 'b', intentId: 'J' };
  r.moves = [
    move('a', 'main-a', at('10:00'), [a]),
    move('b', 'main-b', at('11:00'), [b]),
    move('comp', 'undo', at('12:00'), [], { kind: 'compensating' }),
  ];
  r.runs = [{ id: 'run-a', at: at('09:00'), status: 'passed', inputs: [a] }];
  const bill = (id, provider, billedUsd, listUsd, estimateUsd, extra = {}) => ({
    type: 'bill',
    id,
    provider,
    at: at('13:00'),
    month: '2026-10',
    billedUsd,
    listUsd,
    estimateUsd,
    basis: 'Entered fixture bill',
    ...extra,
  });
  r.observations = [
    bill('runner', 'modal', 6, 10, 9, { runIds: ['run-a'] }),
    bill('hosting', 'convex', 4, 8, 6),
    bill('unused', 'blacksmith', 0, 0, 0),
    bill('netlify', 'netlify', 0, 0, 0),
    bill('storage', 'r2', 0, 0, 0),
    githubHostedZeroBill({
      id: 'gh-zero',
      at: at('13:00'),
      month: '2026-10',
      listUsd: 2,
      estimateUsd: 0,
      runIds: [],
    }),
  ];
  r.observations.push(r.observations[0]);
  const m = calculateSelfMetrics(r, period).metric8.months[0];
  assert.equal(m.billedUsd, 10);
  assert.equal(m.listUsd, 20);
  assert.equal(m.billedUsdPerLanding, 5);
  assert.equal(m.estimatorError, 0.5);
  assert.equal(m.rows[0].billedUsd, 8);
  assert.equal(m.rows[1].billedUsd, 2);
  assert.equal(m.partial, false);
  assert.match(m.bills.find(b => b.id === 'gh-zero').basis, /\$0/);
  r.observations = [r.observations[5]];
  const zero = calculateSelfMetrics(r, period).metric8.months[0];
  assert.equal(zero.billedUsd, 0);
  assert.equal(zero.estimatorError, null);
  assert.match(zero.estimatorErrorBasis, /zero/);
});

test('metric 8: no invoices stay unknown; explicit unlanded charges are retained as unallocated', () => {
  const r = base();
  r.moves = [move('a', 'h', at('10:00'))];
  assert.equal(calculateSelfMetrics(r, period).metric8.months[0].billedUsd, null);
  r.observations = [
    {
      type: 'bill',
      id: 'b',
      at: at('13:00'),
      month: '2026-10',
      provider: 'r2',
      billedUsd: 3,
      listUsd: null,
      estimateUsd: null,
      basis: 'fixture',
      landingIds: ['outside'],
    },
  ];
  const m = calculateSelfMetrics(r, period).metric8.months[0];
  assert.equal(m.unallocatedUsd, 3);
  assert.equal(m.rows[0].billedUsd, null);
  assert.equal(m.partial, true);
});

test('red main: exact full failure lasts through later heads until a passing current head, split by UTC day', () => {
  const r = base();
  r.moves = [
    move('m1', 'h1', at('23:30')),
    move('m2', 'h2', at('23:50')),
    move('m3', 'h3', at('00:10', '26')),
  ];
  r.runs = [
    {
      id: 'failed',
      head: 'h1',
      at: at('23:31'),
      endedAt: at('23:40'),
      status: 'failed',
      inputs: [],
      fullSuite: true,
    },
    {
      id: 'old-pass',
      head: 'h1',
      at: at('23:51'),
      endedAt: at('23:55'),
      status: 'passed',
      inputs: [],
      fullSuite: true,
    },
    {
      id: 'scoped-pass',
      head: 'h2',
      at: at('23:56'),
      endedAt: at('23:58'),
      status: 'passed',
      inputs: [],
      fullSuite: false,
    },
    {
      id: 'cached',
      head: 'h2',
      at: at('23:58'),
      endedAt: at('23:59'),
      status: 'passed',
      inputs: [],
      fullSuite: true,
      reusedFrom: 'old-full-result',
    },
    {
      id: 'pass',
      head: 'h3',
      at: at('00:11', '26'),
      endedAt: at('00:20', '26'),
      status: 'passed',
      inputs: [],
      fullSuite: true,
    },
  ];
  const m = calculateSelfMetrics(r, { from: at('23:00'), to: at('01:00', '26') }).redMain.sources[0];
  assert.equal(m.minutes, 40);
  assert.deepEqual(m.days, [
    { day: '2026-10-25', minutes: 20 },
    { day: '2026-10-26', minutes: 20 },
  ]);
  assert.equal(m.open, false);
  assert.equal(
    calculateSelfMetrics(r, { from: at('23:00'), to: at('00:15', '26') }).redMain.sources[0].open,
    true,
  );
});

test('red main: culprit records include accepted descendants, mirror Verify remains a separate source', () => {
  const r = base();
  r.moves = [
    move('culprit', 'h1', at('09:00')),
    move('descendant', 'h2', at('09:30'), [], { ancestorHeads: ['h1'] }),
    move('later', 'h3', at('12:00'), [], { ancestorHeads: ['h1'] }),
  ];
  r.observations = [
    { type: 'culprit', id: 'named', at: at('10:00'), landingId: 'culprit' },
    {
      type: 'full-result',
      id: 'verify-failed',
      at: at('09:20'),
      source: 'github-verify',
      head: 'h1',
      status: 'failed',
    },
    {
      type: 'full-result',
      id: 'verify-pass',
      at: at('10:00'),
      source: 'github-verify',
      head: 'h2',
      status: 'passed',
    },
    { type: 'full-result', id: 'full-pass', at: at('11:00'), source: 'forge', head: 'h2', status: 'passed' },
  ];
  const m = calculateSelfMetrics(r, period).redMain;
  assert.equal(m.sources[0].minutes, 120);
  assert.equal(m.sources[1].minutes, 40);
});

test('observation records validate, replay idempotently in reports and retain explicit zero bill basis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-m2-records-'));
  try {
    const bill = githubHostedZeroBill({
      id: 'zero',
      at: at('13:00'),
      month: '2026-10',
      listUsd: 1,
      estimateUsd: 0,
      runIds: [],
    });
    recordMetricObservation(dir, bill);
    recordMetricObservation(dir, bill);
    recordMetricPublication(dir, 12, 'publish');
    const main = { schema: 2, projectId: 'p', sourceRevision: 9, authority: { epoch: 2 } };
    recordMetricCache(dir, main, 'authority', 'cache');
    recordMetricCache(dir, main, 'replica', 'cache');
    const receipts = readSelfMetricReceipts(dir);
    assert.equal(receipts.filter(r => r.observation?.type === 'revision').length, 3);
    const r = { ...base(), receipts };
    assert.equal(calculateSelfMetrics(r, period).metric8.months[0].bills.length, 1);
    const before = readFileSync(join(dir, 'self-metrics.jsonl'));
    assert.throws(() => recordMetricObservation(dir, { ...bill, billedUsd: -1 }));
    assert.deepEqual(readFileSync(join(dir, 'self-metrics.jsonl')), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2 revision days and monthly landing denominators use UTC even with offset timestamps', () => {
  const r = base();
  r.observations = [
    {
      type: 'revision',
      id: 'r',
      at: '2026-10-25T01:00:00+02:00',
      mode: 'owner-hosted',
      stream: 'owner',
      side: 'authority',
      revision: 1,
    },
    {
      type: 'bill',
      id: 'b',
      at: at('13:00'),
      provider: 'r2',
      month: '2026-10',
      billedUsd: 2,
      listUsd: 2,
      estimateUsd: 2,
      basis: 'fixture',
    },
  ];
  r.moves = [move('m', 'h', '2026-11-01T00:30:00+02:00')];
  const m = calculateSelfMetrics(r, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
  assert.equal(m.metric7.modes[0].days[0].day, '2026-10-24');
  assert.equal(m.metric8.months[0].landings, 1);
  assert.equal(m.metric8.months[0].billedUsdPerLanding, 2);
});
