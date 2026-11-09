// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject, cloneFreshness, mainCheckoutTransport } from '../dist/hosted-pull.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { lockfileState, staleDependenciesNotice } from '../dist/stale-dependencies.js';
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

test('pull names a changed lockfile with stale folder deps in one line, installs nothing (friction 1c45066e)', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-stale-deps-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = packages => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
  const write = (name, text) => {
    fs.mkdirSync(join(root, name, '..'), { recursive: true });
    fs.writeFileSync(join(root, name), text);
  };
  write('package.json', '{"name":"synthetic"}');
  write('package-lock.json', lock({ 'node_modules/a': { version: '1.0.0' } }));
  const before = lockfileState(root).digest;
  assert.equal(staleDependenciesNotice(root, before), null, 'lockfile unchanged');
  // The pull brought a package; no node_modules means nothing to be stale.
  write(
    'package-lock.json',
    lock({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/@lezer/go': { version: '1.0.1' } }),
  );
  assert.equal(staleDependenciesNotice(root, before), null, 'no node_modules');
  // A real node_modules from the old lockfile: one line, the command, no install.
  write('node_modules/.package-lock.json', lock({ 'node_modules/a': { version: '1.0.0' } }));
  const line = staleDependenciesNotice(root, before);
  assert.match(
    line,
    /^package-lock\.json changed and node_modules is out of date; run: cd '.+' && npm ci --ignore-scripts {2}\(pull does not install\)\n$/,
  );
  assert.equal(line.trim().split('\n').length, 1);
  assert.equal(fs.existsSync(join(root, 'node_modules', '@lezer')), false, 'pull never installs');
  // Already installed at the locked versions (optional platform packages may be absent): silent.
  write(
    'package-lock.json',
    lock({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/@x/mac': { version: '2.0.0', optional: true, os: ['darwin'] },
    }),
  );
  write('node_modules/.package-lock.json', lock({ 'node_modules/a': { version: '1.0.0' } }));
  assert.equal(staleDependenciesNotice(root, before), null, 'install already matches the lockfile');
  // A changed version is stale; a missing hidden lockfile cannot be trusted.
  write('node_modules/.package-lock.json', lock({ 'node_modules/a': { version: '0.9.0' } }));
  assert.match(staleDependenciesNotice(root, before), /npm ci/);
  fs.rmSync(join(root, 'node_modules', '.package-lock.json'));
  assert.match(staleDependenciesNotice(root, before), /npm ci/);
  // A Forge link to a shared install is followed by the agent actions, not reported here.
  fs.rmSync(join(root, 'node_modules'), { recursive: true });
  const shared = join(root, '..', `${root.split('/').at(-1)}-shared`);
  fs.mkdirSync(shared);
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  fs.symlinkSync(shared, join(root, 'node_modules'));
  assert.equal(staleDependenciesNotice(root, before), null, 'symlinked node_modules');
});

test('pull names the declared manager’s install command for a changed lockfile', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-stale-deps-pnpm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(join(root, 'package.json'), '{"name":"synthetic","packageManager":"pnpm@9.0.0"}');
  fs.writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.mkdirSync(join(root, 'node_modules'));
  const before = lockfileState(root).digest;
  fs.writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# changed\n');
  assert.match(
    staleDependenciesNotice(root, before),
    /^pnpm-lock\.yaml changed .*pnpm install --frozen-lockfile --ignore-scripts/,
  );
});

