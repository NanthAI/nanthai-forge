// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCheckReports } from '../dist/check-report-detail.js';
import { checkFileSummary, checkReportHeader, checkReportPointer } from '../dist/check-file-summary.js';
import { checkPin } from '../dist/hosted-check.js';
import { checksFixture, read, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const detail = await import(moduleUrl('../convex/projectHostedCheckDetail.ts'));
const features = ['check-report-detail'];

test('mass failures keep exact counts and bounded UTF-8 summaries with stable first errors', () => {
  for (const failed of [false, true]) {
    const reports = Object.fromEntries(
      Array.from({ length: 20000 }, (_, i) => [
        `tests/😀-${i}.test.mjs`,
        { failed, durationMs: i, ...(failed ? { firstError: '\\"😀'.repeat(100) } : {}) },
      ]),
    );
    const summary = checkFileSummary(reports);
    assert.deepEqual(summary.counts, { total: 20000, failed: failed ? 20000 : 0, flaky: 0 });
    assert(Buffer.byteLength(JSON.stringify(JSON.stringify(summary))) <= 8192);
    if (failed) {
      assert.equal(summary.failed.length + summary.omitted.failed, 20000);
      assert.equal(summary.failed[0].file, 'tests/😀-0.test.mjs');
      assert(summary.failed[0].report.firstError);
    }
    const run = { contractReports: reports };
    checkReportHeader(run);
    assert.equal(run.reportSummary.slowest.length, 5);
    assert.equal(run.reportSummary.slowest[0].durationMs, 19999);
    assert.equal(checkReportPointer(reports).digest, checkPin(reports));
  }
});

test('detail pages retain all 20,000 exact reports below 256 KiB and bind cursors to bytes and selection', () => {
  const reports = Object.fromEntries(
    Array.from({ length: 20000 }, (_, i) => [
      `tests/${i}.test.mjs`,
      { failed: i % 3 === 0, durationMs: i, ...(i === 2 ? { flaky: true, firstError: 'first try' } : {}) },
    ]),
  );
  let cursor = null,
    restored = {},
    pages = 0;
  do {
    const result = pageCheckReports(reports, {}, cursor);
    assert(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
    Object.assign(restored, result.contractReports);
    cursor = result.nextCursor;
    pages++;
  } while (cursor);
  assert(pages > 1);
  assert.deepEqual(restored, reports);
  const first = pageCheckReports(reports);
  assert.throws(
    () => pageCheckReports(reports, { failed: true }, first.nextCursor),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () => pageCheckReports({ ...reports, other: { failed: false } }, {}, first.nextCursor),
    code('EVIDENCE_CHANGED'),
  );
  assert.deepEqual(pageCheckReports(reports, { files: ['tests/2.test.mjs'] }).contractReports, {
    'tests/2.test.mjs': reports['tests/2.test.mjs'],
  });
  assert.equal(
    Object.keys(pageCheckReports(reports, { failed: true }).contractReports).includes('tests/2.test.mjs'),
    true,
  );
});

test('detail uses status authorization, legacy exact reports, header feature and no storage locator', async () => {
  const s = await checksFixture();
  const run = await s.activate((await s.enqueue(s.selection())).id, 1);
  await s.callback(s.shard(run, 0, 'failed'));
  const reports = { 'tests/a.test.mjs': { failed: true, firstError: 'exact excerpt' } };
  await s.callback(s.complete(run, 'failed', { contractReports: reports }));
  const identity = { projectId: s.projectId, runId: run.id };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: (_ref, input) => s.transaction('detail-retained', detail.retained, input),
  };
  const result = JSON.parse(await detail.reports._handler(ctx, identity));
  assert.deepEqual(result.contractReports, reports);
  assert(!/"(?:url|key|r2Key)":/.test(JSON.stringify(result)));
  const header = JSON.parse(await s.transaction('capable-status', read.status, { ...identity, features }));
  assert.equal(header.contractReports, undefined);
  assert.equal(
    (await s.status(run.id)).contractReports['tests/a.test.mjs'].failed,
    true,
    'legacy run wire shape remains available',
  );
  for (const fn of [read.status, detail.retained])
    await assert.rejects(s.call('denied', fn, identity, 'stranger'), code('PROJECT_UNAVAILABLE'));
});

test('R2 detail verifies digest and size, refuses absent objects and old clients, and returns no URL', async t => {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => {
    process.env[name] = 'synthetic';
  });
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  });
  const s = await checksFixture();
  const run = await s.pass(await s.activate((await s.enqueue(s.selection())).id, 1));
  const reports = { 'tests/retained.test.mjs': { failed: true, firstError: 'original excerpt' } };
  const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  const header = JSON.parse(row.value);
  delete header.contractReports;
  header.reportPointer = checkReportPointer(reports);
  row.value = JSON.stringify(header);
  const identity = { projectId: s.projectId, runId: run.id };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: (_ref, input) => s.transaction('r2-detail-retained', detail.retained, input),
  };
  let gets = 0;
  globalThis.fetch = async url => {
    assert(
      new URL(url).pathname.includes(`/v1/p/${s.projectId}/checks/${run.id}/`),
      'report bytes stay in the project cleanup namespace',
    );
    gets++;
    return new Response(canonicalPayload(reports));
  };
  const result = JSON.parse(await detail.reports._handler(ctx, identity));
  assert.deepEqual(result.contractReports, reports);
  assert.equal(gets, 1);
  assert(!/"(?:url|key|r2Key)":/.test(JSON.stringify(result)));
  await assert.rejects(s.transaction('old-r2-client', read.status, identity), code('CLI_UPGRADE_REQUIRED'));
  const capable = JSON.parse(await s.transaction('new-r2-client', read.status, { ...identity, features }));
  assert.deepEqual(capable.reportPointer, header.reportPointer);
  assert.equal(capable.contractReports, undefined);
  globalThis.fetch = async () => new Response('missing', { status: 404 });
  await assert.rejects(detail.reports._handler(ctx, identity), code('SOURCE_UNAVAILABLE'));
  globalThis.fetch = async () =>
    new Response(
      canonicalPayload({ 'tests/retained.test.mjs': { failed: true, firstError: 'changed! excerpt' } }),
    );
  await assert.rejects(detail.reports._handler(ctx, identity), code('EVIDENCE_CHANGED'));
});
