// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bounded metrics reads (Item 686ecdde, comment on the metrics line): on 2026-11-22 the agent `metrics` action made
// 1,496 `projectSelfMetrics:page` calls and read 624 MB of database in one hour. One builder command with a 2 h window
// read 27 calls and 10.2 MB, because the default horizon was a 7-day window plus 2 days of context, and every
// 100-row acceptances page joins its landing request and attempt. These tests guard the two halves of the fix: a read
// costs the same calls, documents and bytes however much older history the project holds, and the agent surface refuses
// a wide read before it asks the server anything (the lead's wide read is `nforge metrics ROOT`, src/metrics-cli.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_METRICS_CONTEXT_DAYS_DEFAULT,
  AGENT_METRICS_CONTEXT_DAYS_MAX,
  AGENT_METRICS_DEFAULT_WINDOW_MS,
  AGENT_METRICS_WINDOW_MAX_MS,
  agentMetricsRead,
  executeHostedMetrics,
} from '../dist/hosted-agent-metrics.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { fixture, at } from './self-metrics-hosted-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';

const HOUR = 60;
/** A day of synthetic landings, one every ten minutes, each with a request, an attempt and a check run. */
function landingsBetween(f, fromMinute, toMinute, prefix) {
  for (let minute = fromMinute; minute < toMinute; minute += 10) {
    f.landing(`${prefix}-${minute}`, at(minute), at(minute + 2));
    f.run(`${prefix}-run-${minute}`, at(minute - 6), at(minute - 1), 240);
  }
}
const windowStart = 40 * 24 * HOUR;
const period = { from: at(windowStart), to: at(windowStart + 2 * HOUR) };
/** The fixture database has no exact-conflict summary; a server that has one answers it, and the read records it. */
const summarized = f => (name, args) =>
  name === 'projectHostedConflicts:summary' ? { notices: 0, complete: true } : f.query(name, args);
const read = async (f, contextDays) => {
  const before = { ...f.meter };
  const { records } = await readHostedMetricPages(f.query, period, false, false, contextDays);
  return {
    calls: f.meter.calls - before.calls,
    documents: f.meter.documents - before.documents,
    bytes: f.meter.bytes - before.bytes,
    moves: records.moves.length,
  };
};

test('686ecdde: a metrics read costs the same calls, documents and bytes at 100 and at 10,000 older rows', async () => {
  const measure = async older => {
    const f = fixture();
    // History older than the window and its 90-minute context: it must never be read.
    for (let n = 0; n < older; n++) {
      const minute = windowStart - 3 * 24 * HOUR - n * 2;
      f.landing(`old-${n}`, at(minute), at(minute + 1));
    }
    landingsBetween(f, windowStart - 90, windowStart + 2 * HOUR, 'recent');
    return read(f, AGENT_METRICS_CONTEXT_DAYS_DEFAULT);
  };
  const small = await measure(100);
  const large = await measure(10_000);
  assert(small.moves > 0, 'the window and its context hold landings');
  assert.equal(large.calls, small.calls, 'ten thousand older landings add no call');
  assert.equal(large.documents, small.documents, 'and no document read');
  // The fake database's row ids are longer at 10,000 rows (a few hundred bytes); the rows read are the same.
  assert(Math.abs(large.bytes - small.bytes) <= small.bytes * 0.01, JSON.stringify({ small, large }));
});

test('686ecdde: the read grows with the window and context asked for, which is what the agent cap bounds', async () => {
  const f = fixture();
  landingsBetween(f, windowStart - 3 * 24 * HOUR, windowStart + 2 * HOUR, 'day');
  const none = await read(f, 0);
  const narrow = await read(f, AGENT_METRICS_CONTEXT_DAYS_DEFAULT);
  const old = await read(f, 2);
  assert(
    none.documents < narrow.documents && narrow.documents < old.documents,
    JSON.stringify({ none, narrow, old }),
  );
  assert(none.bytes < narrow.bytes && narrow.bytes < old.bytes);
  assert(old.calls > narrow.calls, 'the old 2-day default paged through more streams than the narrow read');
});

test('686ecdde: the agent surface defaults to a narrow read and allows exactly its cap', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  const defaults = agentMetricsRead({ to: new Date(now).toISOString() });
  assert.equal(
    Date.parse(defaults.period.to) - Date.parse(defaults.period.from),
    AGENT_METRICS_DEFAULT_WINDOW_MS,
  );
  assert.equal(defaults.contextDays, AGENT_METRICS_CONTEXT_DAYS_DEFAULT);
  const widest = agentMetricsRead({
    from: new Date(now - AGENT_METRICS_WINDOW_MAX_MS).toISOString(),
    to: new Date(now).toISOString(),
    contextDays: AGENT_METRICS_CONTEXT_DAYS_MAX,
  });
  assert.equal(widest.contextDays, AGENT_METRICS_CONTEXT_DAYS_MAX);
  for (const wide of [
    {
      from: new Date(now - AGENT_METRICS_WINDOW_MAX_MS - 60_000).toISOString(),
      to: new Date(now).toISOString(),
    },
    { from: '2026-11-01', to: '2026-11-22' },
    { from: new Date(now - 3_600_000).toISOString(), to: new Date(now).toISOString(), contextDays: 2 },
    { from: new Date(now - 3_600_000).toISOString(), to: new Date(now).toISOString(), contextDays: 30 },
  ])
    assert.throws(
      () => agentMetricsRead(wide),
      error => error.code === 'BAD_ARGUMENT' && /nforge metrics ROOT/.test(error.message),
      JSON.stringify(wide),
    );
});

