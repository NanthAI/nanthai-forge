// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { digest } from '../dist/hash.js';
import { STATE_GIT_CHAIN, readStateGit, writeStateGit } from '../dist/state-git-catalog.js';
import { readGitPack, writeGitPack } from '../dist/state-git-pack.js';
import { gitObjectId } from '../dist/state-git.js';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-state-git-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
/** The ObjectStore get/put interface over memory, counting every R2-shaped call. */
function memoryStore() {
  const store = {
    objects: new Map(),
    puts: 0,
    gets: 0,
    async put(bytes) {
      store.puts++;
      const id = digest(bytes);
      store.objects.set(id, Buffer.from(bytes));
      return id;
    },
    async get(id) {
      store.gets++;
      const bytes = store.objects.get(id);
      assert.ok(bytes, `missing ${id}`);
      return bytes;
    },
  };
  return store;
}
const blobs = new Map();
const put = text => {
  const id = digest(text);
  blobs.set(id, Buffer.from(text));
  return id;
};
const readBlob = id => blobs.get(id);
function manifest(files, message = 'save', parents = []) {
  const list = Object.entries(files)
    .map(([path, value]) => {
      const { text, mode } = typeof value === 'string' ? { text: value, mode: 'file' } : value;
      return { path, blob: put(text), mode };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents,
      files: list,
      message,
      at: '2026-10-30T12:00:00.000Z',
    }),
  );
}
const object = (type, text) => ({ type, bytes: Buffer.from(text) });

test('a pack v2 is read by real Git and round-trips every object', t => {
  const root = scratch(t);
  const big = 'x'.repeat(70_000) + 'y'.repeat(3000);
  const hello = gitObjectId('blob', Buffer.from('hello\n'));
  const tree = {
    type: 'tree',
    bytes: Buffer.concat([Buffer.from('100644 hello\0'), Buffer.from(hello, 'hex')]),
  };
  const objects = [object('blob', ''), object('blob', 'hello\n'), object('blob', big), tree];
  const pack = writeGitPack(objects);
  assert.deepEqual(writeGitPack(objects), pack, 'deterministic bytes');
  const read = readGitPack(pack);
  assert.deepEqual(
    [...read.keys()],
    objects.map(o => gitObjectId(o.type, o.bytes)),
  );
  assert.equal(read.get(gitObjectId('blob', big)).bytes.toString(), big);
  const repo = join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', '-q', repo]);
  execFileSync('git', ['-C', repo, 'index-pack', '--stdin', '--strict'], { input: pack });
  for (const o of objects.slice(0, 3))
    assert.deepEqual(
      execFileSync('git', ['-C', repo, 'cat-file', 'blob', gitObjectId(o.type, o.bytes)]),
      o.bytes,
    );
  assert.match(
    execFileSync('git', ['-C', repo, 'ls-tree', gitObjectId('tree', tree.bytes)]).toString(),
    /hello$/m,
  );
  assert.equal(readGitPack(writeGitPack([])).size, 0);
});

test('bad packs fail closed: trailer, deltas, sizes, truncation and trailing bytes', () => {
  const pack = writeGitPack([object('blob', 'hello')]);
  const resign = body => Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const body = pack.subarray(0, -20);
  const cases = {
    trailer: Buffer.concat([body, Buffer.alloc(20)]),
    version: resign(Buffer.concat([Buffer.from('PACK\0\0\0\x03'), body.subarray(8)])),
    // Type 7 (REF_DELTA) in place of the blob header.
    delta: resign(Buffer.concat([body.subarray(0, 12), Buffer.from([0x75]), body.subarray(13)])),
    size: resign(Buffer.concat([body.subarray(0, 12), Buffer.from([0x34]), body.subarray(13)])),
    count: resign(Buffer.concat([body.subarray(0, 8), Buffer.from([0, 0, 0, 2]), body.subarray(12)])),
    trailing: resign(Buffer.concat([body, Buffer.from('junk')])),
    truncated: resign(body.subarray(0, body.length - 3)),
    short: Buffer.from('PACK'),
  };
  for (const [name, bytes] of Object.entries(cases))
    assert.throws(() => readGitPack(bytes), { code: 'GIT_OBJECT_INVALID' }, name);
});

