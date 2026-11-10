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
import { readGitPack, writeGitPack } from '../dist/state-git-pack.js';
import { emptyStateGitCache, gitObjectId, stateToGit } from '../dist/state-git.js';
import { dualWriteStateTree } from '../dist/state-tree-dual.js';
import { saveStateTree, convertStateTree, verifyStateTreeSave } from '../dist/state-tree-save.js';
import { TreeSession, WIDE_SEGMENT_SPREAD } from '../dist/state-tree-store.js';
import {
  mergeTrees,
  readStateTree,
  stateTreeRecord,
  treeChanges,
  treeFile,
  treeFiles,
} from '../dist/state-tree.js';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-state-git-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
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

// Tree form (flip 2): a State is a record pointing at a root folder; a save writes one segment.
/** Memory store with ranged reads, counting every R2-shaped call and byte. */
function segmentStore() {
  const store = {
    objects: new Map(),
    puts: 0,
    putBytes: 0,
    gets: 0,
    getBytes: 0,
    async put(bytes) {
      store.puts++;
      store.putBytes += bytes.length;
      const id = digest(bytes);
      store.objects.set(id, Buffer.from(bytes));
      return id;
    },
    async get(id) {
      const bytes = store.objects.get(id);
      assert.ok(bytes, `missing ${id}`);
      store.gets++;
      store.getBytes += bytes.length;
      return bytes;
    },
    async getRange(id, offset, length) {
      const bytes = store.objects.get(id);
      assert.ok(bytes, `missing ${id}`);
      store.gets++;
      store.getBytes += length;
      return bytes.subarray(offset, offset + length);
    },
  };
  return store;
}
const fileOf = file => treeFile(file, readBlob(file.blob));
const filesOf = bytes => JSON.parse(bytes.toString()).files;
/** Changed paths between two manifests, as a save would send them. */
function editsBetween(before, after) {
  const was = new Map(filesOf(before).map(file => [file.path, file])),
    now = new Map(filesOf(after).map(file => [file.path, file])),
    edits = [];
  for (const [path, file] of now) {
    const old = was.get(path);
    if (!old || old.blob !== file.blob || old.mode !== file.mode) edits.push([path, fileOf(file)]);
  }
  for (const path of was.keys()) if (!now.has(path)) edits.push([path, null]);
  return edits;
}
const cold = async (store, pointer) =>
  (await readStateTree(new TreeSession(store, { strict: true }), pointer)).manifest;
const recordOf = bytes => stateTreeRecord(bytes).record;
/** What the save path holds for its base: the pointer, the State id and the parsed flat list. */
const baseOf = ({ pointer, manifest }) => ({ pointer, state: digest(manifest), files: filesOf(manifest) });
const treeSample = {
  'README.md': 'hello\n',
  'a.b': 'dot',
  'a-b': 'dash',
  a0: 'zero',
  'a/b': 'nested',
  'a/c/d.ts': 'export {};\n',
  'bin/run': { text: '#!/bin/sh\n', mode: 'executable' },
  link: { text: 'a/b', mode: 'symlink' },
  'vendor/lib': { text: `${'a'.repeat(40)}\n`, mode: 'gitlink' },
  'é/ü.txt': 'unicode',
  empty: '',
};

test('tree form: a converted State is rebuilt byte for byte by a cold reader and holds real Git trees', async t => {
  const store = segmentStore(),
    bytes = manifest(treeSample, 'first'),
    written = await convertStateTree(store, bytes, fileOf);
  assert.equal(written.exact, true);
  assert.equal(store.puts, 1, 'one segment per save');
  assert.deepEqual(Buffer.from(await cold(store, written.pointer)), bytes);
  // The folders are the Git trees the existing converter (checked against real Git) produces.
  const git = stateToGit(bytes, readBlob, emptyStateGitCache()),
    session = new TreeSession(store),
    { root, record } = await session.open(written.pointer);
  assert.equal(root.oid, git.record.tree);
  assert.equal(record.state, digest(bytes));
  const repo = scratch(t);
  execFileSync('git', ['init', '-q', repo]);
  const trees = [...git.objects.values()].filter(object => object.type === 'tree');
  execFileSync('git', ['-C', repo, 'unpack-objects', '-q'], { input: writeGitPack(git.objects.values()) });
  assert.ok(trees.length >= 5);
  assert.equal(
    execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', '-z', root.oid]).toString(),
    filesOf(bytes)
      .map(file => file.path)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .join('\0') + '\0',
  );
});

