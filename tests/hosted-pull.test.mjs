// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject, cloneFreshness, mainCheckoutTransport } from '../dist/hosted-pull.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { readHostedMainMarker } from '../dist/hosted-main-marker.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { getFunctionName } from 'convex/server';
const pull = f => pullHostedProject(f.root, f.address, f.transport);

test('no change is exactly one query, zero bytes, no idle calls; edits refuse even when current', async t => {
  const f = pullFixture(t);
  assert.equal((await pull(f)).downloadedObjects, 0);
  assert.equal(f.calls.queries, 1);
  assert.deepEqual(f.calls.pages, []);
  assert.deepEqual(f.calls.gets, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.queries, 1);
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'local');
  await assert.rejects(
    pull(f),
    e => e.code === 'WORK_CONFLICT' && /Move your local edits into a Lane/.test(e.message),
  );
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'local');
});
test('several accepted revisions refresh only changed bytes, reuse root/cache, and update status', async t => {
  const f = pullFixture(t);
  f.select([['src/0.txt', 'second']]);
  f.select([['src/1.txt', 'third']]);
  f.select([['new', 'fourth']]);
  const status = await cloneFreshness(f.root, f.transport);
  assert.equal(status.clone.status, 'behind');
  assert.equal(status.clone.sourceRevisionsBehind, 3);
  f.reset();
  const result = await pull(f);
  assert.equal(result.downloadedObjects, 4); // final manifest and three changed blobs, no history
  assert.equal(f.calls.queries, 2);
  assert.equal(f.calls.pages.length, 2);
  assert.equal(f.calls.pack, 0);
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  assert.equal((await cloneFreshness(f.root, f.transport)).clone.status, 'current');
  f.reset();
  await pull(f);
  assert.equal(f.calls.queries, 1);
  assert.equal(f.calls.gets.length, 0);
});
test('refresh stages only changed files, including modes and renamed reused bytes', async t => {
  const f = pullFixture(t, 100);
  const unchanged = fs.statSync(join(f.root, 'src/99.txt')).ino;
  f.select([
    ['src/0.txt', 'changed'],
    ['src/1.txt', 'source 1\n', 'executable'],
    ['src/2.txt', null],
    ['moved.txt', 'source 2\n'],
  ]);
  let staged;
  f.onCurrent(() => {
    if (f.calls.queries !== 2) return;
    const cache = clientCacheRoot(f.root);
    const stage = join(
      cache,
      fs.readdirSync(cache).find(name => name.startsWith('delta-') && !name.endsWith('-displaced')),
    );
    staged = fs
      .readdirSync(stage, { recursive: true })
      .filter(path => {
        return !path.startsWith('.forge') && !fs.lstatSync(join(stage, path)).isDirectory();
      })
      .sort();
  });
  await pull(f);
  assert.deepEqual(staged, ['moved.txt', 'src/0.txt', 'src/1.txt']);
  assert.equal(f.calls.gets.length, 2); // Manifest and changed bytes only, even with an empty blob cache.
  assert.equal(fs.statSync(join(f.root, 'src/99.txt')).ino, unchanged);
  assert.equal(fs.readFileSync(join(f.root, 'moved.txt'), 'utf8'), 'source 2\n');
  assert(fs.statSync(join(f.root, 'src/1.txt')).mode & 0o111);
});
test('tracked deletes/modes refuse; ignored outputs, dependency links and nested Lane cache survive', async t => {
  // Build output is preserved because the project ignores it; Forge never drops a folder by name.
  const f = pullFixture(t, 3, [['.gitignore', '/dist/\n']]);
  fs.mkdirSync(join(f.root, 'dist'));
  fs.writeFileSync(join(f.root, 'dist/app.js'), 'output');
  fs.symlinkSync('../dependencies', join(f.root, 'node_modules'));
  fs.mkdirSync(join(clientCacheRoot(f.root), 'lanes/lane'), { recursive: true });
  fs.writeFileSync(join(clientCacheRoot(f.root), 'lanes/lane/draft'), 'draft');
  f.select([['src/0.txt', 'new']]);
  fs.unlinkSync(join(f.root, 'src/1.txt'));
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  fs.writeFileSync(join(f.root, 'src/1.txt'), 'source 1\n');
  fs.chmodSync(join(f.root, 'src/1.txt'), 0o755);
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  fs.chmodSync(join(f.root, 'src/1.txt'), 0o644);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'dist/app.js'), 'utf8'), 'output');
  assert.equal(fs.readlinkSync(join(f.root, 'node_modules')), '../dependencies');
  assert.equal(fs.readFileSync(join(clientCacheRoot(f.root), 'lanes/lane/draft'), 'utf8'), 'draft');
});
test('a Forge client-state folder written inside the clone is kept, never a local edit (friction 54d6b3b1)', async t => {
  const f = pullFixture(t);
  // Another project's client state, as a client wrote it under the clone: journals and Spotlight's marker.
  const stray = join(f.root, 'mh70hhyhcyzmywg7fh4pfpd6z98hs4jy.forge-client');
  fs.mkdirSync(join(stray, 'agent'), { recursive: true });
  fs.writeFileSync(join(stray, '.metadata_never_index'), '');
  fs.writeFileSync(join(stray, 'agent', 'auto-synthetic.json'), '{}');
  f.select([['src/0.txt', 'new']]);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(join(stray, 'agent', 'auto-synthetic.json'), 'utf8'), '{}', 'kept as is');
  // A real local edit still refuses.
  f.select([['src/1.txt', 'next']]);
  fs.writeFileSync(join(f.root, 'src/2.txt'), 'local');
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
});
test('ignored incoming collision is refused before publication; source symlinks/executable/add/delete apply', async t => {
  const f = pullFixture(t);
  fs.mkdirSync(join(f.root, 'dist'));
  fs.writeFileSync(join(f.root, 'dist/owned'), 'keep');
  f.select([['dist/owned', 'incoming']]);
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  assert.equal(fs.readFileSync(join(f.root, 'dist/owned'), 'utf8'), 'keep');
  fs.renameSync(join(f.root, 'dist/owned'), join(f.directory, 'kept-artifact'));
  await pull(f);
  f.select([
    ['src/0.txt', null],
    ['bin/run', 'run', 'executable'],
    ['link', 'missing', 'symlink'],
  ]);
  await pull(f);
  assert(!fs.existsSync(join(f.root, 'src/0.txt')));
  assert(fs.statSync(join(f.root, 'bin/run')).mode & 0o111);
  assert.equal(fs.readlinkSync(join(f.root, 'link')), 'missing');
});
test('interrupted transfer resumes pinned head with the same plain command', async t => {
  const f = pullFixture(t);
  f.select([['src/0.txt', 'next']]);
  f.fail(true);
  await assert.rejects(pull(f), /interrupted/);
  const pending = JSON.parse(fs.readFileSync(join(clientCacheRoot(f.root), 'agent/pull.json')));
  const pinned = f.main().head;
  f.select([['src/0.txt', 'later']]);
  f.fail(false);
  const resumed = await pull(f);
  assert.equal(resumed.operationId, pending.operationId);
  assert.equal(resumed.head, pinned);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'next');
  await pull(f);
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
});
const deltaDirectories = f =>
  fs.readdirSync(clientCacheRoot(f.root)).filter(name => name.startsWith('delta-'));
