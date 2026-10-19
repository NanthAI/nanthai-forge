// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const backend = process.env.FORGE_QUALIFY_BACKEND ?? checkout,
  clientRoot = process.env.FORGE_QUALIFY_CLIENT ?? checkout;
const { fixture } = await import(pathToFileURL(join(backend, 'tests/project-exchange-fixture.mjs')).href);
const recipes = await import(moduleUrl(pathToFileURL(join(backend, 'convex/projectObjectRecipes.ts'))));
const recipeStore = await import(
  moduleUrl(pathToFileURL(join(backend, 'convex/projectObjectRecipeStore.ts')))
);
const { ConvexExchange } = await import(pathToFileURL(join(clientRoot, 'dist/exchange-client.js')).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('concurrent chunk clients share bindings and reconcile a lost recipe reply without further POST bytes', async t => {
  const s = fixture(),
    originalRun = s.ctx.runQuery,
    started = performance.now();
  const invoke = (ref, args) => {
    const [name, method] = getFunctionName(ref).split(':');
    return name === 'projectObjectRecipes'
      ? recipes[method]._handler(s.ctx, args)
      : name === 'projectObjectRecipeStore'
        ? recipeStore[method]._handler(s.ctx, args)
        : originalRun(ref, args);
  };
  // The in-memory provider fixture has no transactions. Serialize mutations to
  // model Convex's atomic mutation contract; actions and POSTs remain concurrent.
  let transaction = Promise.resolve();
  const mutate = (ref, args) => {
    const result = transaction.then(() => invoke(ref, args));
    transaction = result.catch(() => {});
    return result;
  };
  s.ctx.runQuery = invoke;
  s.ctx.runAction = invoke;
  s.ctx.runMutation = mutate;
  let posts = 0,
    postBytes = 0,
    active = 0,
    peak = 0,
    ready = 0,
    release;
  const barrier = new Promise(resolve => {
    release = resolve;
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://fixture.invalid/upload') return fetch(url, init);
    posts++;
    postBytes += init.body.byteLength;
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      const storageId = await s.ctx.storage.store(
        new Blob([init.body], { type: init.headers['Content-Type'] }),
      );
      return { ok: true, json: async () => ({ storageId }) };
    } finally {
      active--;
    }
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const clients = [0, 1].map(index => {
    const client = new ConvexExchange(
      'https://fixture.convex.cloud',
      'private-fixture',
      'project',
      randomUUID(),
      null,
    );
    let firstMissing = true,
      loseReply = index === 0;
    client.client = {
      query: async (ref, args) => {
        if (firstMissing && getFunctionName(ref) === 'projectObjects:missing') {
          firstMissing = false;
          if (++ready === 2) release();
          await barrier;
        }
        return invoke(ref, args);
      },
      mutation: mutate,
      action: async (ref, args) => {
        const result = await invoke(ref, args);
        if (loseReply && getFunctionName(ref) === 'projectObjectRecipes:complete') {
          loseReply = false;
          throw Error('deliberately lost post-commit reply');
        }
        return result;
      },
    };
    return client;
  });
  const bytes = randomBytes(5 * 1024 * 1024 + 13),
    pin = { sha256: hash(bytes), size: bytes.length };
  const result = await Promise.allSettled(clients.map(client => client.upload(pin, bytes)));
  assert.equal(result[0].status, 'rejected');
  assert.match(result[0].reason.message, /lost post-commit/);
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(active, 0);
  assert(peak > 1, 'POST transfers actually overlap');
  const initialPosts = posts,
    initialBytes = postBytes,
    before = structuredClone([...s.tables.projectObjects.values()]);
  const retry = await clients[0].upload(pin, bytes);
  assert.equal(retry.uploadedObjects, 0);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(posts, initialPosts);
  assert.equal(postBytes, initialBytes);
  assert.deepEqual([...s.tables.projectObjects.values()], before);
  const rows = [...s.tables.projectObjects.values()].filter(row => !row.removed);
  assert.equal(
    new Set(rows.map(row => row.digest)).size,
    rows.length,
    'one logical binding per shared digest',
  );
  const logical = rows.find(row => row.digest === pin.sha256);
  assert(logical.recipe);
  assert.equal(logical.storageId, undefined);
  assert(
    ![...s.files.values()].some(file => file.metadata.size === bytes.length),
    'no reconstructed whole-file duplicate',
  );
  const downloaded = await clients[1].download(pin);
  assert.deepEqual(downloaded, bytes);
  s.caller('stranger');
  await assert.rejects(clients[1].download(pin), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  t.diagnostic(
    JSON.stringify({
      clients: 2,
      posts,
      postBytes,
      uniquePhysicalBytes: [...s.files.values()].reduce((sum, file) => sum + file.metadata.size, 0),
      peakConcurrentPosts: peak,
      retryPosts: posts - initialPosts,
      elapsedMs: performance.now() - started,
      qualification:
        'Real client and backend handlers with an in-memory provider and serialized mutation contract; not live-provider concurrency or a production-load benchmark.',
    }),
  );
});
