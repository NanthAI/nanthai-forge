// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync, linkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SourceFileReader } from '../dist/source-file-reader.js';
import { ObjectRecipeBuilder, buildObjectRecipe, readObjectRecipe } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-source-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
};
test('bounded scan produces identical recipes regardless of read boundaries and exact missing-range reads', async t => {
  const root = fixture(t),
    bytes = randomBytes(7 * 1024 * 1024 + 31);
  writeFileSync(join(root, 'source'), bytes);
  const expected = buildObjectRecipe(bytes),
    objects = new Map(),
    reader = new SourceFileReader(root, 'source');
  t.after(() => reader.close());
  let max = 0,
    read = 0;
  const builder = new ObjectRecipeBuilder((chunk, offset) => {
    const pin = { sha256: digest(chunk), size: chunk.length };
    objects.set(pin.sha256, offset === null ? Buffer.from(chunk) : { ...pin, offset });
    return pin;
  });
  const pin = reader.scan(part => {
    max = Math.max(max, part.length);
    read += part.length;
    for (let i = 0; i < part.length; i += 7919) builder.update(part.subarray(i, i + 7919));
  }, digest(bytes));
  const built = builder.finish(pin);
  assert.deepEqual(built.bytes, expected.bytes);
  assert.equal(read, bytes.length);
  assert(max <= 1024 * 1024);
  const parts = [];
  for await (const part of readObjectRecipe(built.recipe, async p => {
    const value = objects.get(p.sha256);
    return Buffer.isBuffer(value) ? value : reader.read(value.offset, value.size, value.sha256);
  }))
    parts.push(part);
  assert.deepEqual(Buffer.concat(parts), bytes);
});
test('source scan rejects wrong identity, changed bytes, replacement paths and linked inputs', t => {
  const root = fixture(t),
    bytes = randomBytes(2 * 1024 * 1024 + 1),
    path = join(root, 'source');
  writeFileSync(path, bytes);
  const use = fn => {
    const reader = new SourceFileReader(root, 'source');
    try {
      fn(reader);
    } finally {
      reader.close();
    }
  };
  use(reader =>
    assert.throws(() => reader.scan(() => {}, '0'.repeat(64)), { code: 'EXCHANGE_SOURCE_CHANGED' }),
  );
  use(reader =>
    assert.throws(
      () =>
        reader.scan((_, offset) => {
          if (offset === 0) writeFileSync(path, Buffer.alloc(bytes.length));
        }, digest(bytes)),
      { code: 'EXCHANGE_SOURCE_CHANGED' },
    ),
  );
  writeFileSync(path, bytes);
  use(reader => {
    reader.scan(() => {}, digest(bytes));
    writeFileSync(join(root, 'replacement'), bytes);
    renameSync(join(root, 'replacement'), path);
    assert.throws(() => reader.read(0, 4, digest(bytes.subarray(0, 4))), { code: 'EXCHANGE_SOURCE_CHANGED' });
  });
  symlinkSync(path, join(root, 'link'));
  assert.throws(() => new SourceFileReader(root, 'link'), { code: 'EXCHANGE_SOURCE_CHANGED' });
  linkSync(path, join(root, 'hardlink'));
  assert.throws(() => new SourceFileReader(root, 'source'), { code: 'EXCHANGE_SOURCE_CHANGED' });
});
test('digest-bound timestamp normalization remains supported but source mutation during range reads is rejected', t => {
  const root = fixture(t),
    bytes = randomBytes(2 * 1024 * 1024 + 5),
    path = join(root, 'source');
  writeFileSync(path, bytes);
  const reader = new SourceFileReader(root, 'source');
  t.after(() => reader.close());
  let changed = false;
  assert.deepEqual(
    reader.scan(() => {
      if (!changed) {
        changed = true;
        utimesSync(path, new Date(100000), new Date(100000));
      }
    }, digest(bytes)),
    { sha256: digest(bytes), size: bytes.length },
  );
  const altered = Buffer.from(bytes);
  altered[5] ^= 1;
  writeFileSync(path, altered);
  assert.throws(() => reader.read(0, 10, digest(bytes.subarray(0, 10))), { code: 'EXCHANGE_SOURCE_CHANGED' });
});

test('one caller-owned scan buffer can be reused across files and repeated reads', t => {
  const root = fixture(t),
    scratch = Buffer.allocUnsafe(7);
  for (const [name, text] of [
    ['one', 'first bytes across several reads'],
    ['two', 'second file'],
  ]) {
    const bytes = Buffer.from(text);
    writeFileSync(join(root, name), bytes);
    const reader = new SourceFileReader(root, name);
    try {
      const parts = [];
      const pin = reader.scan(
        part => {
          assert.equal(part.buffer, scratch.buffer);
          parts.push(Buffer.from(part));
        },
        digest(bytes),
        scratch,
      );
      assert.deepEqual(Buffer.concat(parts), bytes);
      assert.deepEqual(pin, { sha256: digest(bytes), size: bytes.length });
      assert.throws(() => reader.scan(() => {}, undefined, Buffer.alloc(0)), {
        code: 'EXCHANGE_SOURCE_CHANGED',
      });
    } finally {
      reader.close();
    }
  }
});