test('tree form: a save rewrites only folders on changed paths and equals a full conversion', async () => {
  const store = segmentStore(),
    first = manifest(treeSample, 'first'),
    base = await convertStateTree(store, first, fileOf);
  const steps = [
    { ...treeSample, 'a/c/d.ts': 'export const x = 1;\n' }, // one deep edit
    { ...treeSample, 'a/c/new/deep/file.ts': 'new', 'bin/run': { text: 'x', mode: 'file' } }, // add + mode
    Object.fromEntries(Object.entries(treeSample).filter(([path]) => !path.startsWith('a/'))), // folder goes
    {
      ...treeSample,
      'README.md/now-a-folder': 'x',
      'README.md': undefined,
      a: 'now a file',
      'a/b': undefined,
      'a/c/d.ts': undefined,
    },
    {}, // every file removed
  ].map(files => Object.fromEntries(Object.entries(files).filter(([, value]) => value !== undefined)));
  let previous = { pointer: base.pointer, manifest: first };
  for (const [index, files] of steps.entries()) {
    const next = manifest(files, `save ${index}`, [digest(previous.manifest)]),
      edits = editsBetween(previous.manifest, next),
      saved = await saveStateTree(store, previous.pointer, recordOf(next), edits);
    await verifyStateTreeSave(store, baseOf(previous), { pointer: saved.pointer, manifest: next });
    assert.deepEqual(Buffer.from(await cold(store, saved.pointer)), next);
    const full = await convertStateTree(segmentStore(), next, fileOf);
    assert.equal(saved.pointer.root, full.pointer.root, `step ${index}: same root as a full conversion`);
    if (index === 0) assert.equal(saved.records, 3, 'root, a and a/c; nothing else is rewritten');
    previous = { pointer: saved.pointer, manifest: next };
  }
  // A file and a folder at one path is refused, as the flat writer refuses it.
  await assert.rejects(
    saveStateTree(store, base.pointer, recordOf(first), [
      ['a/b/c', fileOf({ blob: put('x'), mode: 'file' })],
    ]),
    { code: 'INVALID_NATIVE_SOURCE' },
  );
});