// Git parity (Issue 99574435): pull leaves untracked files alone unless an incoming path meets them.
const stat = path => {
  const s = fs.lstatSync(path);
  return { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
};
test('an untracked file or folder that no incoming change touches does not block pull and is left untouched', async t => {
  const f = pullFixture(t);
  fs.mkdirSync(join(f.root, '.claude'));
  fs.writeFileSync(join(f.root, '.claude/scheduled_tasks.lock'), 'tool lock');
  fs.writeFileSync(join(f.root, '.DS_Store'), 'finder');
  fs.mkdirSync(join(f.root, 'src/scratch'), { recursive: true });
  fs.writeFileSync(join(f.root, 'src/scratch/notes.txt'), 'draft');
  fs.mkdirSync(join(f.root, 'empty-untracked'));
  fs.symlinkSync('missing-target', join(f.root, 'dangling'));
  const kept = ['.claude/scheduled_tasks.lock', '.DS_Store', 'src/scratch/notes.txt'];
  const before = kept.map(path => stat(join(f.root, path)));
  f.select([
    ['src/0.txt', 'incoming'],
    ['src/new.txt', 'added'],
  ]);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'incoming');
  assert.equal(fs.readFileSync(join(f.root, 'src/new.txt'), 'utf8'), 'added');
  assert.deepEqual(
    kept.map(path => stat(join(f.root, path))),
    before,
  );
  assert.equal(fs.readFileSync(join(f.root, '.claude/scheduled_tasks.lock'), 'utf8'), 'tool lock');
  assert.ok(fs.lstatSync(join(f.root, 'empty-untracked')).isDirectory());
  assert.equal(fs.readlinkSync(join(f.root, 'dangling')), 'missing-target');
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  // A later pull with nothing new is still one query and clean.
  f.reset();
  await pull(f);
  assert.equal(f.calls.queries, 1);
  // A tracked-file edit still refuses beside the untracked file, which stays put.
  f.select([['src/1.txt', 'next']]);
  fs.writeFileSync(join(f.root, 'src/2.txt'), 'local');
  await assert.rejects(
    pull(f),
    e => e.code === 'WORK_CONFLICT' && e.recovery.obstruction.kind === 'source-edit',
  );
  assert.equal(fs.readFileSync(join(f.root, '.claude/scheduled_tasks.lock'), 'utf8'), 'tool lock');
});
test('an untracked file at a path main now adds still refuses with the preserve message', async t => {
  const f = pullFixture(t);
  fs.writeFileSync(join(f.root, 'unrelated.tmp'), 'stays');
  fs.writeFileSync(join(f.root, 'src/new.txt'), 'local draft');
  f.select([['src/new.txt', 'incoming']]);
  await assert.rejects(
    pull(f),
    e =>
      e.code === 'WORK_CONFLICT' &&
      /Local checkout changes at "src\/new.txt" are preserved/.test(e.message) &&
      e.recovery.obstruction.kind === 'extra-source' &&
      e.recovery.obstruction.path === 'src/new.txt',
  );
  assert.equal(fs.readFileSync(join(f.root, 'src/new.txt'), 'utf8'), 'local draft');
  assert.equal(fs.readFileSync(join(f.root, 'unrelated.tmp'), 'utf8'), 'stays');
  // Identical bytes at the incoming path are not a conflict.
  fs.writeFileSync(join(f.root, 'src/new.txt'), 'incoming');
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'unrelated.tmp'), 'utf8'), 'stays');
});
test('untracked file versus incoming directory, and untracked folder versus incoming file, refuse', async t => {
  const f = pullFixture(t);
  fs.writeFileSync(join(f.root, 'lib'), 'a file where a folder arrives');
  fs.mkdirSync(join(f.root, 'docs'));
  fs.writeFileSync(join(f.root, 'docs/mine.md'), 'mine');
  f.select([['lib/a.txt', 'incoming']]);
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  f.select([['docs', 'a file where a folder is']]);
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  assert.equal(fs.readFileSync(join(f.root, 'lib'), 'utf8'), 'a file where a folder arrives');
  assert.equal(fs.readFileSync(join(f.root, 'docs/mine.md'), 'utf8'), 'mine');
});
test('an untracked spelling that meets an incoming path on a case-insensitive disk refuses; a sibling does not', async t => {
  const f = pullFixture(t);
  const probe = join(f.directory, 'CaseProbe');
  fs.writeFileSync(probe, '');
  const insensitive = fs.existsSync(join(f.directory, 'caseprobe'));
  fs.writeFileSync(join(f.root, 'README.TXT'), 'local');
  fs.writeFileSync(join(f.root, 'README.bak'), 'sibling');
  f.select([['readme.txt', 'incoming']]);
  if (insensitive) {
    await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
    assert.equal(fs.readFileSync(join(f.root, 'README.TXT'), 'utf8'), 'local');
  } else {
    await pull(f);
    assert.equal(fs.readFileSync(join(f.root, 'README.TXT'), 'utf8'), 'local');
    assert.equal(fs.readFileSync(join(f.root, 'readme.txt'), 'utf8'), 'incoming');
  }
  assert.equal(fs.readFileSync(join(f.root, 'README.bak'), 'utf8'), 'sibling');
});
test('paths .gitignore and .forgeignore exclude never block pull', async t => {
  const f = pullFixture(t, 3, [
    ['.gitignore', '*.log\n/build/\n'],
    ['.forgeignore', '/scratch/\n'],
  ]);
  fs.writeFileSync(join(f.root, 'debug.log'), 'ignored by git rules');
  fs.mkdirSync(join(f.root, 'build'));
  fs.writeFileSync(join(f.root, 'build/out.js'), 'output');
  fs.mkdirSync(join(f.root, 'scratch'));
  fs.writeFileSync(join(f.root, 'scratch/n.txt'), 'forge rules');
  f.select([['src/0.txt', 'incoming']]);
  await pull(f);
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'incoming');
  for (const path of ['debug.log', 'build/out.js', 'scratch/n.txt'])
    assert.ok(fs.existsSync(join(f.root, path)), path);
});
