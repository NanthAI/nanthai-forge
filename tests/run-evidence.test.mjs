// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveResultSchema } from '../dist/hosted-save.js';
import { checkEvidence, outsideSummary, proofFollowupId } from '../dist/run-evidence.js';
import { exactHostedCheckEvidence, hostedVerdictKey } from '../dist/hosted-check-evidence.js';
import { saveFixture } from './hosted-saves-fixture.mjs';

for (const lines of [undefined, [], ['Windows paths were not run']]) {
  test(`an exact save retains ${lines === undefined ? 'not reported' : lines.length ? 'unverified lines' : 'an explicit empty claim'} across retry`, async () => {
    const s = await saveFixture();
    const x = await s.prepare([], lines === undefined ? {} : { notVerified: lines });
    const reply = await s.submit(x);
    assert.equal(Object.hasOwn(reply.outcome.result, 'notVerified'), lines !== undefined);
    assert.deepEqual(reply.outcome.result.notVerified, lines);
    assert.deepEqual(saveResultSchema.parse(reply.outcome.result), reply.outcome.result);
    assert.deepEqual(await s.submit(x), reply);
    const record = [...s.tables.projectHostedRecords.values()].find(row => row.kind === 'save');
    const saved = JSON.parse(record.inline ?? s.tables.projectHostedRecordBodies.get(record.bodyId).value);
    assert.deepEqual(saved.notVerified, lines);
    assert.equal(saved.head, reply.outcome.result.head);
    assert.equal(saved.actor, 'owner');
  });
}

test('outside claims strip credential-shaped values, signed links, private paths and device hostnames', () => {
  // forge-path-fixture: synthetic
  const syntheticPath = '/Users/synthetic/project';
  const clean = outsideSummary(
    `Deploy https://example.test/run?token=private ${syntheticPath} workstation.local password=private`,
  );
  for (const secret of ['token=private', syntheticPath, 'workstation.local', 'password=private'])
    assert(!clean.includes(secret));
  assert(clean.includes('[external link]'));
});

test('no check, no test report and a reported run remain different facts', () => {
  assert.equal(checkEvidence(null), null);
  const base = {
    id: 'run',
    request: { expectedHead: 'a'.repeat(64) },
    check: { name: 'verify' },
    counts: { completed: 1, passed: 1, failed: 0 },
    status: 'passed',
    cost: { status: 'unknown' },
    at: '2026-11-01T00:00:00.000Z',
    endedAt: null,
  };
  assert.equal(checkEvidence(base).files, null);
  assert.equal(checkEvidence({ ...base, endedAt: '2026-10-31T00:00:00.000Z' }).wallSeconds, null);
  assert.equal(checkEvidence({ ...base, endedAt: 'invalid' }).wallSeconds, null);
  assert.equal(checkEvidence({ ...base, endedAt: base.at }).wallSeconds, 0);
  assert.equal(
    checkEvidence({ ...base, testFiles: { counts: { total: 0, failed: 0, flaky: 0 } } }).files,
    null,
  );
  const reported = checkEvidence({
    ...base,
    contractReports: { 'a.test': { failed: false, durationMs: 123 } },
  });
  assert.equal(reported.files.total, 1);
  assert.match(reported.sources.tests, /Self-reported/);
  assert.equal(reported.ciMinutes, null);
});

test('self-reported coverage and timing cannot grant a pass or change the reuse key', () => {
  const base = {
    id: 'run',
    projectId: 'project',
    actor: 'actor',
    status: 'failed',
    request: {
      candidateId: 'candidate',
      expectedHead: 'a'.repeat(64),
      checkId: 'check',
      expectedDefinition: 'b'.repeat(64),
      expectedConfiguration: 'c'.repeat(64),
      expectedEnvironment: 'd'.repeat(64),
      authorityEpoch: 1,
    },
    configuration: { runtime: 'e'.repeat(64) },
    counts: { completed: 0, passed: 0, failed: 0 },
    exitCode: 1,
  };
  const forged = {
    ...base,
    contractReports: { test: { failed: false, durationMs: 0 } },
    testFiles: { counts: { total: 999999, failed: 0, flaky: 0 } },
  };
  assert.equal(hostedVerdictKey(base), hostedVerdictKey(forged));
  const pins = {
    candidateId: 'candidate',
    head: 'a'.repeat(64),
    checkId: 'check',
    definition: 'b'.repeat(64),
    configuration: 'c'.repeat(64),
    environment: 'd'.repeat(64),
    authorityEpoch: 1,
  };
  assert.throws(() => exactHostedCheckEvidence(forged, pins), { code: 'EVIDENCE_CHANGED' });
});

test('single and batch follow-ups share stable identities for the exact save and line', () => {
  const id = proofFollowupId('saved-source', 7);
  assert.match(id, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(id, proofFollowupId('saved-source', 7));
  assert.notEqual(id, proofFollowupId('another-save', 7));
  assert.notEqual(id, proofFollowupId('saved-source', 8));
});

test('verification metadata at current and doubled scale adds bytes, no document operations or calls', async t => {
  const samples = [];
  for (const count of [0, 100, 200]) {
    const s = await saveFixture();
    const before = performance.now();
    const x = await s.prepare(
      [],
      count
        ? { notVerified: Array.from({ length: count }, (_, i) => `Not verified: synthetic platform ${i}`) }
        : {},
    );
    const result = await s.submit(x);
    const io = s.counts.reduce(
      (a, row) => ({
        reads: a.reads + row.documents,
        writes: a.writes + row.writes,
        writeBytes: a.writeBytes + row.writeBytes,
      }),
      { reads: 0, writes: 0, writeBytes: 0 },
    );
    samples.push({
      lines: count,
      calls: s.counts.length,
      ...io,
      replyBytes: Buffer.byteLength(JSON.stringify(result)),
      wallMs: performance.now() - before,
      sampledRss: process.memoryUsage().rss,
    });
  }
  assert.deepEqual(
    samples.map(s => s.calls),
    [samples[0].calls, samples[0].calls, samples[0].calls],
  );
  assert.deepEqual(
    samples.map(s => s.reads),
    [samples[0].reads, samples[0].reads, samples[0].reads],
  );
  assert.deepEqual(
    samples.map(s => s.writes),
    [samples[0].writes, samples[0].writes, samples[0].writes],
  );
  t.diagnostic(JSON.stringify({ kind: 'synthetic declaration metadata', samples }));
});