test('tree form: equal Git trees with different Forge blobs are different folders', async () => {
  // A submodule pointer with and without its newline pins one commit: one Git tree, two States.
  const store = segmentStore(),
    one = manifest({ 'vendor/lib': { text: `${'a'.repeat(40)}\n`, mode: 'gitlink' } }),
    two = manifest({ 'vendor/lib': { text: 'a'.repeat(40), mode: 'gitlink' } }),
    [x, y] = [await convertStateTree(store, one, fileOf), await convertStateTree(store, two, fileOf)],
    session = new TreeSession(store),
    [a, b] = [await session.open(x.pointer), await session.open(y.pointer)];
  assert.equal(a.root.oid, b.root.oid);
  assert.notEqual(a.root.id, b.root.id);
  assert.deepEqual(
    (await treeChanges(session, a.root, b.root)).map(change => change.path),
    ['vendor/lib'],
  );
  await assert.rejects(
    convertStateTree(store, manifest({ sub: { text: 'b'.repeat(64), mode: 'gitlink' } }), fileOf),
    { code: 'GIT_OBJECT_INVALID' },
  );
});

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0), state / 2 ** 32);
}
test('tree form: the merge walk and the diff walk agree with the flat per-path rule', async () => {
  const same = (x, y) => x === y || (!!x && !!y && x.blob === y.blob && x.mode === y.mode);
  const next = random(20261109);
  for (let round = 0; round < 16; round++) {
    const paths = Array.from(
      { length: 60 },
      (_, i) => `d${i % 5}/${i % 3 ? `e${i % 7}/` : ''}f${i}${i % 11 ? '' : '/g'}`,
    );
    const pick = () =>
      Object.fromEntries(
        paths.flatMap(path => {
          const roll = next();
          return roll < 0.15 ? [] : [[path, roll < 0.3 ? `v${Math.floor(next() * 3)}` : 'base']];
        }),
      );
    const store = segmentStore(),
      sides = await Promise.all(
        [pick(), pick(), pick()].map(async files => {
          const bytes = manifest(files),
            written = await convertStateTree(store, bytes, fileOf);
          return { files: new Map(filesOf(bytes).map(file => [file.path, file])), pointer: written.pointer };
        }),
      ),
      session = new TreeSession(store),
      [base, left, right] = await Promise.all(sides.map(side => session.open(side.pointer))),
      merged = await mergeTrees(session, base.root, left.root, right.root),
      contested = new Map(merged.contested.map(item => [item.path, item])),
      result = new Map((await treeFiles(session, merged.root)).map(file => [file.path, file]));
    for (const path of paths) {
      const [b, l, r] = sides.map(side => side.files.get(path)),
        decided = same(l, r) || same(l, b) || same(r, b),
        expected = same(l, r) ? l : same(l, b) ? r : l;
      if (!decided) {
        const item = contested.get(path);
        assert.ok(item, `round ${round}: ${path} needs the file merge`);
        assert.deepEqual([item.base?.blob, item.left?.blob, item.right?.blob], [b?.blob, l?.blob, r?.blob]);
      }
      // A contested entry may list a path the rule decides (its siblings under a file/folder clash).
      assert.equal(result.get(path)?.blob, expected?.blob, `round ${round}: ${path}`);
    }
    assert.equal(result.size, [...paths].filter(path => result.has(path)).length);
    const changes = await treeChanges(session, base.root, right.root);
    assert.deepEqual(
      changes.map(change => [change.path, change.before?.blob, change.after?.blob]),
      paths
        .filter(path => !same(sides[0].files.get(path), sides[2].files.get(path)))
        .sort()
        .map(path => [path, sides[0].files.get(path)?.blob, sides[2].files.get(path)?.blob]),
    );
  }
});

test('tree form: stored bytes that differ from their identity never yield a State', async () => {
  const store = segmentStore(),
    bytes = manifest(treeSample),
    { pointer } = await convertStateTree(store, bytes, fileOf),
    original = store.objects.get(pointer.segment);
  const tampered = async (edit, pin = pointer) => {
    const copy = Buffer.from(original);
    edit(copy);
    const other = segmentStore();
    other.objects.set(pin.segment, copy);
    // Small segments are read whole and fail on their digest; ranged reads fail on the node id.
    await assert.rejects(readStateTree(new TreeSession(other, { strict: true }), pin), error =>
      ['SOURCE_HASH_MISMATCH', 'GIT_OBJECT_INVALID', 'SOURCE_DIGEST_MISMATCH'].includes(error.code),
    );
    await assert.rejects(readStateTree(new TreeSession(other, { wholeBytes: 0, strict: true }), pin), error =>
      ['SOURCE_HASH_MISMATCH', 'GIT_OBJECT_INVALID', 'SOURCE_DIGEST_MISMATCH'].includes(error.code),
    );
  };
  for (const at of [0, 40, 200, original.length - 60, original.length - 9, original.length - 2])
    await tampered(copy => (copy[at] ^= 1));
  // An ordinary walk skips the whole-segment digest, and still refuses a changed folder record.
  for (const at of [0, 40, 200])
    for (const wholeBytes of [undefined, 0]) {
      const other = segmentStore(),
        copy = Buffer.from(original);
      copy[at] ^= 1;
      other.objects.set(pointer.segment, copy);
      const session = new TreeSession(other, { wholeBytes });
      await assert.rejects(
        session.open(pointer).then(({ root }) => treeFiles(session, root)),
        error => ['SOURCE_HASH_MISMATCH', 'GIT_OBJECT_INVALID'].includes(error.code),
      );
    }
  // A valid segment under a pointer that names another root.
  await tampered(() => {}, { ...pointer, root: digest('other root') });
  // A store that does not return what was put: no pointer is produced.
  const lossy = segmentStore(),
    get = lossy.get;
  lossy.get = async id => {
    const stored = Buffer.from(await get(id));
    stored[10] ^= 1;
    return stored;
  };
  await assert.rejects(convertStateTree(lossy, bytes, fileOf), { code: 'SOURCE_HASH_MISMATCH' });
  // A manifest whose bytes the record cannot reproduce stays flat.
  const odd = Buffer.from(
    JSON.stringify({ ...JSON.parse(bytes.toString()), files: filesOf(bytes).reverse() }),
  );
  assert.deepEqual(await convertStateTree(segmentStore(), odd, fileOf), {
    exact: false,
    reason: 'NON_CANONICAL_MANIFEST',
  });
  // A save whose stored tree disagrees with its flat manifest fails verification.
  const next = manifest({ ...treeSample, extra: 'x' }, 'next', [digest(bytes)]),
    wrong = await saveStateTree(store, pointer, recordOf(next), [
      ['other', fileOf({ blob: put('y'), mode: 'file' })],
    ]);
  await assert.rejects(
    verifyStateTreeSave(store, baseOf({ pointer, manifest: bytes }), {
      pointer: wrong.pointer,
      manifest: next,
    }),
    { code: 'SOURCE_DIGEST_MISMATCH' },
  );
});

