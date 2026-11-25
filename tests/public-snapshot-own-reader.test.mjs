// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Incident 8947a779 (2026-11-25): the stored search shard carried a fractional `since` (a Convex creation time),
// the Worker's own reader refused it and every visitor of search/1.json got a 502. Every kind of snapshot the
// writer produces must pass the reader the Worker serves it with, and a stored object that does not pass reads
// as missing, never as an outage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';

const { readSlice } = await import(moduleUrl('../convex/publicDirectorySource.ts'));
const { buildPublicDirectory } = await import(moduleUrl('../convex/publicDirectoryProjection.ts'));
const { fitPublicEntity } = await import(moduleUrl('../convex/publicSnapshotFit.ts'));
const { directoryWritePlan } = await import(moduleUrl('../convex/publicDirectoryWrites.ts'));
const read = await import(moduleUrl('../convex/publicRead.ts'));
const { readSnapshot, snapshotAddress } = await import(moduleUrl('../site/public-snapshots.ts'));
const { explorePackBytes, explorePageBytes } = await import(moduleUrl('../src/public-explore-pages.ts'));

const deployment = 'https://example.convex.cloud';
const FRACTION = 0.7266;
const stored = (data, state = {}) => ({
  v: 1,
  state: 'public',
  generation: 1,
  asOf: NOW,
  contentHash: '0'.repeat(64),
  ...data,
  ...state,
});
const whole = data => {
  const json = JSON.stringify(stored(data));
  return { size: Buffer.byteLength(json), text: async () => json };
};
const frame = (data, range) => ({
  size: explorePackBytes,
  range,
  arrayBuffer: async () =>
    new TextEncoder().encode(JSON.stringify(stored(data)).padEnd(explorePageBytes, ' ')).buffer,
});
const bucketOf = object => ({ get: async () => object });
const asRead = (path, object) => {
  const address = snapshotAddress(path);
  assert.ok(address, `${path} is a served snapshot address`);
  return readSnapshot(bucketOf(object(address)), address);
};

/** A real fixture project whose creation time has a fraction, as every Convex document's does. */
async function fractionalFixture() {
  const s = fixture();
  s.tables.hostedProjects.get('project')._creationTime += FRACTION;
  return s;
}

test('incident 8947a779: every snapshot kind the writer produces passes the reader the Worker serves it with', async () => {
  const s = await fractionalFixture();
  const { projects } = await readSlice._handler(s.ctx, { now: NOW, cursor: null });
  assert.equal(projects.length, 1);
  const directory = buildPublicDirectory(projects, deployment);
  const plan = directoryWritePlan(directory, {});
  const kinds = new Set();

  for (const entry of plan.entries) {
    const key = entry.address.key.replace('public-pages/v1/', '');
    if (entry.scope === 'sitemap') {
      kinds.add('sitemap');
      assert.ok(await asRead('/public/v1/sitemap.xml', () => whole(entry.data)), key);
    } else if (entry.scope === 'search') {
      kinds.add('search');
      assert.ok(await asRead(`/public/v1/${key}`, () => whole(entry.data)), key);
    } else {
      kinds.add(`explore/${entry.scope}`);
      for (const [index, page] of entry.frames.entries()) {
        const path = `/public/v1/explore/${entry.scope}${index === 0 ? '' : `/${index + 1}`}.json`;
        assert.ok(await asRead(path, address => frame(page, address.range)), path);
      }
    }
  }
  for (const [kind, data] of [
    [
      'project',
      await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW, snapshot: true }),
    ],
    ['profile', await read.profilePage._handler(s.ctx, { handle: 'ada', now: NOW, snapshot: true })],
  ]) {
    const content = { ...data };
    delete content.v;
    delete content.asOf;
    delete content.stale;
    const limit = kind === 'project' ? 64 * 1024 : 24 * 1024;
    const fitted = fitPublicEntity({
      kind,
      limit,
      generation: 1,
      asOf: NOW,
      data: { ...content, starLookup: true, deployment },
    });
    const path = kind === 'project' ? '/public/v1/project/ada/atlas.json' : '/public/v1/profile/ada.json';
    kinds.add(kind);
    assert.ok(await asRead(path, () => whole(fitted)), path);
  }
  assert.deepEqual(
    [...kinds].sort(),
    ['explore/active', 'explore/newest', 'explore/stars', 'profile', 'project', 'search', 'sitemap'],
    'a new snapshot kind has to be added to this guard',
  );
  assert.ok(
    directory.index.flatMap(shard => shard.projects).every(row => Number.isSafeInteger(row[7])),
    'the stored search rows hold whole numbers',
  );
});

test('incident 8947a779: a stored search shard with a fractional figure reads as missing, not as an outage', async () => {
  const shard = {
    deployment,
    shard: 1,
    total: 1,
    start: 0,
    more: false,
    projects: [['ada', 'atlas', '', 1, null, 0, 0, 1795558578452 + FRACTION]],
  };
  assert.equal(await asRead('/public/v1/search/1.json', () => whole(shard)), null);
  assert.equal(await asRead('/public/v1/search/1.json', () => ({ size: 5, text: async () => '{bad' })), null);
  assert.equal(
    await asRead('/public/v1/search/1.json', () => ({
      size: 1 << 20,
      text: () => assert.fail('no body read'),
    })),
    null,
  );
});
