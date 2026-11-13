// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const { sourceStateChunks } = await import(moduleUrl('../convex/projectConvexSourceChunks.ts'));

test('byte-range recipe metadata uploads beside changed leaves and no binding escapes before all settle', async () => {
  const files = Array.from({ length: 29000 }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
    blob: 'a'.repeat(64),
    mode: 'file',
  }));
  const before = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'base',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const changed = files.map((file, i) => (i === 1000 ? { ...file, blob: 'b'.repeat(64) } : file));
  const after = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [digest(before)],
      files: changed,
      message: 'save',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const metadataStarted = Promise.withResolvers(),
    puts = [];
  let pendingLeaf = false;
  const writer = sourceStateChunks(
    'project',
    digest,
    async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      puts.push(pin);
      const text = Buffer.from(bytes.subarray(0, 64)).toString();
      if (text.includes('forge-byte-tree') || text.includes('forge-object-recipe')) {
        assert(pendingLeaf, 'metadata starts while a changed leaf PUT is still pending');
        metadataStarted.resolve();
      } else if (bytes.length > 64 * 1024) {
        pendingLeaf = true;
        await metadataStarted.promise;
      }
      return { ...pin, r2Key: `v1/p/project/o/${pin.sha256}` };
    },
    () => {},
  );
  const base = { sha256: digest(before), size: before.length };
  writer.rememberBytes(base, before, {
    descriptor: { object: base, recipe: null },
    storageId: null,
    url: `https://store.invalid/v1/p/project/o/${base.sha256}`,
  });
  const pin = { sha256: digest(after), size: after.length },
    output = await writer.output(pin, after);
  assert(output?.recipe);
  assert.deepEqual({ sha256: output.sha256, size: output.size }, pin);
  assert(puts.length <= 6, 'changed spans and metadata only');
});