test('saves chain packs to a snapshot, read back exactly cold or warm, and never leak a sibling', async () => {
  const store = memoryStore();
  const files = {
    'README.md': 'v0',
    'src/a.ts': 'a',
    'src/deep/b.ts': 'b',
    'vendor/lib': { text: `${'a'.repeat(40)}\n`, mode: 'gitlink' },
  };
  const first = await writeStateGit(store, manifest(files), readBlob);
  assert.equal(first.exact, true);
  assert.equal(first.puts, 2);
  assert.equal(first.loaded.value.snapshot, undefined, 'the first save is a snapshot');
  let base = first.loaded;
  const chain = [base];
  for (let save = 1; save <= STATE_GIT_CHAIN; save++) {
    const result = await writeStateGit(
      store,
      manifest({ ...files, 'src/a.ts': `a${save}` }, `s${save}`),
      readBlob,
      base,
    );
    assert.equal(result.exact, true);
    assert.ok(result.puts <= 2);
    base = result.loaded;
    chain.push(base);
  }
  // The 17th save would need a 17th pack, so it starts a new snapshot.
  assert.equal(chain[STATE_GIT_CHAIN - 1].value.packs.length, STATE_GIT_CHAIN);
  assert.equal(chain[STATE_GIT_CHAIN].value.snapshot, undefined);
  for (const loaded of chain) {
    store.gets = 0;
    const cold = await readStateGit(store, loaded.page);
    assert.deepEqual(cold.manifest, loaded.manifest);
    assert.ok(store.gets <= 2 + STATE_GIT_CHAIN);
  }
  // Warm: the parent's chain is already loaded, so only the page and its new pack are read.
  store.gets = 0;
  const warm = await readStateGit(store, chain[5].page, await readStateGit(store, chain[4].page));
  store.gets = 0;
  await readStateGit(store, chain[5].page, warm);
  assert.equal(store.gets, 1);
  // A message-only save writes no pack.
  const same = await writeStateGit(
    store,
    manifest({ ...files, 'src/a.ts': 'a5' }, 'again'),
    readBlob,
    chain[5],
  );
  assert.equal(same.puts, 1);
  // Two siblings off one base; extending one from a warm read of the other stays readable cold.
  const left = await writeStateGit(store, manifest({ ...files, 'left/x': 'L' }), readBlob, chain[2]);
  const right = await writeStateGit(store, manifest({ ...files, 'right/y': 'R' }), readBlob, chain[2]);
  const rightWarm = await readStateGit(store, right.loaded.page, left.loaded);
  assert.equal(rightWarm.objects.size, right.loaded.objects.size);
  assert.deepEqual([...rightWarm.aliases].sort(), [...right.loaded.aliases].sort());
  const next = await writeStateGit(
    store,
    manifest({ ...files, 'right/y': 'R2', 'left/x': 'L' }),
    readBlob,
    rightWarm,
  );
  assert.deepEqual((await readStateGit(memoryCopy(store), next.loaded.page)).manifest, next.loaded.manifest);
});
function memoryCopy(store) {
  const copy = memoryStore();
  copy.objects = new Map(store.objects);
  return copy;
}

