// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { ownerDerivedPages, resolveOwnerDerived } from '../dist/owner-derived-pages.js';
import { computeOwnerDerived } from '../dist/owner-derived.js';
import { NativeSource } from '../dist/native-source.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { fixture, checkpoint, preparedCheckpoint, upload, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const { readOwnerDerived } = await import(moduleUrl('../convex/projectOwnerDerived.ts'));

test('owner display pages retain all bytes beyond the old cap and reject hash/size tampering', async () => {
  const value = { schema: 3, message: '😀'.repeat(1400000) },
    bytes = Buffer.from(JSON.stringify(value));
  const { root, objects } = ownerDerivedPages(bytes);
  assert.ok(root.length < 4 * 1024 * 1024);
  assert.ok(objects.size > 1);
  let maxBatch = 0,
    maxBytes = 0;
  const read = async pins => {
    maxBatch = Math.max(maxBatch, pins.length);
    maxBytes = Math.max(
      maxBytes,
      pins.reduce((sum, pin) => sum + pin.size, 0),
    );
    return pins.map(p => objects.get(p.sha256));
  };
  assert.deepEqual(await resolveOwnerDerived(root, read), value);
  assert.ok(maxBatch <= 16);
  assert.ok(maxBytes <= 2 * 1024 * 1024);
  const pin = { sha256: digest(root), size: root.length };
  await assert.rejects(
    readOwnerDerived(
      pin,
      async () => root,
      async pins => pins.map(() => Buffer.from('tampered')),
    ),
    e => e.code === 'INVALID_OWNER_DATA',
  );
  await assert.rejects(
    readOwnerDerived({ ...pin, size: pin.size + 1 }, async () => root, read),
    e => e.code === 'INVALID_OWNER_DATA',
  );
  const bad = JSON.parse(root);
  bad.pages[0].size = 128 * 1024 + 1;
  const corrupt = Buffer.from(JSON.stringify(bad));
  await assert.rejects(
    readOwnerDerived({ sha256: digest(corrupt), size: corrupt.length }, async () => corrupt, read),
    e => e.code === 'INVALID_OWNER_DATA',
  );
});

test('display page indexes paginate their own pins without a total document limit', async () => {
  const bytes = Buffer.alloc(501 * 128 * 1024, 32);
  bytes[0] = 91;
  bytes[bytes.length - 1] = 93;
  const { root, objects } = ownerDerivedPages(bytes);
  assert.equal(JSON.parse(root).level, 1);
  assert.ok(root.length < 128 * 1024);
  assert.ok([...objects.values()].every(page => page.length <= 128 * 1024));
  assert.deepEqual(
    await resolveOwnerDerived(root, async pins => pins.map(pin => objects.get(pin.sha256))),
    [],
  );
  const changed = JSON.parse(root);
  changed.level++;
  await assert.rejects(
    resolveOwnerDerived(Buffer.from(JSON.stringify(changed)), async pins =>
      pins.map(pin => objects.get(pin.sha256)),
    ),
    e => e.code === 'INVALID_OWNER_DATA',
  );
});

test('old CLI publication reports the typed upgrade command before object reads', async () => {
  const s = fixture();
  let reads = 0;
  s.ctx.storage.get = async () => {
    reads++;
    throw Error('must not read');
  };
  await assert.rejects(
    modules.projectExchangeActions.publish._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      previous: null,
      digest: 'a'.repeat(64),
      size: 1,
    }),
    e =>
      e.data?.code === 'CLI_UPGRADE_REQUIRED' &&
      /nforge/.test(e.data.message) &&
      /npm install -g/.test(e.data.message),
  );
  assert.equal(reads, 0);
});
