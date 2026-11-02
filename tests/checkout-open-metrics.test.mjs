// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCheckoutOpenMetrics } from '../dist/checkout-open-metrics.js';
import { ForgeError } from '../dist/errors.js';

test('one bounded open receipt retains every phase and original operation on success and failure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-open-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'client'),
    request = { operationId: randomUUID(), laneId: randomUUID() };
  const value = await withCheckoutOpenMetrics(root, request, async metrics => {
    metrics.files = 28881;
    await Promise.all([
      metrics.measure('copyHash', async () => Promise.resolve()),
      metrics.measure('durability', async () => Promise.resolve()),
    ]);
    metrics.measureSync('index', () => 42);
    return 'opened';
  });
  assert.equal(value, 'opened');
  const failure = new ForgeError('INVALID_NATIVE_SOURCE', 'synthetic corruption');
  await assert.rejects(
    withCheckoutOpenMetrics(root, request, async metrics => {
      await metrics.measure('cacheVerify', async () => {
        throw failure;
      });
    }),
    e => e === failure,
  );
  const rows = readFileSync(root + '.forge-metrics.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.operationId, request.operationId);
    assert.equal(row.kind, 'checkout');
    assert.deepEqual(Object.keys(row.checkout.phasesMs), [
      'slotWait',
      'cacheVerify',
      'copyHash',
      'durability',
      'index',
      'publish',
    ]);
    for (const ms of Object.values(row.checkout.phasesMs)) assert(ms >= 0 && Number.isFinite(ms));
    assert(row.checkout.totalMs >= 0);
    assert(row.checkout.maxRssKiB > 0);
  }
  assert.equal(rows[0].checkout.files, 28881);
  assert.equal(rows[0].checkout.outcome, 'completed');
  assert.equal(rows[1].checkout.outcome, 'failed');
  assert.equal(rows[1].errorCode, 'INVALID_NATIVE_SOURCE');
  assert(rows[1].checkout.phasesMs.cacheVerify > 0);
});