test('non-canonical manifests write nothing and tampered pages or packs fail closed', async () => {
  const store = memoryStore();
  const bytes = manifest({ a: 'a', 'b/c': 'c' });
  const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2));
  const skipped = await writeStateGit(store, pretty, readBlob);
  assert.equal(skipped.exact, false);
  assert.equal(store.puts, 0);
  const { loaded } = await writeStateGit(store, bytes, readBlob);
  const page = JSON.parse(inflateSync(store.objects.get(loaded.page)).toString());
  const forge = async value => {
    const id = await store.put(deflateSync(JSON.stringify(value)));
    return readStateGit(store, id);
  };
  const [git, blob] = Object.entries(page.aliases)[0];
  await assert.rejects(forge({ ...page, aliases: { ...page.aliases, [git]: digest('other') } }), {
    code: 'SOURCE_DIGEST_MISMATCH',
  });
  await assert.rejects(forge({ ...page, aliases: {} }), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(forge({ ...page, extra: 1 }), { code: 'GIT_OBJECT_INVALID' });
  const other = await writeStateGit(store, manifest({ z: 'z' }), readBlob);
  await assert.rejects(forge({ ...page, snapshot: other.loaded.page }), { code: 'GIT_OBJECT_INVALID' });
  await assert.rejects(readStateGit(store, await store.put(Buffer.from('not deflate'))), {
    code: 'GIT_OBJECT_INVALID',
  });
  // A pack that carries a file instead of only trees.
  const withBlob = await store.put(writeGitPack([object('blob', blobs.get(blob).toString())]));
  await assert.rejects(forge({ ...page, packs: [withBlob] }), { code: 'GIT_OBJECT_INVALID' });
  // The store returned different bytes than the pin.
  const lying = { ...store, get: async id => (id === loaded.page ? Buffer.from('x') : store.get(id)) };
  await assert.rejects(readStateGit(lying, loaded.page), { code: 'SOURCE_HASH_MISMATCH' });
});

test('dogfood-scale budget: at most 2 R2 PUTs per save, bounded GETs per read, no Convex path', async t => {
  // ~2,750 files in ~180 directories, 300 saves changing ~5 files each.
  const paths = Array.from({ length: 2750 }, (_, i) => `src/m${i % 12}/d${i % 180}/file-${i}.ts`).sort();
  let list = paths.map(path => ({ path, blob: put(`export const v = '${path}';\n`), mode: 'file' }));
  const store = memoryStore();
  let base,
    maxPuts = 0,
    putBytes = 0,
    manifestBytes = 0,
    blobReads = 0,
    maxColdGets = 0,
    maxWarmGets = 0;
  const began = performance.now();
  for (let save = 0; save < 300; save++) {
    if (save)
      list = list.map((file, i) =>
        (i * 7 + save * 13) % 550 === 0 ? { ...file, blob: put(`${file.path} ${save}`) } : file,
      );
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: list,
        message: `s${save}`,
        at: '2026-10-30T00:00:00.000Z',
      }),
    );
    const before = new Set(store.objects.keys()),
      puts = store.puts;
    const result = await writeStateGit(store, bytes, id => (blobReads++, readBlob(id)), base);
    assert.equal(result.exact, true);
    maxPuts = Math.max(maxPuts, store.puts - puts);
    if (save) {
      manifestBytes += bytes.length;
      for (const [id, stored] of store.objects) if (!before.has(id)) putBytes += stored.length;
    }
    if (save % 10 === 0) {
      const gets = store.gets;
      assert.deepEqual((await readStateGit(store, result.loaded.page)).manifest, bytes);
      maxColdGets = Math.max(maxColdGets, store.gets - gets);
    }
    if (base) {
      const gets = store.gets;
      await readStateGit(store, result.loaded.page, base);
      maxWarmGets = Math.max(maxWarmGets, store.gets - gets);
    }
    base = result.loaded;
  }
  const elapsed = performance.now() - began;
  t.diagnostic(
    `saves=299 manifest=${(manifestBytes / 299 / 1024).toFixed(0)}KB/save r2=${(putBytes / 299 / 1024).toFixed(1)}KB/save ` +
      `maxPuts=${maxPuts} coldGets<=${maxColdGets} warmGets<=${maxWarmGets} blobReads=${blobReads} ms=${elapsed.toFixed(0)}`,
  );
  assert.ok(maxPuts <= 2, `puts/save ${maxPuts}`);
  assert.ok(maxColdGets <= 2 + STATE_GIT_CHAIN, `cold gets ${maxColdGets}`);
  assert.ok(maxWarmGets <= 2, `warm gets ${maxWarmGets}`);
  // Each file is hashed once on its first save; later saves read only changed files.
  assert.ok(blobReads <= paths.length + 300 * 6, `blob reads ${blobReads}`);
  assert.ok(putBytes * 10 < manifestBytes, `stored ${putBytes} vs manifests ${manifestBytes}`);
  assert.ok(elapsed < 60_000, `elapsed ${elapsed}`);
});