test('tree form: a wide folder whose names hit no chunk cut is still read, edited and identified', async () => {
  // The cut rule of wideChunks (FNV-1a of the name, modulo 32), to pick names that never cut.
  const cuts = name => {
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash % 32 === 0;
  };
  const names = Array.from({ length: 400 }, (_, i) => `n${i}.ts`)
    .filter(name => !cuts(name))
    .slice(0, 70);
  assert.equal(names.length, 70, 'more than the 64 entries a plain folder holds');
  const store = segmentStore(),
    files = Object.fromEntries(names.map(name => [`wide/${name}`, name])),
    first = manifest(files),
    base = await convertStateTree(store, first, fileOf);
  assert.equal(base.exact, true);
  const next = manifest({ ...files, [`wide/${names[3]}`]: 'edited' }, 'edit', [digest(first)]),
    saved = await saveStateTree(store, base.pointer, recordOf(next), editsBetween(first, next));
  await verifyStateTreeSave(store, baseOf({ pointer: base.pointer, manifest: first }), {
    pointer: saved.pointer,
    manifest: next,
  });
  assert.deepEqual(Buffer.from(await cold(store, saved.pointer)), next);
  assert.equal((await convertStateTree(segmentStore(), next, fileOf)).pointer.root, saved.pointer.root);
});

