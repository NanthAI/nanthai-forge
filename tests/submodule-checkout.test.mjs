// SPDX-License-Identifier: Apache-2.0
// Clones, pulls and Lane checkouts hold a submodule as a real checkout of its pinned commit;
// every scanner treats it as one opaque leaf whose pointer is its HEAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject } from '../dist/hosted-pull.js';
import { readHostedMainMarker } from '../dist/hosted-main-marker.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { scanCheckout } from '../dist/hosted-agent-finish-identity.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { scanSourcePaths } from '../dist/source-paths.js';
import { nativeFile } from '../dist/native-file.js';
import { digest } from '../dist/hash.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();

function temporary(t, prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}
/** A synthetic upstream with two commits; local file URLs are allowed only in tests. */
function upstream(t) {
  const root = temporary(t, 'forge-submodule-upstream-'),
    path = join(root, 'lib');
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'lib.c'), 'int v1;\n');
  mkdirSync(join(path, 'src'));
  writeFileSync(join(path, 'src', 'deep.c'), 'int deep;\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'one');
  const first = git(path, 'rev-parse', 'HEAD');
  writeFileSync(join(path, 'lib.c'), 'int v2;\n');
  git(path, 'commit', '-q', '-am', 'two');
  const second = git(path, 'rev-parse', 'HEAD');
  git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { url: pathToFileURL(path).href, path, first, second };
}
function submoduleEnvironment(t) {
  const cache = temporary(t, 'forge-submodule-cache-');
  const saved = {
    files: process.env.FORGE_TEST_SUBMODULE_FILE_URLS,
    cache: process.env.FORGE_SUBMODULE_CACHE,
  };
  process.env.FORGE_TEST_SUBMODULE_FILE_URLS = '1';
  process.env.FORGE_SUBMODULE_CACHE = cache;
  t.after(() => {
    for (const [name, value] of [
      ['FORGE_TEST_SUBMODULE_FILE_URLS', saved.files],
      ['FORGE_SUBMODULE_CACHE', saved.cache],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  return cache;
}
const modules = url => `[submodule "lib"]\n\tpath = vendor/lib\n\turl = ${url}\n`;

test('a clone checks out the pinned submodule tree, reports no added files and follows a pulled bump', async t => {
  const lib = upstream(t),
    cache = submoduleEnvironment(t),
    f = pullFixture(t);
  f.select([
    ['.gitmodules', modules(lib.url)],
    ['vendor/lib', lib.first, 'gitlink'],
  ]);
  const pull = () => pullHostedProject(f.root, f.address, f.transport);
  const first = await pull();
  const sub = join(f.root, 'vendor/lib');
  assert(lstatSync(sub).isDirectory(), 'the gitlink path is a directory');
  assert.equal(readFileSync(join(sub, 'lib.c'), 'utf8'), 'int v1;\n');
  assert.equal(readFileSync(join(sub, 'src/deep.c'), 'utf8'), 'int deep;\n');
  assert.equal(git(sub, 'rev-parse', 'HEAD'), lib.first);
  assert.equal(git(sub, 'status', '--porcelain'), '', 'the submodule index matches its tree');
  assert.deepEqual(first.submodules?.materialized, ['vendor/lib']);
  // Objects live once in the shared cache; the checkout borrows them.
  assert.match(readFileSync(join(sub, '.git/objects/info/alternates'), 'utf8'), new RegExp(cache));
  const marker = readHostedMainMarker(f.root);
  const paths = scanSourcePaths(f.root, { retained: marker.state.files.map(file => file.path) });
  assert(paths.includes('vendor/lib'));
  assert(!paths.some(path => path.startsWith('vendor/lib/')), 'submodule files are never source');
  assert.deepEqual(nativeFile(f.root, 'vendor/lib'), { bytes: Buffer.from(lib.first), mode: 'gitlink' });

  // An unchanged pull keeps the checkout in place, including untracked work inside it.
  writeFileSync(join(sub, 'notes.txt'), 'local notes\n');
  const inode = lstatSync(sub).ino;
  await pull();
  assert.equal(lstatSync(sub).ino, inode);
  assert.equal(readFileSync(join(sub, 'notes.txt'), 'utf8'), 'local notes\n');

  // main bumps the pointer: the same checkout moves to the new commit.
  f.select([['vendor/lib', lib.second, 'gitlink']]);
  const bumped = await pull();
  assert.equal(bumped.submodules, undefined, 'a restored checkout is not reported');
  assert.equal(lstatSync(sub).ino, inode);
  assert.equal(git(sub, 'rev-parse', 'HEAD'), lib.second);
  assert.equal(readFileSync(join(sub, 'lib.c'), 'utf8'), 'int v2;\n');
  assert.equal(readFileSync(join(sub, 'notes.txt'), 'utf8'), 'local notes\n');
  assert.deepEqual(readdirSync(join(clientCacheRoot(f.root), 'submodules')), [], 'nothing left parked');

  // A bump that would overwrite local edits inside the submodule keeps them, outside the tree.
  writeFileSync(join(sub, 'lib.c'), 'int mine;\n');
  f.select([['vendor/lib', lib.first, 'gitlink']]);
  const blocked = await pull();
  assert.equal(readFileSync(sub, 'utf8'), lib.first, 'the pointer file names the pulled commit');
  const [kept] = blocked.submodules.kept;
  assert.equal(kept.path, 'vendor/lib');
  assert.equal(readFileSync(join(kept.at, 'lib.c'), 'utf8'), 'int mine;\n');
  assert.match(blocked.submodules.notice, /Commit or stash there/);
});

test('an unsupported submodule URL stays a pointer file with a clear refusal', async t => {
  submoduleEnvironment(t);
  const f = pullFixture(t),
    commit = 'c'.repeat(40);
  f.select([
    ['.gitmodules', modules('git@gitlab.example:team/private.git')],
    ['vendor/lib', commit, 'gitlink'],
  ]);
  const result = await pullHostedProject(f.root, f.address, f.transport);
  assert.equal(readFileSync(join(f.root, 'vendor/lib'), 'utf8'), commit);
  assert.deepEqual(
    result.submodules.refused.map(item => [item.path, item.reason]),
    [['vendor/lib', 'url-unsupported']],
  );
  assert.match(result.submodules.notice, /private submodules are not fetched/);
  assert.match(result.submodules.notice, /Edit a pointer file/);
});

function laneMarker(root, files, objects) {
  const put = text => {
    const bytes = Buffer.from(text),
      blob = digest(bytes);
    objects.set(blob, bytes);
    return blob;
  };
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'synthetic',
    at: '2026-01-01T00:00:00Z',
  };
  const head = put(JSON.stringify(state));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: 'project',
        laneId: randomUUID(),
        intentId: randomUUID(),
        head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state,
      scope: null,
      materialized: files.map(file => file.path),
    }),
  );
}

