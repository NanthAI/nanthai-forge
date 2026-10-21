// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildExchangeRoot, resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { workSchema } from '../dist/work-types.js';
import { recordBytes } from '../dist/work-exchange-records.js';
import { resolveExchangeWork, batchedRecordReader } from '../dist/native-exchange-stream.js';
import { digest } from '../dist/hash.js';

test('12k record checkpoint reconstruction batches reads without changing portable bytes', async t => {
  const head = 'a'.repeat(64),
    data = workSchema.parse({
      schema: 15,
      revision: 12000,
      nativeHead: head,
      lanes: [],
      views: [],
      intents: Array.from({ length: 12000 }, () => ({
        id: randomUUID(),
        base: head,
        outcome: 'Synthetic retained intent',
        constraints: '',
        status: 'completed',
        createdAt: 'now',
        notes: [],
      })),
    });
  const work = Buffer.from(JSON.stringify(data, null, 2));
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: 12000,
      files: [{ path: 'work.json', sha256: digest(work), size: work.length }],
      unavailable: [],
      coverage: 'Synthetic',
    }),
  );
  const encoded = buildExchangeRoot(manifest, work, { records: true });
  let calls = 0,
    largest = 0;
  const recordHashes = new Set(data.intents.map(i => digest(recordBytes(i))));
  let recordBatches = 0;
  const resolved = await resolveExchangeRoot(
    encoded.bytes,
    async pins => {
      calls++;
      largest = Math.max(
        largest,
        pins.reduce((n, p) => n + p.size, 0),
      );
      assert.ok(pins.length <= 100);
      if (pins.some(p => recordHashes.has(p.sha256))) recordBatches++;
      return pins.map(pin => encoded.objects.get(pin.sha256));
    },
    { batchSize: 100 },
  );
  assert.deepEqual(resolved.work, work);
  assert.deepEqual(resolved.manifest, manifest);
  assert.equal(recordBatches, 120);
  assert.ok(calls < data.intents.length, `total read batches ${calls}`);
  assert.ok(largest <= 2 * 1024 * 1024);
  let active = 0,
    peakActive = 0,
    streamedBatches = 0;
  const streamed = await resolveExchangeWork(encoded.bytes, async pins => {
    peakActive = Math.max(peakActive, ++active);
    if (pins.some(p => recordHashes.has(p.sha256))) streamedBatches++;
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return pins.map(p => encoded.objects.get(p.sha256));
  });
  assert.deepEqual(Buffer.from(JSON.stringify(streamed.data, null, 2)), work);
  assert.equal(streamedBatches, 120);
  assert.ok(peakActive > 1 && peakActive <= 4, `independent read concurrency ${peakActive}`);
  await assert.rejects(
    resolveExchangeWork(encoded.bytes, async pins =>
      pins.map(pin => {
        const bytes = encoded.objects.get(pin.sha256);
        return recordHashes.has(pin.sha256) ? Buffer.alloc(bytes.length, 32) : bytes;
      }),
    ),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  t.diagnostic(JSON.stringify({ records: 12000, workBytes: work.length, calls, recordBatches, largest }));
});

test('record prefetch drains rejected and outstanding reads before fallback cleanup', async () => {
  let active = 0;
  const records = {
    fields: [
      { name: 'items', records: Array.from({ length: 500 }, (_, i) => ({ sha256: String(i), size: 1 })) },
    ],
  };
  const reader = batchedRecordReader(records, async pins => {
    active++;
    try {
      await new Promise(resolve => setTimeout(resolve, pins[0].sha256 === '0' ? 1 : 10));
      if (pins[0].sha256 === '0' || pins[0].sha256 === '200') throw new Error('Synthetic read failure');
      return pins.map(() => Buffer.from('x'));
    } finally {
      active--;
    }
  });
  await assert.rejects(reader.read({ sha256: '0', size: 1 }), /Synthetic read failure/);
  await reader.drain();
  assert.equal(active, 0);
});