test('686ecdde: a refused wide read asks the server nothing; a typical builder read is a handful of calls', async t => {
  const f = fixture();
  landingsBetween(f, windowStart - 3 * 24 * HOUR, windowStart + 2 * HOUR, 'day');
  let asked = 0;
  const query = (name, args) => {
    asked++;
    return summarized(f)(name, args);
  };
  const address = { url: 'https://example.invalid', projectId: 'project' };
  const root = mkdtempSync(join(tmpdir(), 'metrics-bounded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    executeHostedMetrics({ root, address, query }, { from: at(0), to: at(windowStart) }),
    error => error.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(
    executeHostedMetrics(
      { root, address, query },
      { from: at(windowStart), to: at(windowStart + 60), contextDays: 2 },
    ),
    error => error.code === 'BAD_ARGUMENT',
  );
  assert.equal(asked, 0, 'both refusals happened before any server call');
  const typical = await executeHostedMetrics(
    { root, address, query },
    { from: at(windowStart), to: at(windowStart + 2 * HOUR), limit: 5 },
  );
  assert.equal(typical.source.kind, 'hosted');
  assert(asked > 0 && asked <= 20, `a typical 2 h command made ${asked} calls`);
});

test('686ecdde: the pages of one window read the server once; the last page clears the record', async t => {
  const f = fixture();
  landingsBetween(f, windowStart - 90, windowStart + 2 * HOUR, 'page');
  let asked = 0;
  const query = (name, args) => {
    asked++;
    return summarized(f)(name, args);
  };
  const address = { url: 'https://example.invalid', projectId: 'project' };
  const root = mkdtempSync(join(tmpdir(), 'metrics-paged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const window = { from: at(windowStart), to: at(windowStart + 2 * HOUR), limit: 5 };
  let reply = await executeHostedMetrics({ root, address, query }, window);
  const firstRead = asked;
  assert(firstRead > 0 && reply.page.nextCursor, 'the window has more than one page');
  const pages = [reply.page.nextCursor];
  while (reply.page.nextCursor) {
    reply = await executeHostedMetrics(
      { root, address, query },
      { ...window, cursor: reply.page.nextCursor },
    );
    if (reply.page.nextCursor) pages.push(reply.page.nextCursor);
  }
  assert(pages.length >= 2, 'the window has several pages');
  assert.equal(asked, firstRead, 'every later page of the window was answered from the recorded calls');
  assert.equal(reply.resumed.newCalls, 0);
  // The last page cleared the record: the same window asked again is a fresh read.
  await executeHostedMetrics({ root, address, query }, window);
  assert(asked > firstRead, 'a finished paged read starts fresh next time');
});

test('686ecdde: a read without a cursor never serves the kept record of an earlier paged read', async t => {
  const f = fixture();
  landingsBetween(f, windowStart - 90, windowStart + 2 * HOUR, 'stale');
  let asked = 0;
  const query = (name, args) => {
    asked++;
    return summarized(f)(name, args);
  };
  const address = { url: 'https://example.invalid', projectId: 'project' };
  const root = mkdtempSync(join(tmpdir(), 'metrics-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const window = { from: at(windowStart), to: at(windowStart + 2 * HOUR), limit: 5 };
  const first = await executeHostedMetrics({ root, address, query }, window);
  assert(first.page.nextCursor, 'the first page is kept for its next page');
  const afterFirst = asked;
  // Page 1 again (no cursor) is a new read: the window may have changed since the record was made.
  const again = await executeHostedMetrics({ root, address, query }, window);
  assert(asked > afterFirst, 'a read without a cursor asks the server');
  assert.equal(again.resumed, undefined);
  // The cursor of the new read continues from the new record.
  const afterAgain = asked;
  await executeHostedMetrics({ root, address, query }, { ...window, cursor: again.page.nextCursor });
  assert.equal(asked, afterAgain);
});

test('686ecdde: a wide agent metrics read is refused on the real transport before capability discovery', async t => {
  const s = agentFixture(t);
  await assert.rejects(
    s.transport().dispatch('metrics', { from: '2026-11-01', to: '2026-11-22' }),
    error => error.code === 'BAD_ARGUMENT' && /nforge metrics ROOT/.test(error.message),
  );
  assert.equal(s.calls.length, 0, 'no server call, not even capabilities');
});
