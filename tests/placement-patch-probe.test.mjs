// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const probe = await import(moduleUrl('../convex/placementPatchProbe.ts'));
function fixture(t) {
  const previous = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = 'https://benevolent-wildebeest-974.convex.cloud';
  t.after(() => {
    if (previous === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = previous;
  });
  const rows = new Map();
  let serial = 0;
  const db = {
    normalizeId: () => null,
    query: table => ({
      withIndex(_index, filter) {
        let key;
        filter({ eq: (_field, value) => (key = value) });
        return {
          unique: async () => [...rows.values()].find(r => r.table === table && r.key === key) ?? null,
        };
      },
    }),
    insert: async (table, row) => {
      const id = String(++serial);
      rows.set(id, { ...row, table, _id: id });
      return id;
    },
    patch: async (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    delete: async id => rows.delete(id),
  };
  return { rows, ctx: { db } };
}
test('synthetic patch cells preserve payload size, reconcile retries and clean only their operation', async t => {
  const { rows, ctx } = fixture(t);
  const operationId = 'synthetic-measurement';
  await probe.setup._handler(ctx, { operationId });
  await probe.setup._handler(ctx, { operationId });
  assert.equal(rows.size, 9);
  for (const row of rows.values()) {
    const { table, _id, ...value } = row;
    assert.equal(JSON.stringify(value).length, Number(row.key.split(':').at(-1)));
  }
  const input = { operationId, indexes: 24, bytes: 27648, step: 1 };
  await probe.patch._handler(ctx, input);
  const first = structuredClone([...rows.values()]);
  await probe.patch._handler(ctx, input);
  assert.deepEqual([...rows.values()], first);
  await assert.rejects(probe.patch._handler(ctx, { ...input, step: 3 }), /in sequence/);
  await probe.setup._handler(ctx, { operationId: 'other-measurement' });
  await probe.cleanup._handler(ctx, { operationId });
  await probe.cleanup._handler(ctx, { operationId });
  assert.equal(rows.size, 9);
  assert([...rows.values()].every(row => row.key.startsWith('other-measurement:')));
});
test('synthetic writer refuses every deployment except the explicitly authorized dev deployment', async t => {
  const { rows, ctx } = fixture(t);
  process.env.CONVEX_CLOUD_URL = 'https://synthetic-production.convex.cloud';
  for (const name of ['setup', 'patch', 'cleanup'])
    await assert.rejects(probe[name]._handler(ctx, { operationId: 'synthetic' }), /only on the project dev/);
  assert.equal(rows.size, 0);
});

// Every table has identical document columns; only the number of distinct indexes changes.
test('billed patch calibration has exactly 1, 9 and 24 distinct small-key custom indexes', async () => {
  const { placementPatchProbeTables } = await import(moduleUrl('../convex/placementPatchProbeFields.ts'));
  for (const count of [1, 9, 24]) {
    const definition = placementPatchProbeTables[`placementPatchProbe${count}`].export();
    assert.equal(definition.indexes.length, count);
    assert.equal(new Set(definition.indexes.map(index => JSON.stringify(index.fields))).size, count);
    assert(definition.indexes.every(index => index.fields.length === 2 && index.fields[0] === 'key'));
  }
});
