// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { importNativeGit, exportNativeGit } from '../dist/native-git.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { serveRepository } from '../dist/http.js';
import { workGit } from '../dist/work-git.js';
import { importNativeGitContribution } from '../dist/native-git-contribution.js';
import { nativeGitContributionRequest } from '../dist/native-git-contribution.js';
import { exportNativeSource } from '../dist/native-backup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, request as httpRequest } from 'node:http';
const node = process.execPath,
  hash = b => createHash('sha256').update(b).digest('hex');
function git(root, args, { input, fail = false } = {}) {
  return new Promise((done, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', root, ...args],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Original contributor',
          GIT_AUTHOR_EMAIL: 'claim@example.invalid',
          GIT_COMMITTER_NAME: 'Original committer',
          GIT_COMMITTER_EMAIL: 'claim@example.invalid',
        },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? fail
            ? done({ failed: true, stdout, stderr })
            : reject(
                Error(
                  `Git fixture failed (${error.code ?? ''}, ${error.signal ?? ''}, killed=${error.killed}): ` +
                    stderr,
                ),
              )
          : done(stdout),
    );
    child.stdin.end(input);
  });
}
async function fixture(t, kind = 'plain', { wireClone = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-git-return-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  let rawBase;
  if (kind === 'plain') {
    mkdirSync(root);
    writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
    initNative(root);
  } else {
    const original = join(dir, 'original');
    mkdirSync(original);
    await git(original, ['init', '--template=', `--object-format=${kind}`, '--initial-branch=main']);
    writeFileSync(join(original, 'a.ts'), 'export const a=1;\n');
    writeFileSync(join(original, 'binary.bin'), Buffer.from([0, 255, 128]));
    writeFileSync(join(original, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(original, 'run.sh'), 0o700);
    await git(original, ['add', '.']);
    await git(original, ['commit', '-m', 'Original source']);
    const head = (await git(original, ['rev-parse', 'HEAD'])).trim();
    await git(original, ['branch', 'side', head]);
    await importNativeGit(original, head, root);
    rawBase = await git(original, ['cat-file', 'commit', head]);
  }
  const w = new WorkService(root),
    data = () => w.store.load(),
    act = c => w.execute(c, data().revision).result;
  const source = new NativeSource(root),
    initial = act({ action: 'intent', outcome: 'Accept initial source' }),
    first = act({ action: 'lane', intentId: initial.id, name: 'Initial' });
  const initialView = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: initial.id,
    inputs: [{ laneId: first.id, head: first.head }],
  });
  const acceptance = act({
    action: 'accept-channel',
    operationId: randomUUID(),
    viewId: initialView.id,
    expectedHead: initialView.head,
    expectedPrevious: null,
    channel: 'main',
  });
  const intent = act({
    action: 'intent',
    outcome: 'Native Git return',
    baseChannel: { name: 'main', head: acceptance.head, acceptanceId: acceptance.id },
  });
  const dirty = act({ action: 'lane', intentId: intent.id, name: 'Preserve owner work' });
  writeFileSync(join(w.store.path(dirty.id), 'a.ts'), 'Preserve unfinished owner edits\n');
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const u = new URL(server.url),
    token = new URLSearchParams(u.hash.slice(1)).get('token');
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${token}`];
  const url = (id, selected = intent) =>
    u.origin + `/api/git/contribute/${selected.id}/${id}/${selected.base}/`;
  const client = join(dir, 'client');
  // Keep contribution-clone transport coverage in the three wire cases. Other
  // import/recovery cases use a local bundle instead of repeating that handshake.
  if (wireClone) await git(dir, [...auth, 'clone', '--template=', url(randomUUID()), client]);
  else {
    const projected = await exportNativeGit(root, intent.base, join(dir, 'fixture-projection'));
    await git(dir, [
      'clone',
      '--template=',
      `--branch=forge-native/${intent.base}`,
      '--',
      projected.bundle.path,
      client,
    ]);
  }
  return {
    dir,
    root,
    w,
    data,
    act,
    source,
    intent,
    dirty,
    server,
    u,
    token,
    auth,
    url,
    client,
    acceptance,
    rawBase,
  };
}
for (const kind of ['plain', 'sha1', 'sha256'])
  test(
    `true-native ${kind} Git push preserves claims, exact ancestry and a second accepted return without ref collision`,
    { timeout: 120000 },
    async t => {
      const f = await fixture(t, kind, { wireClone: true }),
        original = f.data(),
        ownerBytes = readFileSync(join(f.w.store.path(f.dirty.id), 'a.ts')),
        operation = randomUUID();
      assert.equal(existsSync(join(f.root, '.git')), false);
      writeFileSync(join(f.client, 'a.ts'), 'export const a=2;\n');
      writeFileSync(join(f.client, 'payload.bin'), Buffer.from([255, 0, 250]));
      await git(f.client, ['add', '.']);
      await git(f.client, ['commit', '-m', 'First contributor claim']);
      const head = (await git(f.client, ['rev-parse', 'HEAD'])).trim(),
        raw = await git(f.client, ['cat-file', 'commit', head]);
      await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution']);
      let data = f.data(),
        receipt = data.nativeContributionReceipts.find(r => r.id === operation),
        lane = data.lanes.find(l => l.id === operation);
      assert.equal(data.schema, 6);
      assert.equal(receipt.provenance, 'unverified-git-bundle');
      assert.equal(receipt.gitHead, head);
      assert.equal(receipt.base, f.intent.base);
      assert.equal(receipt.retainedRef, `refs/forge/contributions/${operation}/head`);
      assert.equal(receipt.wireRef, 'refs/heads/contribution');
      assert.equal(f.source.state(lane.head).git.commit, head);
      assert.ok(f.source.ancestors(lane.head).has(f.intent.base));
      assert.equal(readFileSync(join(f.w.store.path(lane.id), 'a.ts'), 'utf8'), 'export const a=2;\n');
      assert.deepEqual(
        readFileSync(join(f.w.store.path(lane.id), 'payload.bin')),
        Buffer.from([255, 0, 250]),
      );
      assert.deepEqual(data.channelMoves, original.channelMoves);
      assert.deepEqual(data.views, original.views);
      assert.deepEqual(data.runs, original.runs);
      assert.deepEqual(data.intents, original.intents);
      assert.deepEqual(readFileSync(join(f.w.store.path(f.dirty.id), 'a.ts')), ownerBytes);
      assert.equal(existsSync(join(f.w.store.directory, `native-git-return-${operation}.bundle`)), false);
      const retryBytes = readWorkBytes(join(f.w.store.directory, 'work.json'));
      await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution']);
      assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), retryBytes);
      const view = f.act({
        action: 'compose',
        operationId: randomUUID(),
        intentId: f.intent.id,
        inputs: [{ laneId: lane.id, head: lane.head }],
      });
      assert.equal(view.status, 'clean');
      const accepted = f.act({
        action: 'accept-channel',
        operationId: randomUUID(),
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: f.intent.base,
        channel: 'main',
      });
      const nextIntent = f.act({
        action: 'intent',
        outcome: 'Second native Git return',
        baseChannel: { name: 'main', head: accepted.head, acceptanceId: accepted.id },
      });
      const nextClient = join(f.dir, 'next-client');
      await git(f.dir, [
        ...f.auth,
        'clone',
        '--template=',
        f.u.origin + '/api/git/channel/main/',
        nextClient,
      ]);
      assert.equal((await git(nextClient, ['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(await git(nextClient, ['cat-file', 'commit', head]), raw);
      if (f.rawBase) assert.equal(await git(nextClient, ['cat-file', 'commit', receipt.gitBase]), f.rawBase);
      writeFileSync(join(nextClient, 'a.ts'), 'export const a=3;\n');
      await git(nextClient, ['add', '.']);
      await git(nextClient, ['commit', '-m', 'Second contributor claim']);
      const secondHead = (await git(nextClient, ['rev-parse', 'HEAD'])).trim(),
        second = randomUUID();
      await git(nextClient, [...f.auth, 'push', f.url(second, nextIntent), 'HEAD:refs/heads/contribution']);
      const secondLane = f.data().lanes.find(l => l.id === second),
        secondView = f.act({
          action: 'compose',
          operationId: randomUUID(),
          intentId: nextIntent.id,
          inputs: [{ laneId: second, head: secondLane.head }],
        });
      f.act({
        action: 'accept-channel',
        operationId: randomUUID(),
        viewId: secondView.id,
        expectedHead: secondView.head,
        expectedPrevious: accepted.head,
        channel: 'main',
      });
      const finalClient = join(f.dir, 'final-client');
      await git(f.dir, [
        ...f.auth,
        'clone',
        '--template=',
        f.u.origin + '/api/git/channel/main/',
        finalClient,
      ]);
      assert.equal((await git(finalClient, ['rev-parse', 'HEAD'])).trim(), secondHead);
      assert.equal(await git(finalClient, ['cat-file', 'commit', head]), raw);
      const exported = await exportNativeGit(f.root, secondView.head, join(f.dir, 'final-projection'));
      assert.match(
        await git(join(exported.path, 'repository.git'), ['for-each-ref', '--format=%(refname)']),
        new RegExp(`refs/forge/contributions/${operation}/head`),
      );
      assert.equal(f.data().nativeContributionReceipts.length, 2);
      const beforeCollection = f.data();
      await f.w.dispatch({ action: 'collect-native-objects' }, beforeCollection.revision);
      for (const r of f.data().nativeContributionReceipts)
        for (const id of [r.inputSha256, r.bundleSha256, r.projection.bundle, r.projection.mapping])
          assert.equal(existsSync(join(f.source.directory, id)), true);
    },
  );

async function candidate(
  f,
  { operationId = randomUUID(), name = 'Explicit native Git bundle', signed = false } = {},
) {
  writeFileSync(join(f.client, 'a.ts'), 'export const a=8;\n');
  await git(f.client, ['add', '.']);
  await git(f.client, ['commit', '-m', 'Original return']);
  let head = (await git(f.client, ['rev-parse', 'HEAD'])).trim();
  if (signed) {
    const tree = (await git(f.client, ['rev-parse', 'HEAD^{tree}'])).trim(),
      parent = (await git(f.client, ['rev-parse', 'HEAD^'])).trim();
    const raw = `tree ${tree}\nparent ${parent}\nauthor Original author <claim@example.invalid> 1700000000 +0000\ncommitter Original committer <claim@example.invalid> 1700000001 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n unverified-original-bytes\n -----END PGP SIGNATURE-----\n\nOriginal signature claim\n`;
    head = (await git(f.client, ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: raw })).trim();
  }
  await git(f.client, ['update-ref', 'refs/heads/contribution', head]);
  const path = join(f.dir, operationId + '.bundle');
  await git(f.client, ['bundle', 'create', path, 'refs/heads/contribution']);
  chmodSync(path, 0o600);
  return {
    action: 'import-native-git-contribution',
    operationId,
    intentId: f.intent.id,
    expectedBase: f.intent.base,
    expectedHead: head,
    path,
    ref: 'refs/heads/contribution',
    sha256: hash(readFileSync(path)),
    name,
  };
}
const code = expected => error => error.code === expected;

test(
  'native Git bundle import preserves lost-reply creating recovery, dirty bytes, stale-owner protection and exact request reconciliation',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f, { signed: true }),
      revision = f.data().revision,
      before = f.data();
    const save = f.w.store.save.bind(f.w.store);
    let creatingSaved = false;
    f.w.store.save = data => {
      save(data);
      if (!creatingSaved) {
        creatingSaved = true;
        throw Error('lost creating reply');
      }
    };
    await assert.rejects(importNativeGitContribution(f.w.store, command, revision), /lost creating reply/);
    f.w.store.save = save;
    assert.equal(f.data().lanes.at(-1).state, 'creating');
    assert.equal(f.data().nativeContributionReceipts[0].request, nativeGitContributionRequest(command));
    const replay = await importNativeGitContribution(
      f.w.store,
      { ...command, path: '/missing-transient-bundle' },
      0,
    );
    assert.equal(replay.result.state, 'active');
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    assert.deepEqual(f.data().channelMoves, before.channelMoves);
    assert.deepEqual(f.data().runs, before.runs);
    await assert.rejects(
      importNativeGitContribution(f.w.store, { ...command, name: 'Another request' }, 0),
      code('WORK_OPERATION_CHANGED'),
    );
    const bytes = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await importNativeGitContribution(f.w.store, { ...command, path: '/still-missing' }, 0);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), bytes);
    const projected = await exportNativeGit(f.root, replay.result.head, join(f.dir, 'signed-projection'));
    assert.equal(
      await git(join(projected.path, 'repository.git'), ['cat-file', 'commit', command.expectedHead]),
      await git(f.client, ['cat-file', 'commit', command.expectedHead]),
    );
    assert.deepEqual(
      f.source.object(f.data().nativeContributionReceipts[0].inputSha256),
      readFileSync(command.path),
    );
    const next = { ...command, operationId: randomUUID() },
      starting = f.data().revision,
      pending = importNativeGitContribution(f.w.store, next, starting);
    f.act({
      action: 'note',
      intentId: f.intent.id,
      kind: 'decision',
      text: 'Preserve concurrent original note',
    });
    const changed = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await assert.rejects(pending, code('WORK_STALE'));
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), changed);
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    let saves = 0;
    f.w.store.save = data => {
      saves++;
      if (saves === 2) throw Error('lost active registration');
      save(data);
    };
    await assert.rejects(
      importNativeGitContribution(f.w.store, next, f.data().revision),
      /lost active registration/,
    );
    f.w.store.save = save;
    assert.equal(f.data().lanes.at(-1).state, 'creating');
    const dirtyPath = join(f.w.store.path(next.operationId), 'a.ts');
    writeFileSync(dirtyPath, 'preserve later interrupted edit');
    const dirtyWork = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await assert.rejects(
      importNativeGitContribution(f.w.store, { ...next, path: '/missing' }, 0),
      code('LANE_UNAVAILABLE'),
    );
    assert.equal(readFileSync(dirtyPath, 'utf8'), 'preserve later interrupted edit');
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), dirtyWork);
  },
);

test(
  'full format6 recovery and ordinary native operations keep Git optional; receipts/projections/input bundles survive collection',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t, 'sha256'),
      command = await candidate(f),
      imported = (await f.w.dispatch(command, f.data().revision)).result;
    const receipt = f.data().nativeContributionReceipts[0],
      bin = join(f.dir, 'no-git'),
      used = join(bin, 'used');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${used}'\nexit 91\n`, { mode: 0o700 });
    for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const priorPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const selected = (await exportNativeSource(f.w.store, f.data().revision, imported.head)).result;
      const sourceTarget = join(f.dir, 'source-only');
      await restoreNativeWork(selected.archive.path, sourceTarget);
      const sourceOwner = new WorkService(sourceTarget);
      assert.equal(sourceOwner.store.load().schema, 1);
      assert.deepEqual(sourceOwner.store.load().nativeContributionReceipts ?? [], []);
      assert.equal(sourceOwner.store.load().intents.length, 0);
      assert.equal(new NativeSource(sourceTarget).state(imported.head).git.commit, command.expectedHead);
      const data = f.data(),
        archive = (await f.w.dispatch({ action: 'export-work', archive: true }, data.revision)).result;
      const target = join(f.dir, 'recovered-six');
      await restoreNativeWork(archive.archive.path, target);
      const recovered = new WorkService(target);
      assert.equal(recovered.store.load().schema, 6);
      assert.deepEqual(recovered.store.load().nativeContributionReceipts, [receipt]);
      const retry = await recovered.dispatch({ ...command, path: '/missing-after-recovery' }, 0);
      assert.equal(retry.result.id, imported.id);
      await recovered.dispatch({ action: 'collect-native-objects' }, recovered.store.load().revision);
      const current = recovered.status({ compact: true });
      assert.equal(current.capabilities.nativeSource, true);
      assert.equal(existsSync(used), false);
      const own = recovered.execute(
        { action: 'intent', outcome: 'Continue Git-free after Git return' },
        recovered.store.load().revision,
      ).result;
      const lane = recovered.execute(
        { action: 'lane', intentId: own.id, name: 'Git-free native source' },
        recovered.store.load().revision,
      ).result;
      writeFileSync(join(recovered.store.path(lane.id), 'new.ts'), 'export const native=true;\n');
      const source = new NativeSource(target);
      recovered.execute(
        {
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: lane.head,
          expectedTree: source.tree(source.capture(recovered.store.path(lane.id), false, lane.head)),
          message: 'Native source after Git return',
        },
        recovered.store.load().revision,
      );
      assert.equal(existsSync(used), false);
      for (const id of [
        receipt.inputSha256,
        receipt.bundleSha256,
        receipt.projection.bundle,
        receipt.projection.mapping,
      ])
        assert.equal(existsSync(join(source.directory, id)), true);
    } finally {
      process.env.PATH = priorPath;
    }
  },
);

