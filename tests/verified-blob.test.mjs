// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';

const { sha256Hex, verifiedBytes } = await import(moduleUrl('../web/src/verified-blob.ts'));
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

test('browser sha256 matches the Node digest, including empty and subarray views', async () => {
  const bytes = new TextEncoder().encode('browser bytes');
  assert.equal(await sha256Hex(bytes), hex(bytes));
  assert.equal(await sha256Hex(new Uint8Array(0)), hex(''));
  const view = new Uint8Array([9, 9, ...bytes, 9]).subarray(2, 2 + bytes.length);
  assert.equal(await sha256Hex(view), hex(bytes));
});

test('verifiedBytes returns matching bytes and rejects a mismatch with BLOB_DIGEST_MISMATCH', async () => {
  const bytes = new TextEncoder().encode('exact');
  assert.equal(await verifiedBytes(bytes, hex(bytes)), bytes);
  assert.equal(await verifiedBytes(bytes, hex(bytes).toUpperCase()), bytes);
  await assert.rejects(verifiedBytes(new TextEncoder().encode('exacT'), hex(bytes)), {
    code: 'BLOB_DIGEST_MISMATCH',
  });
});
