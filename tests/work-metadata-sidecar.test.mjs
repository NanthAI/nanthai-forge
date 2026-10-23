// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { moduleUrl } from './convex-module.mjs';
const { encodeWorkMetadataSidecar, decodeWorkMetadataSidecar } = await import(
  moduleUrl('../convex/workMetadataSidecar.ts')
);
const code = error => error.code === 'INVALID_WORK_BACKUP';
const compressed = async value => Buffer.from(await encodeWorkMetadataSidecar(value).arrayBuffer());

test('binary sidecar preserves original bytes, whitespace, unknown fields and empty metadata', async () => {
  const manifest = Buffer.from(' \n{"future":{"unknown":true}}\n'),
    work = Buffer.from('{"order":2,"z":"£🚀","a":1}\n');
  const bytes = await compressed({ manifest, work }),
    value = decodeWorkMetadataSidecar(bytes);
  assert.deepEqual(Buffer.from(value.manifest), manifest);
  assert.deepEqual(Buffer.from(value.work), work);
  assert.equal(encodeWorkMetadataSidecar({ manifest, work }).type, 'application/gzip');
  assert.deepEqual(
    decodeWorkMetadataSidecar(await compressed({ manifest: Buffer.alloc(0), work: Buffer.alloc(0) })),
    { manifest: Buffer.alloc(0), work: Buffer.alloc(0) },
  );
});

test('codec supports metadata beyond 4 MiB and rejects invalid versions, lengths and decompression', async () => {
  const limit = 5 * 1024 * 1024,
    member = Buffer.alloc(limit, 97),
    bytes = await compressed({ manifest: member, work: member });
  const value = decodeWorkMetadataSidecar(bytes);
  assert.equal(value.manifest.length, limit);
  assert.equal(value.work.length, limit);
  const raw = gunzipSync(await compressed({ manifest: Buffer.from('m'), work: Buffer.from('w') }));
  for (const edit of [
    x => x.write('BAD!'),
    x => x.writeUInt32BE(1, 4),
    x => x.writeUInt32BE(3, 4),
    x => x.writeUInt32BE(2, 8),
    x => x.writeUInt32BE(limit + 1, 12),
  ]) {
    const changed = Buffer.from(raw);
    edit(changed);
    assert.throws(() => decodeWorkMetadataSidecar(gzipSync(changed)), code);
  }
  for (const changed of [
    Buffer.alloc(0),
    Buffer.from('invalid gzip'),
    gzipSync(raw.subarray(0, 15)),
    gzipSync(Buffer.concat([raw, Buffer.from('unowned tail')])),
    gzipSync(Buffer.alloc(16 + 2 * limit + 1)),
  ])
    assert.throws(() => decodeWorkMetadataSidecar(changed), code);
  assert.throws(() => decodeWorkMetadataSidecar(bytes.subarray(0, bytes.length - 1)), code);
});
