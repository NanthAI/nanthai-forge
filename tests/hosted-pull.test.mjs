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
test('tracked deletes/modes refuse; ignored outputs, dependency links and nested Lane cache survive', async t => {
  const f = pullFixture(t);
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
for (const point of ['old-renamed', 'new-installed', 'artifact-moved', 'backup-removed'])
  test(`crash at ${point} resumes without mixed files or lost artifacts`, async t => {
    const f = pullFixture(t);
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
        ((point === 'old-renamed' && to === join(clientCacheRoot(f.root), 'previous')) ||
          (point === 'new-installed' && to === f.root) ||
          (point === 'artifact-moved' && to === join(f.root, 'dist')))
      ) {
        injected = true;
        throw Error('simulated crash');
      }
      return value;
    };
    fs.rmSync = (path, options) => {
      const value = remove(path, options);
      if (!injected && point === 'backup-removed' && path === join(clientCacheRoot(f.root), 'previous')) {
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
    await pull(f);
    assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'new zero');
    assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'new one');
    assert.equal(fs.readFileSync(join(f.root, 'dist/out'), 'utf8'), 'keep');
    assert(!fs.existsSync(join(clientCacheRoot(f.root), 'previous')));
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
