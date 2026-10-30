// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup } from './publication-fixture.mjs';
import { git, code } from './helpers.mjs';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { importNativeGit, exportNativeGit } from '../dist/native-git.js';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { exportNativeSource, restoreNativeWork } from '../dist/native-backup.js';
import { serveRepository } from '../dist/http.js';

const input = { action: 'import-pr', url: 'https://github.com/tests/example/pull/7' };
async function native(t, { format = 'sha1', pure = false } = {}) {
  const priorHash = process.env.GIT_DEFAULT_HASH;
  process.env.GIT_DEFAULT_HASH = format;
  const f = setup(t);
  if (priorHash === undefined) delete process.env.GIT_DEFAULT_HASH;
  else process.env.GIT_DEFAULT_HASH = priorHash;
  await f.publish();
  const original = git(f.root, ['rev-parse', 'HEAD']).trim(),
    root = join(f.root, '.git/native-owner');
  let imported;
  if (pure) {
    mkdirSync(root);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    imported = initNative(root);
  } else imported = await importNativeGit(f.root, original, root);
  const work = new WorkService(root),
    data = () => work.store.load(),
    act = c => work.execute(c, data().revision).result;
  let base = original;
  if (pure) {
    const projected = await exportNativeGit(root, imported.head, join(f.root, '.git/projected'));
    git(f.remote, ['bundle', 'unbundle', projected.bundle.path]);
    base = projected.commit;
    git(f.remote, ['update-ref', 'refs/heads/main', base]);
  }
  const fork = (tree = f.command.expectedHead, parent = base, message = 'Original fork contribution\n') =>
    execFileSync('git', ['-C', f.remote, 'commit-tree', `${tree}^{tree}`, '-p', parent], {
      input: message,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Original fork author',
        GIT_AUTHOR_EMAIL: 'fork@localhost',
        GIT_COMMITTER_NAME: 'Original fork author',
        GIT_COMMITTER_EMAIL: 'fork@localhost',
      },
    }).trim();
  const update = head => {
    const pulls = f.state().pulls;
    Object.assign(pulls[0].head, { sha: head, repo: { full_name: 'fork/example' } });
    pulls[0].base.sha = base;
    f.change({ pulls });
    git(f.remote, ['update-ref', 'refs/pull/7/head', head]);
  };
  const head = fork();
  update(head);
  const intent = act({ action: 'intent', outcome: 'Review incoming native contribution' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Keep local work' });
  return {
    ...f,
    root,
    original,
    imported,
    work,
    data,
    act,
    intent,
    lane,
    base,
    head,
    fork,
    update,
    call: (c = input, r = data().revision) => work.dispatch(c, r),
  };
}
const pin = (intent, observation = 0, part = 'head') => ({
  kind: 'pr',
  intentId: intent.id,
  observation,
  part,
  head: intent.external.observations[observation][part],
});
const compose = (f, imported, observation = 0) =>
  f.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: f.intent.id,
    inputs: [],
    dependencies: [pin(imported, observation)],
  });
async function waitFor(fn) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Fixture timed out');
}

