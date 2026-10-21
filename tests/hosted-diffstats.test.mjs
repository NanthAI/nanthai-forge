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
