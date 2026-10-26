// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildExchangeRoot, readByteTree } from '../dist/native-exchange-tree.js';
import { batchedRecordReader } from '../dist/native-exchange-stream.js';
import { hashWorkRecords } from '../dist/work-exchange-records.js';
import { workSchema } from '../dist/work-types.js';

function fixture() {
  const data = workSchema.parse({
    schema: 15,
    revision: 0,
    nativeHead: 'a'.repeat(64),
    intents: [],
    lanes: [],
    views: [],
  });
  for (let i = 0; i < 2048; i++)
    data.intents.push({
      id: randomUUID(),
      base: data.nativeHead,
      outcome: 'Synthetic retained record',
      constraints: '',
      status: 'completed',
      notes: [{ kind: 'comment', text: 'x'.repeat(2048), at: 'now' }],
      createdAt: 'now',
    });
  const tree = buildExchangeRoot(Buffer.from('{}'), Buffer.from(JSON.stringify(data, null, 2)), {
    records: true,
  });
  return { data, tree };
}

test('packed record reads preserve the exact digest with fewer object reads and bounded new upload bytes', async () => {
  const { data, tree } = fixture();
  const read = async pins => pins.map(pin => tree.objects.get(pin.sha256));
  const records = JSON.parse((await readByteTree(tree.root.records, read)).toString());
  const counts = [];
  for (const packs of [undefined, tree.root.recordPacks]) {
    let objects = 0,
      bytes = 0;
    const reader = batchedRecordReader(
      records,
      async pins => {
        objects += pins.length;
        bytes += pins.reduce((sum, pin) => sum + pin.size, 0);
        return read(pins);
      },
      packs,
    );
    assert.deepEqual(await hashWorkRecords(records, reader.read), tree.root.work);
    await reader.drain();
    counts.push({ objects, bytes });
  }
  assert.ok(counts[1].objects < counts[0].objects / 16, JSON.stringify(counts));
  assert.ok(
    counts[1].bytes < counts[0].bytes * 1.01,
    'packing reduces requests, not logical validation bytes',
  );
  data.revision++;
  data.intents[100].notes.push({ kind: 'comment', text: 'A routine edit', at: 'later' });
  const next = buildExchangeRoot(Buffer.from('{}'), Buffer.from(JSON.stringify(data, null, 2)), {
    records: true,
  });
  const newBytes = [...next.objects]
    .filter(([hash]) => !tree.objects.has(hash))
    .reduce((sum, [, bytes]) => sum + bytes.length, 0);
  assert.ok(newBytes < 512 * 1024, `routine metadata upload: ${newBytes}`);
});

for (const damage of ['coverage', 'size', 'bytes', 'body'])
  test(`packed records reject corrupt ${damage}`, async () => {
    const { tree } = fixture(),
      read = async pins => pins.map(pin => tree.objects.get(pin.sha256));
    const records = JSON.parse((await readByteTree(tree.root.records, read)).toString());
    const packs = structuredClone(tree.root.recordPacks);
    if (damage === 'coverage') packs[0].first++;
    if (damage === 'size') packs[0].size++;
    if (damage === 'coverage' || damage === 'size') {
      assert.throws(
        () => batchedRecordReader(records, read, packs),
        e => e.code === 'INVALID_WORK_BACKUP',
      );
      return;
    }
    const bytes = Buffer.from(tree.objects.get(packs[0].sha256));
    bytes[0] ^= 1;
    if (damage === 'body') {
      const { digest } = await import('../dist/hash.js');
      packs[0].sha256 = digest(bytes);
      tree.objects.set(packs[0].sha256, bytes);
    } else tree.objects.set(packs[0].sha256, bytes);
    const reader = batchedRecordReader(records, read, packs);
    await assert.rejects(hashWorkRecords(records, reader.read), e => e.code === 'INVALID_WORK_BACKUP');
    await reader.drain();
  });