for (const format of ['sha1', 'sha256'])
  test(
    `native ${format} incoming PR retains original fork bytes/history and composes/checks/accepts through the existing owner`,
    { timeout: 120000 },
    async t => {
      const f = await native(t, { format }),
        path = f.work.store.path(f.lane.id);
      writeFileSync(join(path, 'dirty.ts'), 'Keep dirty unrelated source\n');
      const before = f.data(),
        oldRecords = readWorkBytes(join(f.work.store.directory, 'work.json'));
      assert.equal(f.work.status().capabilities.nativeGithubPrImport, true);
      assert.equal(f.data().schema, 24);
      assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), oldRecords);
      const raw = JSON.parse(oldRecords);
      raw.unknownOwnerRecord = { retained: true };
      f.work.store.save(raw);
      f.change({ denied: true }); // Push permission is not needed by this read-only bridge.
      const incoming = (await f.call()).result,
        observation = incoming.external.observations[0],
        source = new NativeSource(f.root);
      assert.equal(f.data().schema, 24);
      assert.equal(incoming.external.author.login, 'upstream-author');
      assert.equal(observation.head, f.head);
      assert.equal(observation.base, f.base);
      assert.equal(incoming.base, observation.native.base);
      assert.notEqual(observation.native.head, f.head);
      assert.ok(source.ancestors(observation.native.head).has(f.imported.head));
      assert.equal(source.state(observation.native.head).git.commit, f.head);
      assert.ok(source.object(observation.bundle).length);
      assert.deepEqual(f.data().lanes, before.lanes);
      assert.deepEqual(f.data().views, before.views);
      assert.deepEqual(f.data().channelMoves, before.channelMoves);
      assert.equal(
        JSON.parse(readWorkBytes(join(f.work.store.directory, 'work.json'))).unknownOwnerRecord.retained,
        true,
      );
      assert.equal(readFileSync(join(path, 'dirty.ts'), 'utf8'), 'Keep dirty unrelated source\n');
      assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
      assert.match(f.work.status().intents.at(-1).externalDiff, /a = 2/);
      assert.equal(f.work.status({ compact: true }).intents.at(-1).detailDeferred, true);
      const detail = (
        await f.call({
          action: 'read-work-detail',
          kind: 'external',
          id: incoming.id,
          observation: 0,
          expectedHead: f.head,
          expectedBase: f.base,
        })
      ).result;
      assert.match(detail.details, /a = 2/);
      assert.equal(detail.native.head, observation.native.head);
      const view = compose(f, incoming);
      assert.equal(view.head, observation.native.head);
      assert.deepEqual(view.dependencies, [pin(incoming)]);
      const check = f.act({
        action: 'define-check',
        name: 'Exact incoming source',
        executable: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs');if(!fs.readFileSync('a.ts','utf8').includes('a = 2'))process.exit(1)",
        ],
        environmentLabel: 'Synthetic local runtime',
      });
      const running = (
        await f.call({
          action: 'run-check',
          operationId: randomUUID(),
          checkId: check.id,
          viewId: view.id,
          expectedHead: view.head,
          expectedDefinition: check.definition,
          expectedEnvironment: f.work.status().environment.fingerprint,
        })
      ).result;
      await waitFor(() => f.work.status().runs.find(run => run.id === running.id)?.status === 'passed');
      f.act({
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      });
      const exported = await exportNativeGit(f.root, view.head, join(f.root, '.forge/git-return'));
      assert.equal(exported.commit, f.head);
      assert.equal(
        git(join(exported.path, 'repository.git'), ['show', '-s', '--format=%an <%ae>', f.head]).trim(),
        'Original fork author <fork@localhost>',
      );
      assert.equal(
        git(join(exported.path, 'repository.git'), ['cat-file', 'commit', f.head]),
        git(f.remote, ['cat-file', 'commit', f.head]),
      );
      const objects = readdirSync(source.directory);
      await f.call({ action: 'collect-native-objects' });
      assert.ok(objects.includes(observation.bundle));
      assert.ok(existsSync(join(source.directory, observation.bundle)));
      assert.equal(f.data().schema, 24);
      assert.equal(f.state().creates, 1); // Only fixture setup published. Import/check makes no provider writes.
      if (process.env.FORGE_NATIVE_PR_LEGACY_CLI) {
        const workFile = join(f.work.store.directory, 'work.json'),
          indexed = readFileSync(workFile),
          portable = f.work.store.snapshotBytes();
        assert.equal(JSON.parse(indexed).schema, 'forge-work-records-v3');
        assert.equal(JSON.parse(portable).schema, 24);
        // Both the new indexed representation and unsupported portable format5 fail without a write.
        for (const retained of [indexed, portable]) {
          writeFileSync(workFile, retained);
          assert.throws(
            () =>
              execFileSync(process.execPath, [process.env.FORGE_NATIVE_PR_LEGACY_CLI, 'work', f.root], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }),
            error =>
              error.status !== 0 && /INVALID_WORK_STORE/.test(String(error.stdout) + String(error.stderr)),
          );
          assert.deepEqual(readFileSync(workFile), retained);
        }
      }
    },
  );

