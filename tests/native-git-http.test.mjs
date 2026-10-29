// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkService } from '../dist/work.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { importNativeGit, exportNativeGit } from '../dist/native-git.js';
import { indexRepository } from '../dist/index.js';
import { serveRepository } from '../dist/http.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { workGit } from '../dist/work-git.js';

// Hang guards only: a loaded machine slows every Git process, and the assertions below stay unchanged.
process.env.FORGE_GIT_TIMEOUT_MS ??= '240000';

function client(root, args, token) {
  return new Promise((resolve, reject) => {
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
    const child = execFile(
      'git',
      ['-C', root, ...args],
      { env, encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error('Git client failed; credentials/source withheld.')) : resolve(stdout.trim()),
    );
    child.stdin.end();
  });
}
const snapshot = work => ({
  work: readWorkBytes(join(work.store.directory, 'work.json')),
  objects: readdirSync(new NativeSource(work.store.root).directory)
    .sort()
    .map(id => [id, readFileSync(join(work.store.directory, 'objects', id))]),
});

for (const kind of ['plain', 'sha1', 'sha256'])
  test(
    `Forge-native ${kind} protected Git clone/fetch preserves native authority, accepted pins and rollback history`,
    { timeout: 900000 },
    async t => {
      const directory = mkdtempSync(join(tmpdir(), 'forge-native-http-'));
      t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      const root = join(directory, 'native'),
        binary = randomBytes(1024 * 1024),
        clientRoot = join(directory, 'client');
      mkdirSync(clientRoot);
      let original, originalRaw, unrelatedGit;
      if (kind === 'plain') {
        mkdirSync(root);
        writeFileSync(join(root, 'a.ts'), 'export const original = 1;\n');
        writeFileSync(join(root, 'binary.bin'), binary);
        writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(root, 'run.sh'), 0o700);
        initNative(root);
      } else {
        const input = join(directory, 'git');
        mkdirSync(input);
        workGit(input, ['init', '--template=', `--object-format=${kind}`, '--initial-branch=main']);
        writeFileSync(join(input, 'a.ts'), 'export const original = 1;\n');
        writeFileSync(join(input, 'binary.bin'), binary);
        writeFileSync(join(input, 'run.sh'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(input, 'run.sh'), 0o700);
        writeFileSync(join(input, '.env'), 'SYNTHETIC_ONLY=original-history\n');
        workGit(input, ['add', '.']);
        workGit(input, ['commit', '-m', 'Original full source']);
        workGit(input, ['checkout', '-b', 'unrelated']);
        writeFileSync(join(input, 'unaccepted.txt'), 'Unrelated imported side source');
        workGit(input, ['add', '.']);
        workGit(input, ['commit', '-m', 'Unaccepted side']);
        unrelatedGit = workGit(input, ['rev-parse', 'HEAD']).trim();
        workGit(input, ['checkout', 'main']);
        workGit(input, ['rm', '.env']);
        workGit(input, ['commit', '-m', 'Remove synthetic history value']);
        original = workGit(input, ['rev-parse', 'HEAD']).trim();
        originalRaw = workGit(input, ['cat-file', 'commit', original], undefined, false, true);
        await importNativeGit(input, original, root);
      }
      assert.equal(existsSync(join(root, '.git')), false);
      const work = new WorkService(root),
        act = c => work.execute(c, work.store.load().revision).result;
      const intent = act({ action: 'intent', outcome: 'Native read-only Git boundary' }),
        lane = act({ action: 'lane', intentId: intent.id, name: 'Accepted source' }),
        path = work.store.path(lane.id);
      const first = act({
          action: 'compose',
          operationId: randomUUID(),
          intentId: intent.id,
          inputs: [{ laneId: lane.id, head: lane.head }],
        }),
        firstId = randomUUID();
      act({
        action: 'accept-channel',
        operationId: firstId,
        channel: 'main',
        viewId: first.id,
        expectedHead: first.head,
        expectedPrevious: null,
      });
      writeFileSync(join(path, 'a.ts'), 'export const original = 2;\n');
      const overview = work.status({ compact: true }).lanes[0];
      assert.equal(overview.indexTree, null);
      assert.equal(overview.detailDeferred, true);
      const row = (
        await work.dispatch(
          { action: 'read-work-detail', kind: 'lane', id: lane.id, expectedHead: overview.actualHead },
          0,
        )
      ).result.lane;
      assert.ok(row.indexTree);
      assert.match(row.diff, /original = 2/);
      const nextLane = act({
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: row.head,
          expectedTree: row.indexTree,
          message: 'Next native source',
        }),
        next = act({
          action: 'compose',
          operationId: randomUUID(),
          intentId: intent.id,
          inputs: [{ laneId: lane.id, head: nextLane.head }],
        }),
        nextId = randomUUID();
      act({
        action: 'accept-channel',
        operationId: nextId,
        channel: 'main',
        viewId: next.id,
        expectedHead: next.head,
        expectedPrevious: first.head,
      });
      // Derive expected IDs through the existing compatibility owner; no projection enters native Work.
      const firstProjection = await exportNativeGit(root, first.head, join(directory, 'first-projection')),
        nextProjection = await exportNativeGit(root, next.head, join(directory, 'next-projection'));
      writeFileSync(join(root, 'unfinished.txt'), 'Keep dirty owner');
      writeFileSync(join(path, 'a.ts'), 'Keep dirty Lane');
      indexRepository(root);
      // Serving starts owner presence, whose automatic Lane snapshot of the dirty Lane is a legitimate
      // native write unrelated to Git; this test asserts that Git serving itself writes nothing.
      await new AgentWorkflow(root).dispatch({
        action: 'set-policy',
        operationId: randomUUID(),
        autoSnapshot: false,
      });
      const before = snapshot(work),
        server = await serveRepository(root, 0);
      t.after(() => server.close());
      const origin = `http://127.0.0.1:${server.port}`,
        headers = { Authorization: `Bearer ${server.token}` };
      const immutable = origin + `/api/git/${firstId}/`,
        moving = origin + '/api/git/channel/main/',
        advertisement = 'info/refs?service=git-upload-pack';
      assert.equal((await fetch(immutable + advertisement)).status, 401);
      assert.equal(
        (
          await fetch(moving + advertisement, {
            headers: { ...headers, Origin: 'https://unrelated.invalid' },
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(moving.replace('main/', 'missing/') + advertisement, { headers })).status,
        404,
      );
      assert.equal(
        (await fetch(origin + `/api/git/${randomUUID()}/` + advertisement, { headers })).status,
        404,
      );
      assert.equal((await fetch(immutable + 'info/refs?service=git-receive-pack', { headers })).status, 400);
      assert.equal((await fetch(immutable + 'git-receive-pack', { method: 'POST', headers })).status, 404);
      assert.equal((await fetch(immutable + 'objects/info/packs', { headers })).status, 404);
      assert.equal(
        (await fetch(immutable + 'git-upload-pack', { method: 'POST', headers, body: 'invalid' })).status,
        400,
      );
      await client(
        clientRoot,
        ['clone', '--template=', '--branch', 'accepted', '--', immutable, 'immutable'],
        server.token,
      );
      await client(
        clientRoot,
        ['clone', '--template=', '--branch', 'accepted', '--', moving, 'moving'],
        server.token,
      );
      const copy = join(clientRoot, 'immutable'),
        current = join(clientRoot, 'moving');
      assert.equal(workGit(copy, ['rev-parse', 'HEAD']).trim(), firstProjection.commit);
      assert.equal(workGit(current, ['rev-parse', 'HEAD']).trim(), nextProjection.commit);
      assert.equal(
        workGit(current, ['rev-parse', '--show-object-format']).trim(),
        kind === 'plain' ? 'sha1' : kind,
      );
      assert.deepEqual(readFileSync(join(copy, 'binary.bin')), binary);
      assert.equal(readFileSync(join(copy, 'a.ts'), 'utf8'), 'export const original = 1;\n');
      assert.match(workGit(copy, ['ls-files', '--stage', 'run.sh']), /^100755 /);
      if (original) {
        assert.equal(firstProjection.commit, original);
        assert.deepEqual(
          workGit(copy, ['cat-file', 'commit', original], undefined, false, true),
          originalRaw,
        );
        assert.match(workGit(copy, ['show', `${original}^:.env`]), /original-history/);
        assert.throws(() => workGit(copy, ['cat-file', '-e', unrelatedGit]));
        await assert.rejects(client(copy, ['fetch', 'origin', unrelatedGit], server.token));
      }
      const names = (await client(clientRoot, ['ls-remote', '--heads', moving], server.token))
        .split('\n')
        .map(line => line.split('\t')[1]);
      assert.ok(
        names.every(ref => ref === 'refs/heads/accepted' || ref.startsWith('refs/heads/acceptances/')),
      );
      const immutableNames = (await client(clientRoot, ['ls-remote', '--heads', immutable], server.token))
        .split('\n')
        .map(line => line.split('\t')[1]);
      assert.deepEqual(immutableNames, ['refs/heads/accepted']);
      if (kind !== 'sha256')
        assert.equal(
          await client(
            clientRoot,
            ['-c', 'protocol.version=0', 'ls-remote', '--heads', immutable],
            server.token,
          ),
          `${firstProjection.commit}\trefs/heads/accepted`,
        );
      await client(copy, ['fetch', 'origin'], server.token);
      assert.equal(workGit(copy, ['rev-parse', 'origin/accepted']).trim(), firstProjection.commit);
      await assert.rejects(client(current, ['push', 'origin', 'HEAD:refs/heads/accepted'], server.token));
      assert.deepEqual(snapshot(work), before);
      const advertised = await fetch(moving + advertisement, { headers });
      assert.equal(advertised.status, 200);
      assert.ok((await advertised.text()).includes(nextProjection.commit));
      act({
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: first.id,
        expectedHead: first.head,
        expectedPrevious: next.head,
      });
      const rollback = snapshot(work);
      const packet = text => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
      const response = await fetch(moving + 'git-upload-pack', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-git-upload-pack-request' },
        body:
          packet(`want ${nextProjection.commit} object-format=${nextProjection.format}\n`) +
          '0000' +
          packet('done\n'),
      });
      if (response.status !== 200) assert.fail(`upload-pack ${response.status}: ${await response.text()}`);
      const bytes = Buffer.from(await response.arrayBuffer()),
        offset = bytes.indexOf('PACK');
      assert.ok(offset >= 0);
      const pack = join(directory, 'received.git');
      mkdirSync(pack);
      workGit(pack, ['init', '--bare', '--template=', `--object-format=${nextProjection.format}`]);
      workGit(pack, ['index-pack', '--stdin'], bytes.subarray(offset));
      assert.equal(workGit(pack, ['show', `${nextProjection.commit}:a.ts`]), 'export const original = 2;\n');
      await client(current, ['fetch', 'origin'], server.token);
      assert.equal(workGit(current, ['rev-parse', 'origin/accepted']).trim(), firstProjection.commit);
      assert.equal(
        workGit(current, ['rev-parse', `origin/acceptances/${nextId}`]).trim(),
        nextProjection.commit,
      );
      assert.equal(workGit(current, ['rev-parse', 'HEAD']).trim(), nextProjection.commit);
      assert.deepEqual(snapshot(work), rollback);
      assert.equal(readFileSync(join(root, 'unfinished.txt'), 'utf8'), 'Keep dirty owner');
      assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'Keep dirty Lane');
      // Ordinary native Work/source continues with Git unavailable; the explicit boundary fails honestly.
      const noGit = join(directory, 'no-git');
      mkdirSync(noGit);
      const called = join(directory, 'git-called');
      writeFileSync(join(noGit, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
      chmodSync(join(noGit, 'git'), 0o700);
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = noGit;
        assert.equal(work.status({ compact: true }).channels[0].head, first.head);
        const status = await fetch(origin + '/api/work?compact=true', { headers });
        assert.equal(status.status, 200);
        assert.equal(existsSync(called), false);
        const failed = await fetch(immutable + advertisement, { headers });
        assert.equal(failed.status, 400);
        assert.equal((await failed.json()).error.code, 'WORK_GIT_FAILED');
        assert.equal(existsSync(called), true);
        assert.deepEqual(snapshot(work), rollback);
      } finally {
        process.env.PATH = previousPath;
      }
      // One invalid later history receipt blocks moving export without changing the original immutable URL.
      const saved = work.store.load();
      saved.views = saved.views.filter(view => view.id !== next.id);
      saved.revision++;
      work.store.save(saved);
      const invalid = snapshot(work);
      assert.equal((await fetch(moving + advertisement, { headers })).status, 400);
      const intact = await fetch(immutable + advertisement, { headers });
      assert.equal(intact.status, 200);
      await intact.arrayBuffer();
      assert.deepEqual(snapshot(work), invalid);
      const pending = work.store.load(),
        pendingId = randomUUID();
      pending.channelMoves.push({ ...pending.channelMoves[0], id: pendingId, status: 'pending' });
      pending.revision++;
      work.store.save(pending);
      const pendingSnapshot = snapshot(work);
      assert.equal((await fetch(origin + `/api/git/${pendingId}/` + advertisement, { headers })).status, 404);
      assert.deepEqual(snapshot(work), pendingSnapshot);
      const source = new NativeSource(root),
        blob = source.state(first.head).files[0].blob,
        blobPath = join(source.directory, blob),
        originalBlob = readFileSync(blobPath);
      writeFileSync(blobPath, 'Corrupt fixture bytes');
      const corrupted = snapshot(work);
      const failed = await fetch(immutable + advertisement, { headers });
      assert.equal(failed.status, 400);
      assert.equal((await failed.json()).error.code, 'INVALID_NATIVE_SOURCE');
      assert.deepEqual(snapshot(work), corrupted);
      writeFileSync(blobPath, originalBlob);
      assert.deepEqual(snapshot(work), pendingSnapshot);
    },
  );

test('Git-unavailable native edits/checkpoints/Views/acceptance/source remain usable while explicit compatibility fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-native-no-git-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'native');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const value = 1;\n');
  initNative(root);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const called = join(directory, 'git-called');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
  chmodSync(join(bin, 'git'), 0o700);
  const previous = process.env.PATH;
  let server;
  try {
    process.env.PATH = bin;
    const work = new WorkService(root),
      act = c => work.execute(c, work.store.load().revision).result;
    const intent = act({ action: 'intent', outcome: 'Git independent ordinary native work' }),
      lane = act({ action: 'lane', intentId: intent.id, name: 'No Git workspace' });
    writeFileSync(join(work.store.path(lane.id), 'a.ts'), 'export const value = 2;\n');
    const overview = work.status({ compact: true }).lanes[0];
    assert.equal(overview.indexTree, null);
    assert.equal(overview.detailDeferred, true);
    const row = (
      await work.dispatch(
        { action: 'read-work-detail', kind: 'lane', id: lane.id, expectedHead: overview.actualHead },
        0,
      )
    ).result.lane;
    assert.ok(row.indexTree);
    assert.match(row.diff, /value = 2/);
    const checkpoint = act({
        action: 'checkpoint',
        laneId: lane.id,
        expectedHead: row.head,
        expectedTree: row.indexTree,
        message: 'Git independent source',
      }),
      view = act({
        action: 'compose',
        operationId: randomUUID(),
        intentId: intent.id,
        inputs: [{ laneId: lane.id, head: checkpoint.head }],
      }),
      operationId = randomUUID();
    act({
      action: 'accept-channel',
      operationId,
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
    assert.equal(work.status({ compact: true }).channels[0].head, view.head);
    assert.equal(work.status({ compact: true }).capabilities.nativeGitHttp, true);
    assert.equal(work.status({ compact: true }).capabilities.nativeGitChannels, true);
    assert.equal(
      work.status({ compact: true }).capabilities.nativeGitContributions,
      process.platform !== 'win32',
    );
    assert.equal(work.status({ compact: true }).capabilities.githubMirrors, false);
    indexRepository(root);
    server = await serveRepository(root, 0);
    const origin = `http://127.0.0.1:${server.port}`,
      headers = { Authorization: `Bearer ${server.token}` };
    const local = await fetch(origin + '/api/work?compact=true', { headers });
    assert.equal(local.status, 200);
    assert.equal((await local.json()).channels[0].head, view.head);
    assert.equal(existsSync(called), false);
    const before = snapshot(work),
      failed = await fetch(origin + `/api/git/${operationId}/info/refs?service=git-upload-pack`, { headers });
    assert.equal(failed.status, 400);
    assert.equal((await failed.json()).error.code, 'WORK_GIT_FAILED');
    assert.equal(existsSync(called), true);
    assert.deepEqual(snapshot(work), before);
  } finally {
    process.env.PATH = previous;
    if (server) await server.close();
  }
});

for (const format of ['sha1', 'sha256'])
  test(
    `native incoming-PR ${format} original commit ancestry remains usable through accepted smart HTTP`,
    { timeout: 900000 },
    async t => {
      const { setup } = await import('./publication-fixture.mjs');
      const oldHash = process.env.GIT_DEFAULT_HASH;
      process.env.GIT_DEFAULT_HASH = format;
      let f;
      try {
        f = setup(t);
      } finally {
        if (oldHash === undefined) delete process.env.GIT_DEFAULT_HASH;
        else process.env.GIT_DEFAULT_HASH = oldHash;
      }
      await f.publish();
      const original = workGit(f.root, ['rev-parse', 'HEAD']).trim(),
        root = join(f.root, '.git/native-owner');
      await importNativeGit(f.root, original, root);
      const work = new WorkService(root),
        act = c => work.execute(c, work.store.load().revision).result,
        incoming = (
          await work.dispatch(
            { action: 'import-pr', url: 'https://github.com/tests/example/pull/7' },
            work.store.load().revision,
          )
        ).result,
        observation = incoming.external.observations[0];
      const intent = act({ action: 'intent', outcome: 'Use imported PR source' }),
        view = act({
          action: 'compose',
          operationId: randomUUID(),
          intentId: intent.id,
          inputs: [],
          dependencies: [
            { kind: 'pr', intentId: incoming.id, observation: 0, part: 'head', head: observation.head },
          ],
        }),
        id = randomUUID();
      act({
        action: 'accept-channel',
        operationId: id,
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      });
      const before = snapshot(work),
        server = await serveRepository(root, 0);
      t.after(() => server.close());
      const url = `http://127.0.0.1:${server.port}/api/git/${id}/`,
        destination = join(f.root, '.git/native-client');
      mkdirSync(destination);
      await client(
        destination,
        ['clone', '--template=', '--branch', 'accepted', '--', url, 'source'],
        server.token,
      );
      const copy = join(destination, 'source');
      assert.equal(workGit(copy, ['rev-parse', 'HEAD']).trim(), observation.head);
      assert.deepEqual(
        workGit(copy, ['cat-file', 'commit', observation.head], undefined, false, true),
        workGit(f.remote, ['cat-file', 'commit', observation.head], undefined, false, true),
      );
      assert.equal(readFileSync(join(copy, 'a.ts'), 'utf8'), 'export const a = 2;\n');
      assert.equal(workGit(copy, ['merge-base', '--is-ancestor', original, observation.head]), '');
      assert.deepEqual(snapshot(work), before);
      assert.equal(
        f.state().creates,
        1,
        'Only fixture setup published; clone/fetch makes no provider calls or writes.',
      );
    },
  );
