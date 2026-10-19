// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { WorkStore } from '../dist/work-store.js';
import { resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { digest } from '../dist/hash.js';
test('production native v2 push pins concurrent Work for the next push and reuses original retry bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-record-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const work = new WorkService(root),
    objects = new Map();
  let previous,
    writeDuringUpload = true;
  const transport = {
    metadataTrees: true,
    workRecords: true,
    checkpointKey: (id = previous) => id,
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, Buffer.from(bytes));
      if (writeDuringUpload) {
        writeDuringUpload = false;
        work.execute({ action: 'intent', outcome: 'Arrived during upload' }, work.store.revision());
      }
    },
    publish: async pin => pin.sha256,
  };
  const revision = work.store.revision();
  const first = await pushNativeExchange(work.store, revision, randomUUID(), transport);
  previous = first.backupId;
  const read = pins => Promise.resolve(pins.map(pin => objects.get(pin.sha256)));
  const firstBytes = objects.get(first.digest);
  assert.equal(JSON.parse(firstBytes).schema, 2);
  const firstWork = JSON.parse((await resolveExchangeRoot(firstBytes, read)).work);
  assert.equal(firstWork.intents.length, 0);
  assert.equal(work.store.load().intents.length, 1);
  const operation = randomUUID(),
    nextRevision = work.store.revision();
  const next = await pushNativeExchange(work.store, nextRevision, operation, transport);
  const nextBytes = objects.get(next.digest),
    nextRoot = JSON.parse(nextBytes);
  assert.equal(nextRoot.schema, 2);
  assert.ok(nextRoot.delta);
  assert.equal(
    JSON.parse((await resolveExchangeRoot(nextBytes, read)).work).intents[0].outcome,
    'Arrived during upload',
  );
  const retry = await pushNativeExchange(work.store, nextRevision, operation, transport);
  assert.equal(retry.digest, next.digest);
  assert.equal(retry.uploadedBytes, 0);
  const restored = `${root}-received`;
  const logical = new Map();
  t.after(() => rmSync(restored, { recursive: true, force: true }));
  await pullNativeExchange(next.backupId, restored, {
    ...transport,
    manifest: async id => {
      const resolved = await resolveExchangeRoot(objects.get(id), read);
      logical.set(digest(resolved.work), resolved.work);
      return {
        json: resolved.manifest.toString('utf8'),
        digest: digest(resolved.manifest),
        size: resolved.manifest.length,
        sourceDigest: id,
      };
    },
    download: async pin => logical.get(pin.sha256) ?? objects.get(pin.sha256),
    downloadBatch: async pins => pins.map(pin => logical.get(pin.sha256) ?? objects.get(pin.sha256)),
  });
  assert.equal(new WorkStore(restored).load().intents[0].outcome, 'Arrived during upload');
});