const fromStage = from =>
  /\/delta-[A-Za-z0-9]+\//.test(String(from)) && !String(from).includes('-displaced/');
// An error inside the pull process undoes the clone root at once (people read it between commands);
// the same plain command then applies the pinned head.
for (const point of ['old-file-moved-aside', 'new-file-installed', 'marker-installed', 'journal-removed'])
  test(`failure at ${point} resumes without mixed files or lost artifacts`, async t => {
    const f = pullFixture(t, 3, [['.gitignore', '/dist/\n']]);
    fs.mkdirSync(join(f.root, 'dist'));
    fs.writeFileSync(join(f.root, 'dist/out'), 'keep');
    f.select([
      ['src/0.txt', 'new zero'],
      ['src/1.txt', 'new one'],
    ]);
    const rename = fs.renameSync,
      remove = fs.rmSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      const value = rename(from, to);
      if (
        !injected &&
        ((point === 'old-file-moved-aside' &&
          String(from) === join(f.root, 'src/0.txt') &&
          String(to).includes('-displaced/')) ||
          (point === 'new-file-installed' && fromStage(from) && to === join(f.root, 'src/0.txt')) ||
          (point === 'marker-installed' && to === join(f.root, '.forge/hosted-main.json')))
      ) {
        injected = true;
        throw Error('simulated crash');
      }
      return value;
    };
    fs.rmSync = (path, options) => {
      const value = remove(path, options);
      if (!injected && point === 'journal-removed' && String(path).endsWith('/delta-apply.json')) {
        injected = true;
        throw Error('simulated crash');
      }
      return value;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(pull(f), /simulated crash/);
      assert(injected);
    } finally {
      fs.renameSync = rename;
      fs.rmSync = remove;
      syncBuiltinESMExports();
    }
    const published = ['marker-installed', 'journal-removed'].includes(point);
    assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), published ? 'new zero' : 'source 0\n');
    assert(!fs.existsSync(join(clientCacheRoot(f.root), 'delta-apply.json')));
    await pull(f);
    assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'new zero');
    assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'new one');
    assert.equal(fs.readFileSync(join(f.root, 'dist/out'), 'utf8'), 'keep');
    assert.deepEqual(deltaDirectories(f), []);
  });