test('dual-write: a pointer exists only when the stored tree reproduces the flat State; any doubt keeps it flat', async () => {
  const store = segmentStore(),
    first = manifest(treeSample, 'first'),
    converted = await convertStateTree(store, first, fileOf),
    { link: _removed, ...kept } = treeSample,
    next = manifest({ ...kept, 'a/c/d.ts': 'changed\n', 'new/file': 'n' }, 'next', [digest(first)]);
  const input = (over = {}) => ({
    store,
    base: { pointer: converted.pointer, state: digest(first), files: filesOf(first) },
    next: { value: JSON.parse(next.toString()), manifest: next },
    changes: editsBetween(first, next).map(([path, file]) => ({
      path,
      after: file && { blob: file.blob, mode: file.mode },
    })),
    gitFile: async file => readBlob(file.blob),
    ...over,
  });
  const written = await dualWriteStateTree(input());
  assert.equal(written.status, 'written');
  assert.deepEqual(Buffer.from(await cold(store, written.pointer)), next);
  assert.equal(written.pointer.root, (await convertStateTree(segmentStore(), next, fileOf)).pointer.root);
  // A Git id the caller already derived is used without reading the file again.
  const known = await dualWriteStateTree(input({ gitFile: async file => fileOf(file) }));
  assert.deepEqual(known.pointer, written.pointer);
  // The base has no tree form yet: nothing is written and nothing is wrong.
  const puts = store.puts;
  assert.deepEqual(await dualWriteStateTree(input({ base: { ...input().base, pointer: undefined } })), {
    status: 'skipped',
    reason: 'BASE_HAS_NO_TREE',
  });
  assert.equal(store.puts, puts);
  // Refusals: each returns its reason and never throws, so the flat save is untouched.
  const refused = async (over, code) => {
    const result = await dualWriteStateTree(input(over));
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, code);
  };
  // The change list misses a path: the stored tree would not be this State.
  await refused({ changes: input().changes.slice(1) }, 'SOURCE_DIGEST_MISMATCH');
  // File bytes that are not the named blob.
  await refused({ gitFile: async () => Buffer.from('other bytes') }, 'SOURCE_DIGEST_MISMATCH');
  // The base's flat list is not what its tree holds.
  await refused(
    { base: { ...input().base, files: filesOf(first).filter(file => file.path !== 'README.md') } },
    'SOURCE_DIGEST_MISMATCH',
  );
  // The store fails, or gives back other bytes than it was given.
  const failing = segmentStore();
  for (const [id, bytes] of store.objects) failing.objects.set(id, bytes);
  failing.put = async () => {
    throw new Error('store is down');
  };
  await refused({ store: failing }, 'unexpected');
  const lossy = segmentStore();
  for (const [id, bytes] of store.objects) lossy.objects.set(id, bytes);
  const put = lossy.put;
  lossy.put = async bytes => {
    const id = await put(bytes);
    lossy.objects.get(id)[0] ^= 1;
    return id;
  };
  await refused({ store: lossy }, 'SOURCE_HASH_MISMATCH');
});

/** A synthetic repository: `count` files, 9 per folder, 3 levels deep (about one folder per 8 files). */
function largeFiles(count, wide = 0) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const dir = Math.floor(i / 9),
      mod = Math.floor(dir / 10);
    list.push({
      path: `pkg${Math.floor(mod / 8)}/mod${mod}/dir${dir}/file-${i}.ts`,
      blob: put(`f${i}`),
      mode: 'file',
    });
  }
  for (let i = 0; i < wide; i++)
    list.push({ path: `types/t${i}/index.d.ts`, blob: put(`t${i}`), mode: 'file' });
  return list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
const stateBytes = (files, message, parents = []) =>
  Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents,
      files,
      message,
      at: '2026-11-09T00:00:00.000Z',
    }),
  );

