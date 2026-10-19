// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
const { addDiffstats } = await import(moduleUrl('../convex/projectDiffstatProjection.ts'));
const { compare } = await import(moduleUrl('../convex/projectDiffstats.ts'));
const file = (path, blob) => ({ path, blob, mode: 'file' });

test('hosted diffstats compare only new immutable pairs and reuse prior totals', async () => {
  let reads = 0,
    comparisons = 0;
  const retained = new Map();
  const ctx = {
    runQuery: async (ref, args) => {
      const name = getFunctionName(ref);
      if (name.endsWith(':current')) return { _id: 'generation' };
      if (name.endsWith(':lookups')) return args.keys.map(({ key }) => retained.get(key) ?? null);
      return {};
    },
    runAction: async (ref, args) => {
      if (getFunctionName(ref).endsWith(':changedStates')) {
        reads++;
        return { before: [file('a', 'old')], after: [file('a', 'new')], paths: ['a'] };
      }
      comparisons++;
      assert.equal(args.files.length, 1);
      return { add: 2, del: 1, exact: true };
    },
  };
  const snapshot = {
    backup: { _id: 'backup', projectId: 'project', transport: 'objects' },
    data: {},
    manifest: {
      kind: 'forge-native-work-backup',
      files: ['base', 'head', 'old', 'new'].map(sha256 => ({ sha256, size: 10, path: `objects/${sha256}` })),
    },
  };
  const entries = () =>
    ['lanes', 'views'].map(collection => ({
      collection,
      key: collection,
      parent: '',
      position: 0,
      value: JSON.stringify({ base: 'base', head: 'head', status: 'clean' }),
    }));
  const first = entries();
  await addDiffstats(ctx, snapshot, 'owner', first);
  assert.equal(reads, 1);
  assert.equal(comparisons, 1);
  assert.deepEqual(JSON.parse(first[0].value).changes, { files: 1, add: 2, del: 1 });
  const cache = first.find(row => row.collection === 'diffstats');
  retained.set(cache.key, cache);
  const second = entries();
  await addDiffstats(ctx, snapshot, 'owner', second);
  assert.equal(reads, 1);
  assert.equal(comparisons, 1);
  assert.deepEqual(second, first);
  ctx.runQuery = async () => {
    throw new Error('revoked');
  };
  await assert.rejects(addDiffstats(ctx, snapshot, 'owner', entries()), /revoked/);
});

test('oversized blobs keep aggregate line counts unknown without downloading bytes', async () => {
  const result = await compare._handler(
    { runQuery: () => assert.fail('must not fetch oversized bytes') },
    {
      projectId: 'project',
      actor: 'owner',
      files: [{ after: { sha256: 'large', size: 1024 * 1024 + 1 } }],
    },
  );
  assert.deepEqual(result, { add: 0, del: 0, exact: false, storageReads: 0, storageBytes: 0 });
});

test('hosted comparisons count text changes and whole-file lines from authorized exact blobs', async () => {
  const { digest } = await import('../dist/hash.js');
  const blobs = new Map();
  const pin = text => {
    const bytes = Buffer.from(text),
      sha256 = digest(bytes);
    blobs.set(sha256, bytes);
    return { sha256, size: bytes.length };
  };
  const old = pin('old\n'),
    changed = pin('new\n'),
    added = pin('one\ntwo\n');
  const ctx = {
    runQuery: async (ref, args) =>
      getFunctionName(ref) === 'projectObjects:resolve'
        ? args.digests.map(id => ({ storageId: id, digest: id, size: blobs.get(id).length }))
        : {},
    storage: {
      getMetadata: async id => ({ size: blobs.get(id).length, sha256: id }),
      get: async id => new Blob([blobs.get(id)]),
    },
  };
  const input = {
    projectId: 'project',
    actor: 'owner',
    files: [{ before: old, after: changed }, { after: added }],
  };
  // The action reports its own storage reads for the caller's per-push accounting.
  assert.deepEqual(await compare._handler(ctx, input), {
    add: 3,
    del: 1,
    exact: true,
    storageReads: 3,
    storageBytes: 16,
  });
  ctx.runQuery = async () => {
    throw new Error('revoked');
  };
  await assert.rejects(compare._handler(ctx, input), /revoked/);
});

test('resumable returns budget diffstats and emit each summary once while reusing immutable pairs', async () => {
  const { advanceDiffstats } = await import(moduleUrl('../convex/projectDiffstatProgress.ts'));
  const records = ['lanes', 'views'].map(collection => ({
    collection,
    key: collection,
    parent: '',
    position: 0,
    value: JSON.stringify({ base: 'base', head: 'head' }),
  }));
  const cursor = { records, index: 0, cache: [] };
  const pins = new Map(['old-a', 'new-a', 'old-b', 'new-b'].map(sha256 => [sha256, { sha256, size: 6 }]));
  let reads = 0,
    comparisons = 0;
  const ctx = {
    runQuery: async () => [null],
    runAction: async (_, args) => {
      comparisons++;
      assert.equal(args.files.length, 1);
      return { add: 2, del: 1, exact: true };
    },
  };
  const read = async head => {
    reads++;
    return {
      files: [
        file('a', `${head === 'base' ? 'old' : 'new'}-a`),
        file('b', `${head === 'base' ? 'old' : 'new'}-b`),
      ],
    };
  };
  const entries = [];
  for (let step = 0; step < 20; step++) {
    const result = await advanceDiffstats(
      ctx,
      cursor,
      { projectId: 'project' },
      'generation',
      'owner',
      pins,
      read,
      { states: 16, sourceBytes: 12, fresh: true },
    );
    assert.ok(result.sourceBytes <= 12);
    entries.push(...result.entries);
    if (result.done) break;
    // Every continuation is a durable JSON cursor, including partial line totals.
    Object.assign(cursor, JSON.parse(JSON.stringify(cursor)));
  }
  assert.equal(reads, 2);
  assert.equal(comparisons, 2);
  assert.equal(entries.filter(row => row.collection === 'lanes').length, 1);
  assert.equal(entries.filter(row => row.collection === 'views').length, 1);
  assert.equal(entries.filter(row => row.collection === 'diffstats').length, 1);
  assert.deepEqual(JSON.parse(entries[0].value).changes, { files: 2, add: 4, del: 2 });
  const missing = { records: [records[0]], index: 0, cache: [] };
  const failed = await advanceDiffstats(
    {
      runQuery: async () => {
        throw Error('source unavailable');
      },
    },
    missing,
    { projectId: 'project' },
    'generation',
    'owner',
    pins,
    read,
    { states: 16, sourceBytes: 12, fresh: true },
  );
  assert.deepEqual(failed.entries, [records[0]]);
});
