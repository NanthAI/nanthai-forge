// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeR2Config, startFakeR2 } from './fake-r2.mjs';
import { moduleUrl } from './convex-module.mjs';

const { publishSnapshot } = await import(moduleUrl('../convex/publicSnapshotStorage.ts'));
const { fitPublicEntity } = await import(moduleUrl('../convex/publicSnapshotFit.ts'));
const address = { key: 'public-pages/v1/project/ada/atlas.json', limit: 64 * 1024 };
const page = (generation, asOf, name = 'Atlas') => ({
  state: 'public',
  generation,
  asOf,
  data: { project: { handle: 'ada', slug: 'atlas', name } },
});
const hide = (generation, at) => ({ state: 'hidden', generation, at });

async function setup(t) {
  const r2 = await startFakeR2(fakeR2Config, { local: true });
  t.after(() => r2.close());
  const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
  const key = r2.key(address.key);
  let attempts = 0;
  const count = () => {
    attempts++;
  };
  return {
    r2,
    measuredPuts: () => attempts,
    read: () => JSON.parse(r2.objects.get(key)),
    publish: selection => publishSnapshot(config, address, async () => selection, count),
    delayed: async selection => {
      const chosen = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const result = publishSnapshot(
        config,
        address,
        async () => {
          chosen.resolve();
          await resume.promise;
          return selection;
        },
        count,
      );
      await Promise.race([chosen.promise, result]);
      return { resume: async () => (resume.resolve(), result) };
    },
  };
}

test('a retained tombstone fences both an old in-flight first publication and later attempted resurrection', async t => {
  const { publish, read, delayed } = await setup(t);
  const old = await delayed(page(1, 100));
  assert.equal(await publish(hide(2, 200)), 'written');
  assert.equal(await old.resume(), 'conflict');
  assert.equal(await publish(page(1, 300)), 'obsolete');
  assert.equal(await publish(page(2, 301)), 'obsolete');
  assert.deepEqual(read(), { v: 1, state: 'hidden', generation: 2, at: 200 });
  assert.equal(await publish(page(3, 400)), 'written', 'restore requires a newer generation');
  assert.equal(read().project.name, 'Atlas');
  assert.equal(await publish(hide(2, 500)), 'obsolete', 'a stale hide must not remove a restored project');
  assert.equal(read().state, 'public');
});

test('a failed revocation remains retryable; success replaces the bytes and excludes an in-flight writer', async t => {
  const { r2, publish, read, delayed, measuredPuts } = await setup(t);
  await publish(page(1, 100, 'Text to remove'));
  const old = await delayed(page(1, 101, 'Delayed copy of public text'));
  r2.failPuts = 1;
  await assert.rejects(publish(hide(2, 200)), error => error.code === 'R2_UPLOAD_FAILED');
  assert.equal(read().project.name, 'Text to remove', 'failure must not be reported as hidden');
  assert.equal(await publish(hide(2, 200)), 'written');
  assert.equal(await old.resume(), 'conflict');
  assert.deepEqual(read(), { v: 1, state: 'hidden', generation: 2, at: 200 });
  assert.equal(await publish(hide(2, 200)), 'unchanged');
  assert.equal(measuredPuts(), 4, 'the rejected CAS and failed attempt cost a PUT, while the no-op does not');
});

test('unchanged contents do not rewrite a page merely because the rebuild time advanced', async t => {
  const { publish, read } = await setup(t);
  await publish(page(1, 100));
  assert.equal(await publish(page(1, 200)), 'unchanged');
  assert.equal(read().asOf, 100);
  assert.equal(await publish(page(1, 300, 'New label')), 'written');
  assert.equal(read().project.name, 'New label');
  assert.equal(read().asOf, 300);
});

for (const [kind, limit] of [
  ['project', 64 * 1024],
  ['profile', 24 * 1024],
  ['explore', 16 * 1024],
  ['search', 64 * 1024],
]) {
  test(`${kind} writer enforces the stored byte cap at the exact limit and one byte over`, async t => {
    const r2 = await startFakeR2(fakeR2Config, { local: true });
    t.after(() => r2.close());
    const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
    const key = `test/${kind}.json`;
    const packed = kind === 'explore';
    const address = { key, limit: packed ? 8 * limit : limit, ...(packed ? { packed: true } : {}) };
    const generation = 1,
      asOf = 123;
    const envelope = { v: 1, state: 'public', generation, asOf, contentHash: '0'.repeat(64) };
    const makeData = title =>
      kind === 'project'
        ? { plan: { next: [{ title }, { title: 'old' }] } }
        : { projects: [{ title }, { title: 'old' }] };
    const base = Buffer.byteLength(JSON.stringify({ ...makeData(''), ...envelope }));
    const publish = data =>
      publishSnapshot(config, address, async () => ({
        state: 'public',
        generation,
        asOf,
        ...(packed ? { frames: [data] } : { data }),
      }));
    const exact = makeData('x'.repeat(limit - base));
    assert.equal(await publish(exact), 'written');
    const bytes = r2.objects.get(r2.key(key));
    assert.equal(bytes.length, address.limit);
    if (packed) assert.equal(bytes[limit - 1], 125, 'the JSON fills the exact frame');
    const over = makeData('x'.repeat(limit - base + 1));
    if (kind === 'project' || kind === 'profile') {
      const fitted = fitPublicEntity({ kind, data: over, limit, generation, asOf });
      assert.equal(fitted.moreCount, 1);
      assert.equal(await publish(fitted), 'written');
      const stored = JSON.parse(r2.objects.get(r2.key(key)));
      assert.equal(stored.moreCount, 1);
      assert.equal((stored.projects ?? stored.plan.next)[0].title.length, limit - base + 1);
    } else {
      await assert.rejects(publish(over), error => error.code === 'BAD_ARGUMENT');
      assert.deepEqual(r2.objects.get(r2.key(key)), bytes);
    }
  });
}