test('tree form budget at 29k files: a save writes kilobytes and a merge reads only differing folders', async t => {
  const store = segmentStore(),
    files = largeFiles(29_000),
    first = stateBytes(files, 'import'),
    base = await convertStateTree(store, first, fileOf);
  assert.equal(base.exact, true);
  const edit = (list, index, textOf) =>
    list.map((file, i) => (i === index ? { ...file, blob: put(textOf) } : file));
  // Two Lanes save one file each from the same base.
  const sides = [],
    baseFlat = baseOf({ pointer: base.pointer, manifest: first });
  for (const [index, name] of [
    [1234, 'left'],
    [20_001, 'right'],
  ]) {
    const next = stateBytes(edit(files, index, name), name, [digest(first)]),
      before = { puts: store.puts, putBytes: store.putBytes, gets: store.gets, getBytes: store.getBytes },
      saved = await saveStateTree(store, base.pointer, recordOf(next), [
        [files[index].path, fileOf({ blob: put(name), mode: 'file' })],
      ]);
    const wrote = store.putBytes - before.putBytes,
      read = store.getBytes - before.getBytes,
      gets = store.gets - before.gets;
    t.diagnostic(
      `save ${name}: wrote ${wrote} B in ${store.puts - before.puts} PUT, read ${read} B in ${gets} GETs; flat manifest ${next.length} B`,
    );
    assert.equal(store.puts - before.puts, 1);
    assert.ok(wrote < 100 * 1024, `a save at 29k files wrote ${wrote} bytes`);
    assert.ok(wrote * 100 < next.length, 'at least 100 times smaller than the flat manifest');
    // Header, four folders on the path (ranged, in the import segment) and the read-back.
    assert.ok(gets <= 8 && read < 256 * 1024, `a save read ${read} bytes in ${gets} GETs`);
    const verify = { gets: store.gets, getBytes: store.getBytes };
    await verifyStateTreeSave(store, baseFlat, { pointer: saved.pointer, manifest: next });
    assert.ok(
      store.gets - verify.gets <= 8 && store.getBytes - verify.getBytes < 256 * 1024,
      'verification costs what changed',
    );
    sides.push({ pointer: saved.pointer, manifest: next });
  }
  const before = { gets: store.gets, getBytes: store.getBytes },
    session = new TreeSession(store),
    [b, l, r] = await Promise.all([base, ...sides].map(side => session.open(side.pointer))),
    merged = await mergeTrees(session, b.root, l.root, r.root);
  assert.deepEqual(merged.contested, []);
  t.diagnostic(
    `merge: read ${store.getBytes - before.getBytes} B in ${store.gets - before.gets} GETs; three flat lists are ${3 * first.length} B`,
  );
  // Three headers, the two small save segments, and the base root (the only shared folder that differs).
  assert.ok(store.gets - before.gets <= 8 && store.getBytes - before.getBytes < 256 * 1024);
  const out = stateBytes(
      edit(edit(files, 1234, 'left'), 20_001, 'right'),
      'merge',
      sides.map(side => digest(side.manifest)),
    ),
    written = await session.finish(stateTreeRecord(out).record, merged.root);
  assert.ok(written.bytes < 100 * 1024);
  assert.deepEqual(Buffer.from(await cold(store, written.pointer)), out);
});

test('tree form: an edit in a wide folder rewrites one chunk, and scattered chunks are gathered', async t => {
  const store = segmentStore(),
    files = largeFiles(200, 6000),
    first = stateBytes(files, 'import');
  let previous = { pointer: (await convertStateTree(store, first, fileOf)).pointer, manifest: first },
    list = files,
    worst = 0,
    total = 0;
  for (let save = 0; save < 14; save++) {
    const index = list.findIndex(file => file.path === `types/t${save * 251}/index.d.ts`);
    list = list.map((file, i) =>
      i === index ? { ...file, path: `types/t${save * 251}/renamed.d.ts` } : file,
    );
    list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const next = stateBytes(list, `save ${save}`, [digest(previous.manifest)]),
      before = store.putBytes,
      saved = await saveStateTree(
        store,
        previous.pointer,
        recordOf(next),
        editsBetween(previous.manifest, next),
      );
    await verifyStateTreeSave(store, baseOf(previous), { pointer: saved.pointer, manifest: next });
    worst = Math.max(worst, store.putBytes - before);
    total += store.putBytes - before;
    previous = { pointer: saved.pointer, manifest: next };
  }
  // `types` holds 6,000 folders: about 250 kB as one Git tree plus 190 kB of identities.
  t.diagnostic(`wide folder: mean ${Math.round(total / 14)} B per save, worst ${worst} B`);
  assert.ok(total / 14 < 100 * 1024, `mean ${total / 14} bytes per save`);
  const gets = store.gets,
    session = new TreeSession(store),
    { root } = await session.open(previous.pointer),
    types = (await session.load(root)).find(entry => entry.name === 'types');
  assert.equal((await session.load({ id: types.id, oid: types.oid, at: types.at })).length, 6000);
  assert.ok(
    store.gets - gets <= 4 + 2 * (WIDE_SEGMENT_SPREAD + 1),
    `a wide folder took ${store.gets - gets} GETs`,
  );
  // The chunking is a function of the content alone: a fresh conversion gives the same identity.
  assert.equal(
    (await convertStateTree(segmentStore(), previous.manifest, fileOf)).pointer.root,
    previous.pointer.root,
  );
  assert.deepEqual(Buffer.from(await cold(store, previous.pointer)), previous.manifest);
});
