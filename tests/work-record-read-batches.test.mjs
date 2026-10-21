// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildExchangeRoot, resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { workSchema } from '../dist/work-types.js';
import { recordBytes } from '../dist/work-exchange-records.js';
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
  t.diagnostic(JSON.stringify({ records: 12000, workBytes: work.length, calls, recordBatches, largest }));
});