test('Lane status and save see a checked-out submodule as its pointer; a HEAD bump saves a gitlink change', async t => {
  const lib = upstream(t),
    base = temporary(t, 'forge-submodule-lane-'),
    root = join(base, 'checkout'),
    objects = new Map();
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(base, 'clone', '-q', lib.path, join(root, 'vendor'));
  git(join(root, 'vendor'), 'checkout', '-q', '--detach', lib.first);
  const files = [
    { path: 'a.txt', blob: digest(Buffer.from('a\n')), mode: 'file' },
    { path: 'vendor', blob: digest(Buffer.from(lib.first)), mode: 'gitlink' },
  ];
  laneMarker(root, files, objects);
  const clean = await captureHostedSave(root, join(base, 'clean'));
  assert.deepEqual(clean.changes, [], 'no added submodule files and no pointer change');
  assert.equal(hostedLaneDirty(root), false);
  const marker = JSON.parse(readFileSync(join(root, '.forge/hosted-lane.json'), 'utf8'));
  assert.deepEqual(scanCheckout(root, marker).changed, []);

  git(join(root, 'vendor'), 'checkout', '-q', '--detach', lib.second);
  assert.equal(hostedLaneDirty(root), true);
  const bumped = await captureHostedSave(root, join(base, 'bumped'));
  assert.equal(bumped.changes.length, 1);
  const [change] = bumped.changes;
  assert.equal(change.path, 'vendor');
  assert.deepEqual(change.before, { blob: files[1].blob, mode: 'gitlink' });
  assert.equal(change.after.mode, 'gitlink');
  // Exactly the pointer bytes an import stores, so the mirror writes a 160000 entry for it.
  assert.equal(readFileSync(join(base, 'bumped', change.after.blob), 'utf8'), lib.second);
  assert.deepEqual(scanCheckout(root, marker).changed, ['vendor']);

  git(join(root, 'vendor'), 'checkout', '-q', 'main');
  await assert.rejects(captureHostedSave(root, join(base, 'branch')), error => {
    assert.equal(error.code, 'SUBMODULE_HEAD_SYMBOLIC');
    assert.match(error.message, /git -C vendor checkout --detach/);
    return true;
  });
});

test('a Lane checkout materializes submodules and keeps one across a sync that changes other files', async t => {
  const lib = upstream(t);
  submoduleEnvironment(t);
  const directory = temporary(t, 'forge-submodule-lane-checkout-'),
    root = join(directory, 'client'),
    objects = new Map();
  const put = value => {
    const bytes = Buffer.from(value),
      id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  const files = [
    { path: '.gitmodules', blob: put(modules(lib.url)), mode: 'file' },
    { path: 'readme', blob: put('one\n'), mode: 'file' },
    { path: 'vendor/lib', blob: put(lib.first), mode: 'gitlink' },
  ];
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
  const transport = {
    select: async () => structuredClone(selection),
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 }),
  };
  const request = extra => ({
    url: 'https://fixture.invalid',
    projectId: 'project',
    laneId: selection.laneId,
    operationId: randomUUID(),
    ...extra,
  });
  const opened = await checkoutHostedLane(root, request(), transport);
  assert.deepEqual(opened.submodules.materialized, ['vendor/lib']);
  const sub = join(root, 'vendor/lib');
  assert.equal(readFileSync(join(sub, 'lib.c'), 'utf8'), 'int v1;\n');
  assert.equal(hostedLaneDirty(root), false);
  writeFileSync(join(sub, 'lib.c'), 'int edited;\n');
  const previous = {
    head: selection.head,
    version: selection.version,
    sourceVersion: selection.sourceVersion,
  };
  selection = {
    ...selection,
    head: state(files.map(file => (file.path === 'readme' ? { ...file, blob: put('two\n') } : file))),
    version: 1,
    sourceVersion: 1,
  };
  const synced = await checkoutHostedLane(root, request({ previous }), transport);
  assert.equal(synced.submodules, undefined);
  assert.equal(readFileSync(join(root, 'readme'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(sub, 'lib.c'), 'utf8'), 'int edited;\n', 'unsaved submodule work stays');
  assert.equal(git(sub, 'rev-parse', 'HEAD'), lib.first);
  assert.equal(hostedLaneDirty(root), false, 'files inside a submodule are not Lane source');
});