test(
  'pure native publication boundary maps incoming source without inventing Git-backed ownership; no format change from failed reads',
  { timeout: 120000 },
  async t => {
    const f = await native(t, { pure: true }),
      bytes = readWorkBytes(join(f.work.store.directory, 'work.json')),
      objects = readdirSync(new NativeSource(f.root).directory);
    await assert.rejects(f.call(input, 0), code('WORK_STALE'));
    await assert.rejects(
      f.call({ ...input, url: 'https://github.com.evil/tests/example/pull/7' }),
      code('BAD_ARGUMENT'),
    );
    f.change({ deniedRead: true });
    await assert.rejects(f.call(), code('PUBLISH_GITHUB_FAILED'));
    f.change({ deniedRead: false });
    const pulls = f.state().pulls;
    pulls[0].head.sha = f.base;
    f.change({ pulls });
    await assert.rejects(f.call(), code('PR_CHANGED'));
    f.update(f.head);
    assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), bytes);
    assert.deepEqual(readdirSync(new NativeSource(f.root).directory), objects);
    const incoming = (await f.call()).result,
      mapping = incoming.external.observations[0].native;
    assert.equal(existsSync(join(f.root, '.git')), false);
    assert.ok(new NativeSource(f.root).ancestors(mapping.head).has(f.imported.head));
    assert.equal(compose(f, incoming).status, 'clean');
    const repeat = (await f.call(input, 0)).result.external.observations.at(-1);
    assert.equal(repeat.native.base, mapping.base);
    assert.equal(repeat.native.head, mapping.head);
  },
);

test(
  'native check/repeat import preserves earlier exact candidates and concurrent notes; delayed reads cannot replace a later observation',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      incoming = (await f.call()).result,
      first = compose(f, incoming);
    const next = f.fork(f.command.expectedHead, f.head, 'Later fork history\n');
    f.update(next);
    f.act({ action: 'note', intentId: incoming.id, kind: 'decision', text: 'Retained owner decision' });
    const updated = (await f.call({ action: 'check-pr', intentId: incoming.id }, 0)).result;
    assert.equal(updated.id, incoming.id);
    assert.equal(updated.notes.length, 1);
    assert.equal(updated.external.observations[0].head, f.head);
    assert.equal(updated.external.observations[1].head, next);
    assert.equal(compose(f, updated).head, first.head);
    assert.equal(compose(f, updated, 1).head, updated.external.observations[1].native.head);
    const request = { action: 'check-pr', intentId: incoming.id };
    f.change({ holdDetail: true });
    const delayed = f.call(request, 0);
    await waitFor(() => f.state().delayStarted);
    const latest = await f.call(request, 0);
    const count = latest.result.external.observations.length;
    f.change({ releaseDetail: true });
    assert.equal((await delayed).result.external.observations.length, count);
    assert.equal(f.data().intents.filter(intent => intent.external).length, 1);
    assert.equal((await f.call(input, 0)).result.id, incoming.id);
    f.change({ deniedRead: true });
    const bytes = readWorkBytes(join(f.work.store.directory, 'work.json'));
    await assert.rejects(f.call(request, 0), code('PUBLISH_GITHUB_FAILED'));
    assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), bytes);
  },
);

