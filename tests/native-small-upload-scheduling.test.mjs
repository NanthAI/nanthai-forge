// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { fixture } from './project-exchange-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { pushNativeExchange, prepareNativeExchange } from '../dist/native-exchange.js';
import { digest } from '../dist/hash.js';
function owner(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-small-scheduling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 64; i++) writeFileSync(join(root, `file-${i}.txt`), Buffer.alloc(65536, i + 1));
  initNative(root);
  return new WorkStore(root);
}
function provider(t) {
  const s = fixture(),
    invoke = s.ctx.runMutation;
  let queue = Promise.resolve(),
    posts = 0,
    bytes = 0,
    active = 0,
    lost = false;
  const hashes = [];
  const serial = fn => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/upload');
    posts++;
    bytes += init.body.byteLength;
    hashes.push(digest(Buffer.from(init.body)));
    active++;
    try {
      await new Promise(resolve => setImmediate(resolve));
      const storageId = await s.ctx.storage.store(
        new Blob([init.body], { type: init.headers['Content-Type'] }),
      );
      return Response.json({ storageId });
    } finally {
      active--;
    }
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  return {
    s,
    stats: () => ({ posts, bytes, active, hashes: [...hashes] }),
    lose: () => {
      lost = true;
    },
    client: {
      query: (fn, args) => s.ctx.runQuery(fn, args),
      mutation: (fn, args) => serial(() => invoke(fn, args)),
      action: (fn, args) =>
        serial(async () => {
          const result = await s.ctx.runAction(fn, args);
          if (lost && getFunctionName(fn) === 'projectExchangeActions:publish') {
            lost = false;
            throw Error('lost original publication reply');
          }
          return result;
        }),
    },
  };
}
test('actual native pushes expose the full small-file page to two independent upload schedulers', async t => {
  const store = owner(t),
    operationId = randomUUID(),
    revision = store.revision();
  const prepared = await prepareNativeExchange(store, revision, operationId, true),
    sourcePins = prepared.manifest.files.filter(x => x.path.startsWith('objects/')),
    sourceHashes = new Set(sourcePins.map(x => x.sha256));
  const run = async lazy => {
    const e = provider(t),
      clients = [0, 1].map(() => {
        const tx = new ConvexExchange(
          'https://fixture.convex.cloud',
          'fixture',
          'project',
          operationId,
          null,
        );
        tx.client = e.client;
        if (!lazy) tx.uploadLazyBatch = undefined;
        return tx;
      }),
      sizes = [];
    if (lazy)
      for (const tx of clients) {
        const upload = tx.uploadLazyBatch.bind(tx);
        tx.uploadLazyBatch = objects => {
          sizes.push(objects.length);
          return upload(objects);
        };
      }
    const replies = await Promise.all(
      clients.map(tx => pushNativeExchange(store, revision, operationId, tx)),
    );
    assert.equal(replies[0].backupId, replies[1].backupId);
    assert.equal(e.stats().active, 0);
    for (const pin of sourcePins) {
      const row = [...e.s.tables.projectObjects.values()].find(x => x.digest === pin.sha256);
      assert(row?.storageId);
      assert.equal(
        digest(Buffer.from(await e.s.ctx.storage.get(row.storageId).then(blob => blob.arrayBuffer()))),
        pin.sha256,
      );
    }
    const before = e.stats();
    const retried = await pushNativeExchange(store, revision, operationId, clients[0]);
    assert.equal(retried.uploadedBytes, 0);
    assert.equal(e.stats().posts, before.posts);
    assert.equal(retried.backupId, replies[0].backupId);
    if (lazy) assert(sizes.some(n => n > 8));
    return {
      posts: before.posts,
      bytes: before.bytes,
      sourcePostAttempts: before.hashes.filter(x => sourceHashes.has(x)).length,
      largestLazyPage: Math.max(0, ...sizes),
    };
  };
  const legacy = await run(false),
    candidate = await run(true);
  assert(candidate.sourcePostAttempts < legacy.sourcePostAttempts);
  assert(candidate.bytes < legacy.bytes);
  t.diagnostic(
    JSON.stringify({
      legacy,
      candidate,
      scope:
        'Actual native push and current backend handlers; same native snapshot and original UUID, two independent clients. Legacy disables optional lazy capability; not a live-provider timing claim.',
    }),
  );
});
test('native lazy source validation rejects changed retained bytes and original publication retry uploads nothing', async t => {
  const store = owner(t),
    e = provider(t),
    operationId = randomUUID(),
    revision = store.revision(),
    tx = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', operationId, null);
  tx.client = e.client;
  const prepared = await prepareNativeExchange(store, revision, operationId, true),
    pin = prepared.manifest.files.find(x => x.path.startsWith('objects/')),
    path = join(store.directory, pin.path),
    original = readFileSync(path),
    upload = tx.uploadLazyBatch.bind(tx);
  let changed = true;
  tx.uploadLazyBatch = objects => {
    if (changed) {
      changed = false;
      writeFileSync(path, Buffer.from('changed retained bytes'));
    }
    return upload(objects);
  };
  await assert.rejects(
    pushNativeExchange(store, revision, operationId, tx),
    error => error.code === 'EXCHANGE_SOURCE_CHANGED',
  );
  assert.equal(e.stats().active, 0);
  assert(!e.stats().hashes.includes(pin.sha256));
  writeFileSync(path, original);
  e.lose();
  const published = await pushNativeExchange(store, revision, operationId, tx);
  assert.ok(published.backupId);
  const before = e.stats();
  const recovered = await pushNativeExchange(store, revision, operationId, tx);
  assert.equal(recovered.uploadedBytes, 0);
  assert.equal(e.stats().posts, before.posts);
  assert.equal(e.stats().active, 0);
});