test('unauthorized no-op, revoked after transfer, and completed replay all refuse', async t => {
  const f = pullFixture(t);
  f.access(false);
  await assert.rejects(pull(f), { code: 'PROJECT_UNAVAILABLE' });
  assert.equal(f.calls.gets.length, 0);
  f.access(true);
  f.select([['src/0.txt', 'new']]);
  f.reset();
  f.onCurrent(() => {
    if (f.calls.queries === 2) f.access(false);
  });
  await assert.rejects(pull(f), { code: 'PROJECT_UNAVAILABLE' });
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  f.onCurrent(() => {});
  f.access(true);
  const done = await pull(f);
  f.access(false);
  await assert.rejects(pullHostedProject(f.root, f.address, f.transport, done.operationId), {
    code: 'PROJECT_UNAVAILABLE',
  });
});
test('agent pull and root status bypass discovery, use current authority and stay in existing tool', async t => {
  const f = pullFixture(t),
    names = [];
  const exchange = {
    projectId: f.address.projectId,
    client: {
      query: async (ref, args) => {
        names.push(getFunctionName(ref));
        assert.equal(args.projectId, f.address.projectId);
        return JSON.stringify(f.main());
      },
    },
  };
  const agent = new HostedAgentTransport(f.root, f.address, exchange);
  assert.equal((await agent.dispatch('pull', {})).result.downloadedObjects, 0);
  assert.equal((await agent.dispatch('status', {})).result.clone.status, 'current');
  assert.deepEqual(names, ['projectHostedChannels:current', 'projectHostedChannels:current']);
  assert.throws(() => mainCheckoutTransport(f.root, { ...f.address, projectId: 'other' }, exchange), {
    code: 'PROJECT_UNAVAILABLE',
  });
  await assert.rejects(agent.dispatch('pull', { laneId: randomUUID() }), { code: 'BAD_ARGUMENT' });
});

test('an editor changing tracked source while transfer/staging runs is preserved', async t => {
  const f = pullFixture(t);
  f.select([['src/0.txt', 'incoming']]);
  f.onCurrent(() => {
    if (f.calls.queries === 2) fs.writeFileSync(join(f.root, 'src/1.txt'), 'late editor change');
  });
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'late editor change');
});

test('pull then status from the same cwd preserves root and surviving directory inodes', async t => {
  const f = pullFixture(t),
    original = process.cwd();
  const rootInode = fs.statSync(f.root).ino,
    sourceInode = fs.statSync(join(f.root, 'src')).ino;
  f.select([['src/0.txt', 'new cwd-visible bytes']]);
  try {
    process.chdir(f.root);
    await pull(f);
    assert.equal(process.cwd(), f.root);
    assert.equal(fs.readFileSync('src/0.txt', 'utf8'), 'new cwd-visible bytes');
    assert.equal((await cloneFreshness('.', f.transport)).clone.status, 'current');
    assert.equal(fs.statSync('.').ino, rootInode);
    assert.equal(fs.statSync('src').ino, sourceInode);
  } finally {
    process.chdir(original);
  }
});

test('in-place pull handles file/directory transitions and retains unrelated artifacts', async t => {
  const f = pullFixture(t);
  f.select([
    ['src/0.txt', null],
    ['src/0.txt/nested/deep', 'nested'],
  ]);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt/nested/deep'), 'utf8'), 'nested');
  f.select([
    ['src/0.txt/nested/deep', null],
    ['src/0.txt', 'file again'],
  ]);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'file again');
});

test('interrupted per-file publication restores the old tree before validating a replay', async t => {
  const f = pullFixture(t);
  f.select([
    ['src/0.txt', 'first replacement'],
    ['src/1.txt', 'second replacement'],
  ]);
  const rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (from, to) => {
    if (!interrupted && fromStage(from) && String(to) === join(f.root, 'src/1.txt')) {
      interrupted = true;
      throw new Error('synthetic publication interruption');
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(pull(f), /synthetic publication interruption/);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert(interrupted);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'source 1\n');
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'second replacement');
});

test('pull retains concurrent edits observed after moving an old file to backup', async t => {
  const f = pullFixture(t);
  f.select([['src/0.txt', 'accepted next']]);
  const rename = fs.renameSync;
  let edited = false;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (!edited && String(from) === join(f.root, 'src/0.txt') && String(to).includes('-displaced/')) {
      edited = true;
      fs.writeFileSync(to, 'concurrent local edit');
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(pull(f), error => error.code === 'WORK_CONFLICT');
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert(edited);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'concurrent local edit');
});

test('checkout existence treats a descendant of a file as absent', async t => {
  const f = pullFixture(t);
  const { checkoutPathExists } = await import('../dist/hosted-checkout-files.js');
  assert.equal(checkoutPathExists(join(f.root, 'src/0.txt/child')), false);
});

test('interrupted dangling-symlink publication restores its prior link and replays safely', async t => {
  const f = pullFixture(t);
  f.select([['link', 'old-missing-target', 'symlink']]);
  await pull(f);
  f.select([['link', 'new-missing-target', 'symlink']]);
  const rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (from, to) => {
    const value = rename(from, to);
    if (!interrupted && fromStage(from) && String(to) === join(f.root, 'link')) {
      interrupted = true;
      throw Error('synthetic symlink publication interruption');
    }
    return value;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(pull(f), /synthetic symlink publication interruption/);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert(interrupted);
  assert.equal(fs.readlinkSync(join(f.root, 'link')), 'old-missing-target');
  await pull(f);
  assert.equal(fs.readlinkSync(join(f.root, 'link')), 'new-missing-target');
});