test(
  'native pinned PR dependencies compose nonoverlap, retain conflicts and resolve through the existing native workflow',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      incoming = (await f.call()).result,
      local = f.work.store.path(f.lane.id);
    writeFileSync(join(local, 'local.ts'), 'export const local=1;\n');
    let lane = f.work.status().lanes[0];
    lane = f.act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: lane.head,
      expectedTree: lane.indexTree,
      message: 'Local nonoverlap',
    });
    const clean = f.act({
      action: 'compose',
      intentId: f.intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
      dependencies: [pin(incoming)],
    });
    assert.equal(clean.status, 'clean');
    assert.deepEqual(
      new NativeSource(f.root).state(clean.head).files.map(file => file.path),
      ['a.ts', 'local.ts'],
    );
    writeFileSync(join(local, 'a.ts'), 'Conflicting local bytes\n');
    lane = f.work.status().lanes[0];
    lane = f.act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: lane.head,
      expectedTree: lane.indexTree,
      message: 'Local conflict',
    });
    const conflict = f.act({
      action: 'compose',
      intentId: f.intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
      dependencies: [pin(incoming)],
    });
    assert.equal(conflict.status, 'conflict');
    assert.match(conflict.details, /a.ts/);
    const resolved = f.act({
      action: 'resolve-native-view',
      operationId: randomUUID(),
      viewId: conflict.id,
      laneId: lane.id,
      expectedHead: lane.head,
    });
    assert.equal(resolved.status, 'clean');
    assert.ok(
      new NativeSource(f.root).ancestors(resolved.head).has(incoming.external.observations[0].native.head),
    );
    assert.equal(f.data().views.find(view => view.id === conflict.id).status, 'conflict');
    await assert.rejects(
      f.call({
        action: 'compose',
        intentId: f.intent.id,
        inputs: [],
        dependencies: [{ ...pin(incoming), head: f.base }],
      }),
      code('BAD_ARGUMENT'),
    );
    const baseOnly = f.act({
      action: 'compose',
      intentId: f.intent.id,
      inputs: [],
      dependencies: [pin(incoming, 0, 'base')],
    });
    assert.equal(baseOnly.head, f.imported.head);
  },
);

test(
  'full and source-only native recovery retain binary, executable, rename/delete and complete original history without invoking Git',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      source = new NativeSource(f.root),
      repo = f.remote;
    git(repo, ['read-tree', f.head]);
    execFileSync('git', ['-C', repo, 'update-index', '--index-info'], {
      input: '0 '.concat('0'.repeat(f.head.length), '\ta.ts\n'),
      encoding: 'utf8',
    });
    const blob = text =>
      execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
        input: text,
        encoding: 'utf8',
      }).trim();
    const binary = Buffer.from([0, 255, 4, 0, 30]);
    for (const [path, mode, bytes] of [
      ['renamed.ts', '100644', 'export const a=2;\n'],
      ['fixture.bin', '100644', binary],
      ['run.sh', '100755', '#!/bin/sh\necho original\n'],
    ])
      git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob(bytes)},${path}`]);
    const tree = git(repo, ['write-tree']).trim(),
      commit = git(repo, [
        'commit-tree',
        tree,
        '-p',
        f.base,
        '-m',
        'Raw rename/delete/binary contribution',
      ]).trim();
    f.update(commit);
    const incoming = (await f.call()).result,
      view = compose(f, incoming),
      saved = f.data();
    const files = source.state(view.head).files;
    assert.equal(
      files.some(file => file.path === 'a.ts'),
      false,
    );
    assert.equal(files.find(file => file.path === 'run.sh').mode, 'executable');
    assert.deepEqual(source.object(files.find(file => file.path === 'fixture.bin').blob), binary);
    const bin = join(f.root, '.forge/no-git'),
      used = join(bin, 'used');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${used}'\nexit 91\n`, { mode: 0o700 });
    for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const previous = process.env.PATH;
    process.env.PATH = bin;
    let restored, sourceOnly;
    try {
      const archive = (await f.call({ action: 'export-work', archive: true })).result;
      restored = join(f.root, '.forge/restored');
      await restoreNativeWork(archive.archive.path, restored);
      assert.deepEqual(new WorkService(restored).store.load(), saved);
      const release = (await exportNativeSource(f.work.store, saved.revision, view.head)).result;
      sourceOnly = join(f.root, '.forge/source-only');
      await restoreNativeWork(release.archive.path, sourceOnly);
      assert.equal(new WorkService(sourceOnly).store.load().schema, 24);
      assert.deepEqual(new WorkService(sourceOnly).store.load().intents, []);
      assert.equal(existsSync(used), false);
      await f.call({ action: 'collect-native-objects' });
      assert.equal(f.data().schema, 24);
      assert.equal(existsSync(used), false);
    } finally {
      process.env.PATH = previous;
    }
    const originalBundle = incoming.external.observations[0].bundle;
    assert.ok(existsSync(join(new NativeSource(restored).directory, originalBundle)));
    const projected = await exportNativeGit(sourceOnly, view.head, join(f.root, '.forge/recovered-git'));
    assert.equal(projected.commit, commit);
    assert.equal(
      git(join(projected.path, 'repository.git'), ['cat-file', 'commit', commit]),
      git(repo, ['cat-file', 'commit', commit]),
    );
    const orphan = source.put(Buffer.from('Unreferenced synthetic object'));
    const collected = await f.call({ action: 'collect-native-objects' });
    assert.ok(collected.result.removed.some(item => item.id === orphan));
    assert.ok(existsSync(join(source.directory, originalBundle)));
    const records = f.data();
    records.intents.at(-1).external.observations[0].native.head = f.imported.head;
    f.work.store.save(records);
    await assert.rejects(f.call({ action: 'export-work', archive: true }), code('INVALID_NATIVE_GIT'));
    await assert.rejects(f.call({ action: 'collect-native-objects' }), code('INVALID_NATIVE_GIT'));
  },
);

