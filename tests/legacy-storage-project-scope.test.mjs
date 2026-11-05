// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
/** This is an observed limitation, not a new ownership policy. The cleanup must
 * not infer project isolation from an R2 prefix when a body can carry global IDs. */
test('a legacy cursor section can read a global Convex ID through another project binding', async () => {
  const accessed = [],
    foreign = new Uint8Array([11, 22, 33]);
  const ctx = {
    storage: {
      get: async id => {
        accessed.push(id);
        return new Blob([foreign]);
      },
    },
  };
  const bytes = await sourceStorage(ctx, 'synthetic-bench-project').read('synthetic-forge-file');
  assert.deepEqual(bytes, foreign);
  assert.deepEqual(accessed, ['synthetic-forge-file']);
});
