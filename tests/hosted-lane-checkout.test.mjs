// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  mkdirSync,
  readdirSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { finishGates } from '../dist/agent-default-gates.js';
import { runPreflight, preflightPlan } from '../dist/agent-preflight.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { sourceTree } from '../dist/source-tree.js';
import { nativeFile } from '../dist/native-file.js';
import { digest } from '../dist/hash.js';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-lane-checkout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'client'),
    objects = new Map(),
    calls = { select: 0, objects: [], downloads: [] };
  const put = value => {
    const bytes = Buffer.from(value),
      id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const binary = Buffer.from([0, 255, 128, 1, 10, 0]);
  const files = [
    { path: 'src/a.txt', blob: put('first\n'), mode: 'file' },
    { path: 'bin/run', blob: put('#!/bin/sh\necho synthetic\n'), mode: 'executable' },
    { path: 'binary.dat', blob: put(binary), mode: 'file' },
    { path: 'link', blob: put('src/a.txt'), mode: 'symlink' },
    { path: 'dangling', blob: put('../missing'), mode: 'symlink' },
  ];
  const state = entries =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: entries,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  let selection = {
    schema: 2,
    projectId: 'project',
    laneId: randomUUID(),
    intentId: randomUUID(),
    head: state(files),
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head: 'a'.repeat(64), receiptId: 'base' },
    authority: { mode: 'server', epoch: 1 },
  };
  let allowed = true;
  const transport = {
    select: async () => {
      calls.select++;
      assert(allowed, 'reader revoked');
      return structuredClone(selection);
    },
    objects: async ids => {
      calls.objects.push([...ids]);
      assert(ids.length <= 100);
      return ids.map(sha256 => ({ sha256, size: objects.get(sha256).length }));
    },
    downloadToFile: async (pin, path) => {
      calls.downloads.push(pin.sha256);
      writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 });
    },
  };
  const request = extra => ({
    url: 'https://fixture.invalid',
    projectId: 'project',
    laneId: selection.laneId,
    operationId: randomUUID(),
    ...extra,
  });
  const advance = entries => {
    selection = {
      ...selection,
      head: state(entries),
      version: selection.version + 1,
      sourceVersion: selection.sourceVersion + 1,
    };
  };
  return {
    root,
    directory,
    objects,
    calls,
    put,
    state,
    files,
    binary,
    transport,
    request,
    advance,
    selection: () => structuredClone(selection),
    revoke: () => {
      allowed = false;
    },
  };
}
test('full Lane checkout round-trips executable, regular, binary, live and dangling symlink bytes', async t => {
  const s = setup(t),
    result = await checkoutHostedLane(s.root, s.request(), s.transport);
  assert.equal(result.head, s.selection().head);
  assert.equal(readHostedLaneCheckout(s.root).tree, sourceTree(s.files));
  for (const file of s.files) {
    const actual = nativeFile(result.root, file.path);
    assert.equal(actual.mode, file.mode);
    assert.deepEqual(actual.bytes, s.objects.get(file.blob));
  }
  assert(lstatSync(join(s.root, 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(s.root, 'dangling')), '../missing');
  assert.equal(existsSync(join(s.root, '.forge/native.json')), false);
  assert.equal(existsSync(join(s.root, '.forge/work')), false);
  assert.equal(result.downloadedObjects, 6);
  const warm = await checkoutHostedLane(s.root, s.request(), s.transport);
  assert.equal(warm.downloadedObjects, 0);
  assert.equal(warm.downloadedBytes, 0);
});

test('a nested checkout lazily builds exact overlap evidence from its shared baseline objects', async t => {
  const s = setup(t),
    shared = join(s.directory, 'shared-objects');
  await checkoutHostedLane(s.root, s.request(), s.transport, shared);
  const cache = `${s.root}.forge-client`;
  assert.equal(existsSync(join(cache, 'overlap-text')), false);
  writeFileSync(join(s.root, 'src/a.txt'), 'second\n');
  const capture = await captureHostedSave(s.root, join(s.directory, 'save'));
  assert.equal(capture.changes.length, 1);
  assert.deepEqual(capture.changes[0].evidence, {
    baseBlob: s.files[0].blob,
    ranges: [{ start: 0, end: 1 }],
    symbols: [],
  });
  assert.equal(
    readdirSync(join(cache, 'overlap-text')).length,
    2,
    'only original and changed text are summarized',
  );
});

for (const mode of ['file', 'symlink'])
  test(`machine ${mode} replacement after cache discovery is repaired, never installed`, async t => {
    const s = setup(t),
      machine = join(s.directory, 'machine');
    const previous = process.env.FORGE_OBJECT_CACHE;
    process.env.FORGE_OBJECT_CACHE = machine;
    t.after(() => {
      if (previous === undefined) delete process.env.FORGE_OBJECT_CACHE;
      else process.env.FORGE_OBJECT_CACHE = previous;
    });
    const file = s.files.find(file => file.mode === mode),
      select = s.transport.select;
    s.transport.select = async () => {
      const selection = await select();
      if (s.calls.select === 2) writeFileSync(join(machine, file.blob), 'tampered');
      return selection;
    };
    const request = s.request();
    // Install verification finds the replaced entry and fetches it again: the open
    // completes with the selected bytes instead of installing the replacement.
    const recovered = await checkoutHostedLane(s.root, request, s.transport);
    assert.equal(s.calls.downloads.filter(id => id === file.blob).length, 2);
    assert.deepEqual(readFileSync(join(machine, file.blob)), s.objects.get(file.blob));
    assert.deepEqual(nativeFile(recovered.root, file.path).bytes, s.objects.get(file.blob));
    writeFileSync(join(s.root, 'src/a.txt'), 'local edit\n');
    assert.deepEqual(readFileSync(join(machine, s.files[0].blob)), s.objects.get(s.files[0].blob));
  });
for (const damage of ['permissions', 'symlink', 'hardlink'])
  test(`a machine cache entry with unsafe ${damage} is refetched without denying the checkout`, async t => {
    const s = setup(t),
      machine = join(s.directory, 'machine'),
      previous = process.env.FORGE_OBJECT_CACHE;
    process.env.FORGE_OBJECT_CACHE = machine;
    t.after(() => {
      if (previous === undefined) delete process.env.FORGE_OBJECT_CACHE;
      else process.env.FORGE_OBJECT_CACHE = previous;
    });
    mkdirSync(machine);
    for (const [id, bytes] of s.objects) writeFileSync(join(machine, id), bytes, { mode: 0o600 });
    const file = s.files[0],
      path = join(machine, file.blob),
      external = join(s.directory, 'preserved');
    writeFileSync(external, s.objects.get(file.blob), { mode: 0o600 });
    if (damage === 'permissions') chmodSync(path, 0o644);
    else {
      rmSync(path);
      if (damage === 'symlink') symlinkSync(external, path);
      else linkSync(external, path);
    }
    const result = await checkoutHostedLane(s.root, s.request(), s.transport);
    assert.deepEqual(nativeFile(result.root, file.path).bytes, s.objects.get(file.blob));
    assert.deepEqual(readFileSync(external), s.objects.get(file.blob));
    assert.deepEqual(s.calls.downloads, [file.blob], 'only the damaged disposable entry is fetched');
    assert.equal(lstatSync(path).nlink, 1);
    assert.equal(lstatSync(path).mode & 0o077, 0);
  });

// Direct machine hits are hashed once, at install; damage found there is repaired.
for (const damage of ['file', 'symlink', 'state'])
  test(`changed machine bytes for a ${damage} are found at install and fetched again`, async t => {
    const s = setup(t),
      machine = join(s.directory, 'machine'),
      previous = process.env.FORGE_OBJECT_CACHE;
    process.env.FORGE_OBJECT_CACHE = machine;
    t.after(() => {
      if (previous === undefined) delete process.env.FORGE_OBJECT_CACHE;
      else process.env.FORGE_OBJECT_CACHE = previous;
    });
    mkdirSync(machine);
    for (const [id, bytes] of s.objects) writeFileSync(join(machine, id), bytes, { mode: 0o600 });
    const blob = damage === 'state' ? s.selection().head : s.files[damage === 'file' ? 0 : 3].blob;
    writeFileSync(join(machine, blob), 'tampered private bytes', { mode: 0o600 });
    const result = await checkoutHostedLane(s.root, s.request(), s.transport);
    assert.deepEqual(s.calls.downloads, [blob], 'only the damaged entry is fetched');
    assert.deepEqual(readFileSync(join(machine, blob)), s.objects.get(blob));
    for (const file of s.files)
      if (file.mode === 'symlink')
        assert.equal(readlinkSync(join(result.root, file.path)), String(s.objects.get(file.blob)));
      else assert.deepEqual(nativeFile(result.root, file.path).bytes, s.objects.get(file.blob));
    assert.equal(result.machineObjects, s.files.length, 'repaired entries are not counted as machine hits');
  });
test('sparse marker retains omitted paths and exact baselines; expansion and full checkout are additive', async t => {
  const s = setup(t);
  await checkoutHostedLane(s.root, s.request({ paths: ['src'] }), s.transport);
  const first = readHostedLaneCheckout(s.root);
  assert.deepEqual(first.state.files, s.files);
  assert.deepEqual(first.materialized, ['src/a.txt']);
  assert.equal(existsSync(join(s.root, 'binary.dat')), false);
  assert(!s.calls.downloads.includes(s.files[2].blob));
  const expanded = await checkoutHostedLane(s.root, s.request({ paths: ['binary.dat'] }), s.transport);
  assert.equal(expanded.downloadedObjects, 1);
  assert.deepEqual(readFileSync(join(s.root, 'binary.dat')), s.binary);
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'first\n');
  assert.equal(readHostedLaneCheckout(s.root).state.files.length, 5);
  rmSync(join(s.root, 'src/a.txt'));
  const baseline = readHostedLaneCheckout(s.root);
  assert(baseline.materialized.includes('src/a.txt'), 'inside-scope deletion retains its explicit baseline');
  assert(!baseline.materialized.includes('bin/run'), 'omitted paths are not deleted');
  await assert.rejects(checkoutHostedLane(s.root, s.request({ paths: ['bin'] }), s.transport), {
    code: 'WORK_CONFLICT',
  });
  assert.equal(existsSync(join(s.root, 'src/a.txt')), false);
  writeFileSync(join(s.root, 'src/a.txt'), 'first\n');
  await checkoutHostedLane(s.root, s.request(), s.transport);
  assert.equal(readHostedLaneCheckout(s.root).scope, null);
  assert.equal(readHostedLaneCheckout(s.root).materialized.length, 5);
});
test('empty sparse checkout and later new files preserve full baseline and prior directory scope', async t => {
  const s = setup(t);
  await checkoutHostedLane(s.root, s.request({ paths: [] }), s.transport);
  assert.equal(s.calls.downloads.length, 1);
  await checkoutHostedLane(s.root, s.request({ paths: ['src'] }), s.transport);
  const next = [...s.files, { path: 'src/new.txt', blob: s.put('new'), mode: 'file' }];
  s.advance(next);
  await checkoutHostedLane(s.root, s.request({ paths: ['binary.dat'] }), s.transport);
  assert.equal(readFileSync(join(s.root, 'src/new.txt'), 'utf8'), 'new');
  assert.equal(readHostedLaneCheckout(s.root).state.files.length, 6);
});
test('sparse pull updates only selected source objects; unchanged pull transfers none', async t => {
  const s = setup(t);
  await checkoutHostedLane(s.root, s.request({ paths: ['src'] }), s.transport);
  const next = s.files.map(file => (file.path === 'binary.dat' ? { ...file, blob: s.put('outside') } : file));
  s.advance(next);
  const changed = await checkoutHostedLane(s.root, s.request({ paths: [] }), s.transport);
  assert.equal(changed.downloadedObjects, 1, 'only the new full manifest');
  assert.equal(existsSync(join(s.root, 'binary.dat')), false);
  assert.deepEqual(readHostedLaneCheckout(s.root).state.files, next);
  const calls = s.calls.objects.length;
  const warm = await checkoutHostedLane(s.root, s.request({ paths: [] }), s.transport);
  assert.equal(warm.downloadedObjects, 0);
  assert.equal(s.calls.objects.length, calls);
});
test('dirty contents, mode changes, symlink retargets, deletions and outside-scope edits retain bytes', async t => {
  for (const change of ['contents', 'mode', 'link', 'delete', 'outside']) {
    const s = setup(t);
    await checkoutHostedLane(s.root, s.request(), s.transport);
    if (change === 'contents') writeFileSync(join(s.root, 'src/a.txt'), 'local edit');
    if (change === 'mode') chmodSync(join(s.root, 'bin/run'), 0o644);
    if (change === 'link') {
      rmSync(join(s.root, 'link'));
      symlinkSync('../external-target', join(s.root, 'link'));
    }
    if (change === 'delete') rmSync(join(s.root, 'src/a.txt'));
    if (change === 'outside') writeFileSync(join(s.root, 'untracked.txt'), 'outside');
    await assert.rejects(checkoutHostedLane(s.root, s.request(), s.transport), { code: 'WORK_CONFLICT' });
    if (change === 'contents') assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'local edit');
    if (change === 'mode') assert.equal(lstatSync(join(s.root, 'bin/run')).mode & 0o111, 0);
    if (change === 'link') assert.equal(readlinkSync(join(s.root, 'link')), '../external-target');
    if (change === 'delete') assert.equal(existsSync(join(s.root, 'src/a.txt')), false);
    if (change === 'outside') assert.equal(readFileSync(join(s.root, 'untracked.txt'), 'utf8'), 'outside');
  }
});
test('lost download reply preserves existing checkout, resumes pinned selection and rejects changed retry', async t => {
  const s = setup(t),
    request = s.request();
  await checkoutHostedLane(s.root, s.request(), s.transport);
  const oldMarker = readFileSync(join(s.root, '.forge/hosted-lane.json'));
  s.advance(s.files.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('second') } : file)));
  const download = s.transport.downloadToFile;
  s.transport.downloadToFile = async (pin, path) => {
    await download(pin, path);
    if (pin.sha256 !== s.selection().head) throw Error('lost response');
  };
  await assert.rejects(checkoutHostedLane(s.root, request, s.transport), /lost response/);
  assert.deepEqual(readFileSync(join(s.root, '.forge/hosted-lane.json')), oldMarker);
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'first\n');
  s.transport.downloadToFile = download;
  const pinned = s.selection().head;
  s.advance(s.files);
  const resumed = await checkoutHostedLane(s.root, request, s.transport);
  assert.equal(resumed.head, pinned);
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'second');
  await assert.rejects(checkoutHostedLane(s.root, { ...request, paths: ['src'] }, s.transport), {
    code: 'WORK_OPERATION_CHANGED',
  });
});
test('interrupted pre-install and post-install renames reconcile without losing original bytes', async t => {
  for (const phase of ['before-install', 'after-install']) {
    const s = setup(t);
    await checkoutHostedLane(s.root, s.request(), s.transport);
    const originalCopy = join(s.directory, 'original-copy');
    cpSync(s.root, originalCopy, { recursive: true, verbatimSymlinks: true });
    s.advance(
      s.files.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('new selection') } : file)),
    );
    const request = s.request();
    await checkoutHostedLane(s.root, request, s.transport);
    const cache = `${s.root}.forge-client`,
      receiptPath = join(cache, `${request.operationId}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath));
    receipt.complete = false;
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    if (phase === 'before-install') rmSync(s.root, { recursive: true });
    renameSync(originalCopy, join(cache, 'previous'));
    const result = await checkoutHostedLane(s.root, request, s.transport);
    assert.equal(result.downloadedObjects, 0);
    assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'new selection');
    assert.equal(JSON.parse(readFileSync(receiptPath)).complete, true);
    assert.equal(existsSync(join(cache, 'previous')), false);
  }
});
test('edits made while new source downloads survive the final install check', async t => {
  const s = setup(t);
  await checkoutHostedLane(s.root, s.request(), s.transport);
  s.advance(
    s.files.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('remote update') } : file)),
  );
  const download = s.transport.downloadToFile;
  s.transport.downloadToFile = async (...args) => {
    await download(...args);
    writeFileSync(join(s.root, 'src/a.txt'), 'edit during download');
  };
  await assert.rejects(checkoutHostedLane(s.root, s.request(), s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'edit during download');
});
test('an interrupted older checkout cannot overwrite a newer checkout; completed replay never rewinds', async t => {
  const s = setup(t),
    request = s.request();
  const download = s.transport.downloadToFile;
  s.transport.downloadToFile = async (pin, path) => {
    if (pin.sha256 !== s.selection().head) throw Error('interrupted');
    await download(pin, path);
  };
  await assert.rejects(checkoutHostedLane(s.root, request, s.transport), /interrupted/);
  s.transport.downloadToFile = download;
  s.advance(s.files.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('newer') } : file)));
  const newer = s.request();
  await checkoutHostedLane(s.root, newer, s.transport);
  await assert.rejects(checkoutHostedLane(s.root, request, s.transport), { code: 'WORK_STALE' });
  writeFileSync(join(s.root, 'src/a.txt'), 'dirty newer');
  assert.equal((await checkoutHostedLane(s.root, newer, s.transport)).replayed, true);
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'dirty newer');
});
test('verified cache repairs corrupt bytes; malformed downloads never install', async t => {
  const s = setup(t);
  await checkoutHostedLane(s.root, s.request(), s.transport);
  // Unchanged files never need their cached object; a corrupt one is repaired when it is installed.
  const first = s.files;
  s.advance(first.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('second') } : file)));
  await checkoutHostedLane(s.root, s.request(), s.transport);
  writeFileSync(join(`${s.root}.forge-client`, 'objects', first[0].blob), 'corrupt', { mode: 0o600 });
  s.advance(first);
  assert.equal((await checkoutHostedLane(s.root, s.request(), s.transport)).downloadedObjects, 1);
  assert.equal(readFileSync(join(s.root, 'src/a.txt'), 'utf8'), 'first\n');
  const bad = setup(t);
  bad.transport.downloadToFile = async (_, path) => writeFileSync(path, 'corrupt', { mode: 0o600 });
  await assert.rejects(checkoutHostedLane(bad.root, bad.request(), bad.transport), {
    code: 'INVALID_NATIVE_SOURCE',
  });
  assert.equal(existsSync(bad.root), false);
  assert(!readdirSync(`${bad.root}.forge-client`).some(name => name.startsWith('download-')));
});
test('fresh access checks apply to cache hits, completed retries and revocation during transfer', async t => {
  const s = setup(t),
    request = s.request();
  await checkoutHostedLane(s.root, request, s.transport);
  s.revoke();
  await assert.rejects(checkoutHostedLane(s.root, request, s.transport), /revoked/);
  await assert.rejects(checkoutHostedLane(s.root, s.request(), s.transport), /revoked/);
  const bad = setup(t),
    download = bad.transport.downloadToFile;
  bad.transport.downloadToFile = async (...args) => {
    await download(...args);
    bad.revoke();
  };
  await assert.rejects(checkoutHostedLane(bad.root, bad.request(), bad.transport), /revoked/);
  assert.equal(existsSync(bad.root), false);
});
test('wrong project/Lane, stale source pins, deployment switches and unsafe sparse paths fail explicitly', async t => {
  const s = setup(t);
  await assert.rejects(checkoutHostedLane(s.root, s.request({ projectId: 'other' }), s.transport), {
    code: 'PROJECT_UNAVAILABLE',
  });
  await assert.rejects(checkoutHostedLane(s.root, s.request({ laneId: randomUUID() }), s.transport), {
    code: 'PROJECT_UNAVAILABLE',
  });
  await assert.rejects(
    checkoutHostedLane(
      s.root,
      s.request({ expected: { head: s.selection().head, version: 1, sourceVersion: 0 } }),
      s.transport,
    ),
    { code: 'WORK_STALE' },
  );
  await assert.rejects(checkoutHostedLane(s.root, s.request({ paths: ['../escape'] }), s.transport));
  await checkoutHostedLane(s.root, s.request(), s.transport);
  await assert.rejects(checkoutHostedLane(s.root, s.request({ url: 'https://other.invalid' }), s.transport), {
    code: 'PROJECT_UNAVAILABLE',
  });
});
test('redirected root, metadata and cache paths cannot overwrite their targets', async t => {
  for (const kind of ['root', 'metadata', 'cache']) {
    const s = setup(t),
      target = join(s.directory, 'external');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'keep');
    if (kind === 'root') symlinkSync(target, s.root);
    if (kind === 'cache') symlinkSync(target, `${s.root}.forge-client`);
    if (kind === 'metadata') {
      mkdirSync(s.root);
      symlinkSync(target, join(s.root, '.forge'));
    }
    await assert.rejects(checkoutHostedLane(s.root, s.request(), s.transport));
    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'keep');
  }
});

test('checkout tree fields preserve preflight across equivalent States and refuse changed source without extra transport calls', async t => {
  const s = setup(t);
  const files = [
    ...s.files,
    {
      path: 'tests/preflight.test.mjs',
      blob: s.put("import test from 'node:test'; test('passes', () => {});"),
      mode: 'file',
    },
  ];
  s.advance(files);
  await checkoutHostedLane(s.root, s.request(), s.transport);
  const first = readHostedLaneCheckout(s.root);
  const advice = {
    unacknowledgedOverlaps: { items: [] },
    changedPaths: { paths: ['tests/preflight.test.mjs'], complete: true },
  };
  runPreflight(
    s.root,
    first.selection.laneId,
    first.selection.head,
    preflightPlan(s.root, advice.changedPaths),
    first.tree,
  );
  // Manifest ordering changes the State/head, but not source content.
  s.advance([...files].reverse());
  await checkoutHostedLane(s.root, s.request(), s.transport);
  const same = readHostedLaneCheckout(s.root);
  assert.notEqual(first.selection.head, same.selection.head);
  assert.equal(first.tree, same.tree);
  const calls = structuredClone(s.calls);
  assert.equal(
    finishGates(s.root, effectiveAgentDefaults(), { ...same.selection, tree: same.tree }, advice).preflight
      .status,
    'passed',
  );
  assert.deepEqual(s.calls, calls);
  s.advance(
    files.map(file => (file.path === 'src/a.txt' ? { ...file, blob: s.put('changed source') } : file)),
  );
  await checkoutHostedLane(s.root, s.request(), s.transport);
  const changed = readHostedLaneCheckout(s.root);
  assert.notEqual(changed.tree, first.tree);
  const after = structuredClone(s.calls);
  assert.throws(
    () => finishGates(s.root, effectiveAgentDefaults(), { ...changed.selection, tree: changed.tree }, advice),
    error => error.code === 'PREFLIGHT_REQUIRED',
  );
  assert.deepEqual(s.calls, after);
});
