// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hostedSelfMetricsReader } from '../dist/self-metrics-hosted.js';
import { readSelfMetrics } from '../dist/self-metrics.js';
import { readSelfMetricReceipts, withLifecycleMetric } from '../dist/self-metrics-journal.js';
import { saveBytes } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
const period = { from: '2026-10-14T00:00:00.000Z', to: '2026-10-25T03:30:00.000Z' };
const at = time => `2026-10-23T${time}:00.000Z`;
const h = 'a'.repeat(64),
  def = 'd'.repeat(64);
test('hosted reader hydrates table bodies and immutable input pages, counts failed attempts and main acceptance', async () => {
  const laneId = randomUUID(),
    intentId = randomUUID(),
    candidateId = randomUUID(),
    submissionId = randomUUID(),
    attemptId = randomUUID(),
    runId = randomUUID();
  const { pages } = buildComposePages([
    {
      laneId,
      head: h,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: h, size: 1 }, recipe: null },
    },
  ]);
  const page = pages[0],
    blobs = new Map(pages.map(p => [p.pin.sha256, Buffer.from(saveBytes(p.value))]));
  const table = {
    projectHostedRecords: [{ bodyId: 'body' }],
    projectHostedRecordBodies: [
      {
        _id: 'body',
        value: JSON.stringify({ kind: 'lane', id: laneId, intentId, head: h, version: 0, at: at('09:00') }),
      },
    ],
    projectHostedLandingRequests: [
      {
        value: JSON.stringify({
          id: submissionId,
          attemptId,
          at: at('10:00'),
          phase: 'landed',
          request: { candidateId },
        }),
      },
    ],
    projectHostedLandingAttempts: [
      {
        value: JSON.stringify({
          id: attemptId,
          submissionId,
          at: at('10:00'),
          candidate: { inputs: page.pin },
          check: { runId },
        }),
      },
    ],
    projectHostedAcceptances: [
      {
        value: JSON.stringify({
          id: randomUUID(),
          channel: 'main',
          at: at('11:00'),
          candidate: { head: h, inputs: page.pin },
        }),
      },
    ],
    projectHostedCheckRuns: [
      {
        value: JSON.stringify({
          id: runId,
          at: at('10:01'),
          endedAt: at('10:03'),
          status: 'passed',
          request: { expectedHead: h },
          candidate: { inputs: page.pin },
          check: { definition: def },
          plan: { lockfile: h },
          cost: { status: 'observed', seconds: 240 },
        }),
      },
    ],
  };
  const source = { records: async name => table[name] ?? [], object: async pin => blobs.get(pin.sha256) };
  const m = await readSelfMetrics(hostedSelfMetricsReader(source), period);
  assert.equal(m.landings, 1);
  assert.equal(m.metric1.days.find(d => d.day === '2026-10-23').firstTry, 1);
  assert.equal(m.metric3.dropped, null);
  assert.equal(m.metric6.runnerMinutes, 4);
  assert.equal(m.metric6.wallMinutes, 2);
  assert.equal(m.metric6.reuseRate, null);
  assert.equal(m.metric6.partial, true);
  const laneBody = JSON.parse(table.projectHostedRecordBodies[0].value);
  laneBody.revert = { receiptId: randomUUID(), previous: h, accepted: h };
  table.projectHostedRecordBodies[0].value = JSON.stringify(laneBody);
  const compensating = await readSelfMetrics(hostedSelfMetricsReader(source), period);
  assert.equal(compensating.landings, 0);
  assert.equal(compensating.metric1.compensating, 1);
  const bad = hostedSelfMetricsReader({ ...source, object: async () => Buffer.from('changed') });
  await assert.rejects(
    () => bad.read(),
    e => e.code === 'EVIDENCE_CHANGED',
  );
});

test('Oct 21 concurrency replay records seven caller-visible WORK_STALE errors and hides successful internal retries', async () => {
  const { withLifecycleMetric } = await import('../dist/self-metrics-journal.js');
  const { ForgeError } = await import('../dist/errors.js');
  const { calculateSelfMetrics } = await import('../dist/self-metrics.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-m1-eight-'));
  try {
    await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        withLifecycleMetric(
          directory,
          { action: 'finish', operationId: `incident-${i}`, actor: `builder-${i}` },
          async () => {
            if (i) throw new ForgeError('WORK_STALE', 'Concurrent compose revision changed.');
            // The request boundary records only the final outcome.
            try {
              throw new ForgeError('WORK_BUSY', 'internal retry');
            } catch {
              /* retry succeeded */
            }
            return { result: { status: 'accepted' } };
          },
        ),
      ),
    );
    const receipts = readSelfMetricReceipts(directory);
    const result = calculateSelfMetrics(
      {
        moves: [],
        submissions: [],
        runs: [],
        receipts,
        gaps: [],
        coverage: { lifecycle: '2000-01-01T00:00:00.000Z' },
      },
      { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
    );
    assert.equal(result.metric2.finishes, 8);
    assert.equal(result.metric2.errors, 7);
    assert.deepEqual(result.metric2.byCode, [
      { code: 'WORK_STALE', count: 7, per100Finishes: 87.5, noOwner: null },
    ]);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a delivered superseded presentation retains its actual terminal outcome for metric 3', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-q2-delivery-'));
  try {
    const operationId = randomUUID();
    await withLifecycleMetric(root, { action: 'land', operationId }, async () => ({
      result: {
        submissions: [
          { entryOperationId: 'failed', state: 'superseded', outcome: 'terminal-failed' },
          { entryOperationId: 'landed', state: 'superseded', outcome: 'landed' },
          { entryOperationId: 'pending', state: 'superseded', outcome: 'pending' },
        ],
      },
    }));
    const receipts = readSelfMetricReceipts(root);
    assert.deepEqual(receipts.at(-1).deliveries, [
      { entryId: 'failed', state: 'terminal-failed' },
      { entryId: 'landed', state: 'landed' },
    ]);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  }
});