test(
  'unknown actual Git push reply reconciles one original native Lane without source acceptance',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      operation = randomUUID();
    writeFileSync(join(f.client, 'a.ts'), 'export const a=4;\n');
    await git(f.client, ['add', '.']);
    await git(f.client, ['commit', '-m', 'Unknown reply']);
    let dropped = false;
    const proxy = createServer((req, res) => {
      const outbound = httpRequest(
        f.u.origin + req.url,
        { method: req.method, headers: { ...req.headers, host: f.u.host } },
        incoming => {
          res.writeHead(incoming.statusCode, incoming.headers);
          let received = '';
          incoming.on('data', chunk => {
            received += chunk.toString('binary');
            if (req.url.endsWith('/git-receive-pack') && received.includes('Original source retained')) {
              dropped = true;
              res.destroy();
              incoming.destroy();
            } else res.write(chunk);
          });
          incoming.on('end', () => res.end());
          incoming.on('error', () => res.destroy());
        },
      );
      outbound.on('error', () => res.destroy());
      req.pipe(outbound);
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    t.after(() => proxy.close());
    const url = f.url(operation).replace(f.u.origin, `http://127.0.0.1:${proxy.address().port}`);
    const response = await git(f.client, [...f.auth, 'push', url, 'HEAD:refs/heads/contribution'], {
      fail: true,
    });
    assert.equal(dropped, true);
    assert.equal(response.failed, true);
    const data = f.data(),
      receipt = data.nativeContributionReceipts.find(r => r.id === operation);
    assert.ok(receipt);
    assert.equal(data.lanes.find(l => l.id === operation).state, 'active');
    const work = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution']);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), work);
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    assert.equal(f.data().channelMoves.length, 1);
  },
);

test(
  'native contribution ingress rejects unrelated scope, altered input, incompatible ancestry/formats and unsupported source without changing owner work',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f),
      originalWork = readWorkBytes(join(f.w.store.directory, 'work.json'));
    const originalObjects = readdirSync(f.source.directory).sort(),
      headers = { Authorization: `Bearer ${f.token}` },
      endpoint = f.url(randomUUID()) + 'info/refs?service=git-receive-pack';
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer unrelated' } })).status, 401);
    assert.equal(
      (await fetch(endpoint, { headers: { ...headers, Origin: 'https://unrelated.example' } })).status,
      403,
    );
    assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 400);
    const unknown =
      f.url(randomUUID(), { ...f.intent, id: randomUUID() }) + 'info/refs?service=git-receive-pack';
    assert.equal((await fetch(unknown, { headers })).status, 400);
    assert.equal(
      (await fetch(f.url(f.dirty.id) + 'info/refs?service=git-receive-pack', { headers })).status,
      400,
    );
    await assert.rejects(
      f.w.dispatch({ ...command, operationId: f.dirty.id }, f.data().revision),
      code('WORK_OPERATION_CHANGED'),
    );
    await assert.rejects(
      f.w.dispatch({ ...command, expectedBase: '0'.repeat(64) }, f.data().revision),
      code('CONTRIBUTION_CHANGED'),
    );
    await assert.rejects(
      f.w.dispatch({ ...command, sha256: '0'.repeat(64) }, f.data().revision),
      code('INVALID_CONTRIBUTION'),
    );
    await assert.rejects(
      f.w.dispatch({ ...command, ref: 'refs/heads/another' }, f.data().revision),
      code('CONTRIBUTION_CHANGED'),
    );
    const tree = (await git(f.client, ['rev-parse', 'HEAD^{tree}'])).trim(),
      unrelated = (await git(f.client, ['commit-tree', tree, '-m', 'Unrelated root'])).trim();
    await git(f.client, ['update-ref', 'refs/heads/unrelated', unrelated]);
    const path = join(f.dir, 'unrelated.bundle');
    await git(f.client, ['bundle', 'create', path, 'refs/heads/unrelated']);
    chmodSync(path, 0o600);
    await assert.rejects(
      f.w.dispatch(
        {
          ...command,
          operationId: randomUUID(),
          path,
          expectedHead: unrelated,
          ref: 'refs/heads/unrelated',
          sha256: hash(readFileSync(path)),
        },
        f.data().revision,
      ),
      code('CONTRIBUTION_CHANGED'),
    );
    await git(f.client, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${(await git(f.client, ['rev-parse', 'HEAD'])).trim()},unsupported-gitlink`,
    ]);
    await git(f.client, ['commit', '-m', 'Unsupported linked source']);
    const unsupportedHead = (await git(f.client, ['rev-parse', 'HEAD'])).trim(),
      unsupportedPath = join(f.dir, 'unsupported.bundle');
    await git(f.client, ['bundle', 'create', unsupportedPath, 'HEAD']);
    chmodSync(unsupportedPath, 0o600);
    await assert.rejects(
      f.w.dispatch(
        {
          ...command,
          operationId: randomUUID(),
          path: unsupportedPath,
          expectedHead: unsupportedHead,
          ref: 'HEAD',
          sha256: hash(readFileSync(unsupportedPath)),
        },
        f.data().revision,
      ),
      code('UNSUPPORTED_NATIVE_GIT_FILE'),
    );
    const other = join(f.dir, 'other-format');
    mkdirSync(other);
    await git(other, ['init', '--template=', '--object-format=sha256', '--initial-branch=main']);
    writeFileSync(join(other, 'a.ts'), 'unrelated sha256');
    await git(other, ['add', '.']);
    await git(other, ['commit', '-m', 'Other original format']);
    const otherHead = (await git(other, ['rev-parse', 'HEAD'])).trim(),
      otherPath = join(f.dir, 'other-format.bundle');
    await git(other, ['bundle', 'create', otherPath, 'HEAD']);
    chmodSync(otherPath, 0o600);
    await assert.rejects(
      f.w.dispatch(
        {
          ...command,
          operationId: randomUUID(),
          path: otherPath,
          expectedHead: otherHead,
          ref: 'HEAD',
          sha256: hash(readFileSync(otherPath)),
        },
        f.data().revision,
      ),
      code('WORK_GIT_FAILED'),
    );
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), originalWork);
    assert.deepEqual(readdirSync(f.source.directory).sort(), originalObjects);
    assert.equal(
      readdirSync(f.w.store.directory).some(p => p.startsWith('native-git-receive-')),
      false,
    );
  },
);

test(
  'native wire rejects other refs, deletion and an altered original candidate; retained raw pins cannot become authority',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f),
      operation = randomUUID(),
      before = readWorkBytes(join(f.w.store.directory, 'work.json'));
    const wrongRef = await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/another'], {
      fail: true,
    });
    assert.equal(wrongRef.failed, true);
    assert.match(wrongRef.stderr, /CONTRIBUTION_CHANGED/);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
    const multi = await git(
      f.client,
      [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution', 'HEAD:refs/heads/another'],
      { fail: true },
    );
    assert.equal(multi.failed, true);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
    await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution']);
    const retained = readWorkBytes(join(f.w.store.directory, 'work.json')),
      receipt = f.data().nativeContributionReceipts.find(r => r.id === operation);
    const deletion = await git(f.client, [...f.auth, 'push', f.url(operation), ':refs/heads/contribution'], {
      fail: true,
    });
    assert.equal(deletion.failed, true);
    assert.match(deletion.stderr, /CONTRIBUTION_CHANGED/);
    writeFileSync(join(f.client, 'a.ts'), 'altered same operation');
    await git(f.client, ['add', '.']);
    await git(f.client, ['commit', '-m', 'Different candidate']);
    const changed = await git(
      f.client,
      [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution'],
      { fail: true },
    );
    assert.equal(changed.failed, true);
    assert.match(changed.stderr, /WORK_OPERATION_CHANGED/);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), retained);
    assert.equal(existsSync(join(f.w.store.directory, `native-git-return-${operation}.bundle`)), false);
    const body = f.source.object(receipt.inputSha256);
    writeFileSync(join(f.source.directory, receipt.inputSha256), Buffer.from('corrupt original input'));
    await assert.rejects(f.w.dispatch({ action: 'collect-native-objects' }, f.data().revision), error =>
      ['INVALID_NATIVE_SOURCE', 'INVALID_NATIVE_GIT'].includes(error.code),
    );
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), retained);
    writeFileSync(join(f.source.directory, receipt.inputSha256), body);
    const forged = f.data();
    forged.nativeContributionReceipts.find(r => r.id === operation).bundleSha256 = receipt.projection.bundle;
    const { validateNativeContributions } = await import('../dist/native-contribution-objects.js');
    assert.throws(() => validateNativeContributions(f.source, forged), code('INVALID_NATIVE_GIT'));
    assert.equal(command.expectedBase, receipt.base);
  },
);

test(
  'real local MCP and CLI select native Git return and reconcile its original source after losing the input path',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f),
      client = new Client({ name: 'native-git-return-proof', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    });
    await client.connect(transport);
    t.after(() => client.close());
    const reply = await client.callTool({
      name: 'forge_work_command',
      arguments: { command, revision: f.data().revision },
    });
    assert.equal(reply.isError, undefined);
    assert.equal(JSON.parse(reply.content[0].text).result.id, command.operationId);
    const file = join(f.dir, 'original-command.json');
    writeFileSync(file, JSON.stringify({ ...command, path: '/input-no-longer-present' }), { mode: 0o600 });
    const output = JSON.parse(
      execFileSync(node, [resolve('dist/cli.js'), 'work', f.root, '--command-file', file, '0'], {
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.equal(output.result.id, command.operationId);
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    assert.equal(f.data().channelMoves.length, 1);
  },
);

test(
  'unchanged projected Git base can return through plain, SHA1 and SHA256 native owners without corrupting receipt closure',
  { timeout: 120000 },
  async t => {
    for (const kind of ['plain', 'sha1', 'sha256']) {
      const f = await fixture(t, kind),
        operation = randomUUID(),
        head = (await git(f.client, ['rev-parse', 'HEAD'])).trim(),
        before = f.data();
      await git(f.client, [...f.auth, 'push', f.url(operation), 'HEAD:refs/heads/contribution']);
      const receipt = f.data().nativeContributionReceipts.find(r => r.id === operation);
      assert.equal(receipt.gitHead, head);
      assert.equal(receipt.gitBase, head);
      if (kind !== 'plain') {
        assert.equal(receipt.head, receipt.base);
        assert.notEqual(f.source.state(receipt.head).git.bundle, receipt.bundleSha256);
      }
      assert.deepEqual(f.data().channelMoves, before.channelMoves);
      await f.w.dispatch({ action: 'collect-native-objects' }, f.data().revision);
      const archive = (await f.w.dispatch({ action: 'export-work', archive: true }, f.data().revision))
          .result,
        target = join(f.dir, 'unchanged-recovery');
      await restoreNativeWork(archive.archive.path, target);
      const restored = new WorkService(target);
      assert.deepEqual(restored.store.load().nativeContributionReceipts, [receipt]);
      assert.equal(readFileSync(join(restored.store.path(operation), 'a.ts'), 'utf8'), 'export const a=1;\n');
    }
  },
);
