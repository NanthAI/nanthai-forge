// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeR2Config, startFakeR2 } from './fake-r2.mjs';
import { moduleUrl } from './convex-module.mjs';

const { buildPublicDirectory } = await import(moduleUrl('../convex/publicDirectoryProjection.ts'));
const { directoryWritePlan, writeDirectoryBatch } = await import(
  moduleUrl('../convex/publicDirectoryWrites.ts')
);
const { readSnapshot, snapshotAddress } = await import(moduleUrl('../site/public-snapshots.ts'));
const deployment = 'https://example.convex.cloud';
const rows = Array.from({ length: 401 }, (_, index) => ({
  handle: 'ada',
  slug: `atlas-${index}`,
  name: `Atlas ${index}`,
  since: index,
  stars: index,
  landings: index,
  main: 'passing',
}));
const frameBytes = 16 * 1024;

function boundBucket(r2) {
  return {
    async get(key, options) {
      const bytes = r2.objects.get(r2.key(key));
      if (!bytes) return null;
      if (!options) return { size: bytes.length, text: async () => bytes.toString('utf8') };
      const { range } = options;
      const copy = Uint8Array.from(bytes.subarray(range.offset, range.offset + range.length));
      return { size: bytes.length, range, arrayBuffer: async () => copy.buffer };
    },
  };
}

test('revocation fences pack-wide writes and removes the revoked row from every range and search', async t => {
  const r2 = await startFakeR2(fakeR2Config, { local: true });
  t.after(() => r2.close());
  const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
  const bucket = boundBucket(r2);
  const old = directoryWritePlan(buildPublicDirectory(rows, deployment), {});
  const write = (plan, generation, now, isCurrent = async () => true) =>
    writeDirectoryBatch(config, plan.entries, generation, now, isCurrent);
  assert.deepEqual(
    await write(old, 1, 100),
    old.entries.map(() => 'written'),
  );
  assert.deepEqual(
    await write(old, 1, 110),
    old.entries.map(() => 'unchanged'),
  );
  const ninth = snapshotAddress('/public/v1/explore/active/9.json');
  assert.equal((await readSnapshot(bucket, ninth)).data.projects[0].slug, 'atlas-0');

  const observed = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const stale = directoryWritePlan(
    buildPublicDirectory(
      rows.map(row => (row.slug === 'atlas-0' ? { ...row, name: 'Stale copy' } : row)),
      deployment,
    ),
    old.lengths,
  );
  const inFlight = write(stale, 1, 120, () => {
    observed.resolve();
    return resume.promise;
  });
  await Promise.race([inFlight, observed.promise]);
  const next = directoryWritePlan(buildPublicDirectory(rows.slice(1), deployment), old.lengths);
  try {
    assert.deepEqual(
      await write(next, 2, 200),
      next.entries.map(() => 'written'),
    );
  } finally {
    resume.resolve(true);
  }
  assert.ok((await inFlight).includes('conflict'));
  assert.deepEqual(
    await write(old, 1, 100),
    old.entries.map(() => 'obsolete'),
  );
  assert.deepEqual(
    await write(old, 3, 200, async () => false),
    old.entries.map(() => 'obsolete'),
  );
  assert.equal(
    await readSnapshot(bucket, ninth),
    null,
    'a retired pack gives 404-equivalent tombstones for valid ranges',
  );
  assert.equal(await readSnapshot(bucket, snapshotAddress('/public/v1/explore/active/16.json')), null);
  for (const entry of next.entries) {
    const raw = r2.objects.get(r2.key(entry.address.key));
    if (!entry.frames) {
      const snapshot = JSON.parse(raw);
      assert.equal(snapshot.generation, 2);
      assert.ok(snapshot.projects.every(row => row[1] !== 'atlas-0'));
      if (entry.scope === 'sitemap') assert.deepEqual(entry.cachePaths, ['/sitemap.xml']);
      continue;
    }
    assert.equal(raw.length, 8 * frameBytes);
    assert.equal(entry.cachePaths.length, entry.scope === 'active' && entry.frames.length ? 9 : 8);
    for (let index = 0; index < 8; index++) {
      const snapshot = JSON.parse(raw.subarray(index * frameBytes, (index + 1) * frameBytes));
      assert.equal(snapshot.generation, 2);
      if (entry.frames[index]) assert.ok(snapshot.projects.every(row => row.slug !== 'atlas-0'));
      else
        assert.deepEqual(snapshot, {
          v: 1,
          state: 'hidden',
          generation: 2,
          at: 200,
          ...(entry.frames.length ? {} : { tailRevision: 200 }),
        });
    }
  }
});

test('retired Explore packs and search shards reopen only in a later publication of the same generation', async t => {
  const r2 = await startFakeR2(fakeR2Config, { local: true });
  t.after(() => r2.close());
  const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
  const source = Array.from({ length: 900 }, (_, i) => ({
    ...rows[i % rows.length],
    slug: `atlas-${i}-${'s'.repeat(80)}`,
    name: 'N'.repeat(80),
  }));
  const first = directoryWritePlan(buildPublicDirectory(source, deployment), {});
  const small = directoryWritePlan(buildPublicDirectory(source.slice(0, 1), deployment), first.lengths);
  const isTail = entry => ('frames' in entry && !entry.frames.length) || ('data' in entry && !entry.data);
  const retired = small.entries.filter(isTail);
  assert.ok(retired.some(entry => entry.scope === 'active'));
  assert.ok(retired.some(entry => entry.scope === 'search'));
  const active = first.entries.filter(entry => retired.some(tail => tail.address.key === entry.address.key));
  const version = (entries, revision) =>
    writeDirectoryBatch(config, entries.slice(0, 16), 4, 300, async () => true, undefined, revision);
  assert.ok(active.length <= 16);
  assert.ok((await version(active, 1)).every(status => status === 'written'));
  assert.ok((await version(retired, 2)).every(status => status === 'written'));
  assert.ok((await version(active, 2)).every(status => status === 'obsolete'));
  assert.ok((await version(active, 3)).every(status => status === 'written'));
  for (const entry of active) {
    const bytes = r2.objects.get(r2.key(entry.address.key));
    const envelope = JSON.parse(entry.scope === 'search' ? bytes : bytes.subarray(0, frameBytes));
    assert.equal(envelope.state, 'public');
    assert.equal(envelope.generation, 4);
  }
});