test(
  'unrelated Git ancestry is retained as readable source, never fabricated as a native parent for canonical composition',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      tree = git(f.remote, ['rev-parse', `${f.head}^{tree}`]).trim();
    const unrelated = git(f.remote, ['commit-tree', tree, '-m', 'Independent source root']).trim();
    f.update(unrelated);
    const incoming = (await f.call()).result,
      snapshot = new NativeSource(f.root).state(incoming.external.observations[0].native.head);
    assert.deepEqual(snapshot.parents, []);
    assert.match(f.work.status().intents.at(-1).externalDiff, /a = 2/);
    await assert.rejects(
      f.call({ action: 'compose', intentId: f.intent.id, inputs: [], dependencies: [pin(incoming)] }),
      code('NATIVE_MERGE_BASE_UNKNOWN'),
    );
    assert.equal(f.data().views.length, 0);
    assert.equal(f.data().channelMoves.length, 0);
    assert.ok(new NativeSource(f.root).object(incoming.external.observations[0].bundle).length);
  },
);

test(
  'native incoming HTTP/CLI/real opt-in MCP share exact import/check/pin behavior and current read authorization',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      server = await serveRepository(f.root, 0);
    t.after(() => server.close());
    const url = new URL(server.url),
      token = new URLSearchParams(url.hash.slice(1)).get('token'),
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const body = JSON.stringify({ command: input, revision: f.data().revision });
    assert.equal(
      (
        await fetch(url.origin + '/api/work', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
      401,
    );
    const response = await fetch(url.origin + '/api/work', { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    const incoming = (await response.json()).result;
    const cli = JSON.parse(
      execFileSync(process.execPath, ['dist/cli.js', 'work', f.root, JSON.stringify(input), '0'], {
        encoding: 'utf8',
      }),
    );
    assert.equal(cli.result.id, incoming.id);
    const client = new Client({ name: 'forge-native-incoming-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/cli.js', 'mcp', f.root, '--work'],
        env: process.env,
        stderr: 'pipe',
      }),
    );
    const call = async command =>
      JSON.parse(
        (
          await client.callTool({
            name: 'forge_work_command',
            arguments: { command, revision: f.data().revision },
          })
        ).content[0].text,
      );
    const checked = (await call({ action: 'check-pr', intentId: incoming.id })).result;
    assert.equal(checked.id, incoming.id);
    const view = (
      await call({ action: 'compose', intentId: f.intent.id, inputs: [], dependencies: [pin(checked)] })
    ).result;
    assert.equal(view.status, 'clean');
    // Keep a real peer in writer admission while MCP reads immutable review
    // pins. The read must return its original result shape, never WORK_BUSY.
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { readSync } from 'node:fs';
import { WorkStore } from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
new WorkStore(process.argv[1]).locked(() => {
  process.stdout.write('held\\n');
  readSync(0, Buffer.alloc(1), 0, 1, null);
});`,
        f.root,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = once(holder, 'close');
    try {
      await once(holder.stdout, 'data');
      const detail = await call({
        action: 'read-work-detail',
        kind: 'external',
        id: incoming.id,
        observation: 0,
        expectedHead: f.head,
        expectedBase: f.base,
      });
      assert.equal(detail.error, undefined, JSON.stringify(detail.error));
      assert.match(detail.result.details, /a = 2/);
    } finally {
      holder.stdin.end('release');
      assert.equal((await closed)[0], 0);
    }
    f.change({ deniedRead: true });
    const bytes = readWorkBytes(join(f.work.store.directory, 'work.json'));
    assert.equal(
      (await call({ action: 'check-pr', intentId: incoming.id })).error.code,
      'PUBLISH_GITHUB_FAILED',
    );
    assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), bytes);
    assert.equal(f.state().creates, 1);
    await client.close();
  },
);

test(
  'lost native PR save/reply reconciles one Intent; unregistered staged objects remain collectible and current Work stays intact',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      source = new NativeSource(f.root),
      file = join(f.work.store.directory, 'work.json'),
      original = readFileSync(file),
      save = f.work.store.save.bind(f.work.store);
    f.work.store.save = () => {
      throw Error('lost registration before save');
    };
    await assert.rejects(f.call(), /lost registration before save/);
    f.work.store.save = save;
    assert.deepEqual(readFileSync(file), original);
    assert.equal(f.data().schema, 24);
    assert.equal(f.data().intents.length, 1);
    const orphaned = (await f.call({ action: 'collect-native-objects' })).result.removed;
    assert.ok(orphaned.length > 0);
    assert.ok(existsSync(join(source.directory, f.imported.head)));
    f.work.store.save = data => {
      save(data);
      throw Error('lost registration reply');
    };
    await assert.rejects(f.call(), /lost registration reply/);
    f.work.store.save = save;
    const incoming = f.data().intents.find(item => item.external),
      pins = incoming.external.observations[0].native;
    const retry = (await f.call(input, 0)).result;
    assert.equal(retry.id, incoming.id);
    assert.equal(f.data().intents.filter(item => item.external).length, 1);
    assert.equal(retry.external.observations.at(-1).native.head, pins.head);
    assert.equal(retry.external.observations.at(-1).native.base, pins.base);
    assert.equal(f.data().schema, 24);
  },
);

test(
  'native incoming GitHub squash acceptance retains original accepted history separately from Forge Channels',
  { timeout: 120000 },
  async t => {
    const f = await native(t),
      accepted = git(f.remote, [
        'commit-tree',
        `${f.head}^{tree}`,
        '-p',
        f.base,
        '-m',
        'Original provider squash',
      ]).trim();
    const pulls = f.state().pulls;
    Object.assign(pulls[0], {
      state: 'closed',
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: accepted,
    });
    f.change({ pulls });
    git(f.remote, ['update-ref', 'refs/heads/main', accepted]);
    const incoming = (await f.call()).result,
      observation = incoming.external.observations[0];
    assert.equal(observation.acceptance, 'accepted');
    assert.equal(observation.acceptedCommit, accepted);
    assert.equal(f.data().channelMoves.length, 0);
    const exported = await exportNativeGit(
      f.root,
      observation.native.head,
      join(f.root, '.forge/squash-export'),
    );
    assert.equal(
      git(join(exported.path, 'repository.git'), ['cat-file', 'commit', accepted]),
      git(f.remote, ['cat-file', 'commit', accepted]),
    );
    git(f.remote, ['update-ref', 'refs/heads/main', f.base]);
    const checked = (await f.call({ action: 'check-pr', intentId: incoming.id }, 0)).result;
    assert.equal(checked.external.observations.at(-1).acceptance, 'unconfirmed');
    assert.equal(checked.external.observations[0].acceptance, 'accepted');
    assert.equal(f.data().channelMoves.length, 0);
  },
);
