// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 411727ba: projectSelfMetrics:page was the top recurring dev reader (7 GB in 14 days) with no
// split by stream or read shape. Each call now prints one attribution line the spend ledger keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { fixture, period, at } from './self-metrics-hosted-fixture.mjs';

const { spendEvent, daySummary } = await import('../scripts/convex-spend-model.mjs');
const completion = JSON.parse(
  readFileSync(new URL('./fixtures/benchmark/completions.json', import.meta.url)),
).action;

function captured(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  return lines;
}
const attribution = line => JSON.parse(line.slice('FORGE_IO_ATTRIBUTION '.length));

test('every metrics page call prints one attribution line with its stream, read shape and own bytes read', async t => {
  const f = fixture();
  for (let i = 0; i < 3; i++) f.landing(`landing-${i}`, at(i * 10), at(i * 10 + 2));
  f.run('run', at(1), at(3));
  const lines = captured(t);
  let pages = 0;
  const query = async (name, args) => {
    if (name === 'projectSelfMetrics:page') pages++;
    return f.query(name, args);
  };
  await readHostedMetricPages(query, period);
  const logged = lines.filter(line => line.startsWith('FORGE_IO_ATTRIBUTION ')).map(attribution);
  assert.equal(logged.length, pages, 'one line per page call');
  assert.ok(logged.some(row => row.label === 'metrics-acceptances/window'));
  assert.ok(
    logged.every(row => /^metrics-[a-z]+\/(window|compact|context|inputs|save-heads)$/.test(row.label)),
  );
  // One call alone: its line carries that call's own meter, not the deployment's.
  lines.length = 0;
  const bytes = f.meter.bytes;
  await f.query('projectSelfMetrics:page', { stream: 'acceptances', ...period, cursor: null });
  const [one] = lines.filter(line => line.startsWith('FORGE_IO_ATTRIBUTION ')).map(attribution);
  assert.equal(one.label, 'metrics-acceptances/window');
  assert.equal(one.bytesRead, f.meter.bytes - bytes);
  assert.ok(one.documentsRead >= 3);
});

test('a refused metrics read still attributes the call and keeps its refusal', async t => {
  const f = fixture();
  f.actor('stranger');
  const lines = captured(t);
  await assert.rejects(f.query('projectSelfMetrics:page', { stream: 'requests', ...period, cursor: null }), {
    data: { code: 'PROJECT_UNAVAILABLE', message: 'Project metrics require owner or maintainer access.' },
  });
  assert.deepEqual(
    lines.filter(line => line.startsWith('FORGE_IO_ATTRIBUTION ')).map(line => attribution(line).label),
    ['metrics-requests/window'],
  );
});

test('the spend ledger keeps only one code-shaped label per call and splits the function by it', () => {
  const log = (id, messages, io) => ({
    ...structuredClone(completion),
    udfType: 'Query',
    identifier: 'projectSelfMetrics.js:page',
    requestId: id,
    executionId: id,
    logLines: messages.map(message => ({ messages: [message] })),
    usageStats: { ...completion.usageStats, databaseIoReadBytes: io, databaseIoWriteBytes: 0 },
  });
  const line = label => `FORGE_IO_ATTRIBUTION ${JSON.stringify({ label, documentsRead: 4, bytesRead: 9 })}`;
  const events = [
    spendEvent(log('a', [line('metrics-acceptances/window')], 300), 'dev'),
    spendEvent(log('b', [line('metrics-acceptances/window')], 200), 'dev'),
    spendEvent(log('c', [line('metrics-runs/compact')], 50), 'dev'),
    // Not a code label (an id, user text, two lines): the call stays unattributed.
    spendEvent(log('d', [line('metrics-Lane j57abc')], 7), 'dev'),
    spendEvent(log('e', [line('metrics-runs/compact'), line('metrics-runs/window')], 7), 'dev'),
    spendEvent(log('f', ['FORGE_IO_ATTRIBUTION {not json'], 7), 'dev'),
  ];
  assert.deepEqual(
    events.map(event => event.attribution ?? null),
    ['metrics-acceptances/window', 'metrics-acceptances/window', 'metrics-runs/compact', null, null, null],
  );
  assert.ok(
    events.every(event => !JSON.stringify(event).includes('bytesRead')),
    'numbers stay in the log',
  );
  const report = daySummary(events[0].day, events);
  assert.equal(report.perFunction[0].usage.io, 571);
  assert.deepEqual(
    report.perAttribution.map(({ identifier, attribution, usage }) => [identifier, attribution, usage.io]),
    [
      ['projectSelfMetrics.js:page', 'metrics-acceptances/window', 500],
      ['projectSelfMetrics.js:page', 'metrics-runs/compact', 50],
    ],
  );
});
