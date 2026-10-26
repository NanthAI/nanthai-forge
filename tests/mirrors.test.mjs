// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serveRepository } from '../dist/http.js';
import { git, code } from './helpers.mjs';
import { setup } from './publication-fixture.mjs';

async function mirrorSetup(t, options = {}) {
  const s = setup(t, options);
  const acceptance = (
    await s.work.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'mirror-test',
        viewId: s.view.id,
        expectedHead: s.view.head,
        expectedPrevious: null,
      },
      s.work.status().revision,
    )
  ).result;
  const command = {
    action: 'mirror-channel',
    operationId: randomUUID(),
    acceptanceId: acceptance.id,
    expectedHead: acceptance.head,
    repository: 'tests/example',
  };
  return {
    ...s,
    acceptance,
    mirrorCommand: command,
    mirror: (input = command, revision = s.work.status().revision) => s.work.dispatch(input, revision),
  };
}

test('accepted-source GitHub mirrors reconcile native lost replies, preserve full history and never rewrite confirmed missing or divergent refs', async t => {
  const s = await mirrorSetup(t, { lostPush: true });
  const original = git(s.root, ['rev-parse', 'HEAD']).trim(),
    main = git(s.remote, ['rev-parse', 'main']).trim();
  const first = (await s.mirror()).result;
  assert.equal(first.observation.status, 'matching');
  assert.ok(first.confirmedAt);
  assert.equal(first.repositoryId, 77);
  assert.equal(git(s.remote, ['rev-parse', first.ref]).trim(), s.acceptance.head);
  assert.equal(git(s.remote, ['show', first.ref + ':a.ts']), 'export const a = 2;\n');
  s.checkpoint('export const a = 3;\n');
  assert.equal((await s.mirror(s.mirrorCommand, 0)).result.id, first.id);
  git(s.remote, ['update-ref', first.ref, main]);
  assert.equal(
    (await s.mirror({ action: 'check-mirror', id: first.id }, 0)).result.observation.status,
    'diverged',
  );
  assert.equal((await s.mirror(s.mirrorCommand, 0)).result.observation.status, 'diverged');
  assert.equal(git(s.remote, ['rev-parse', first.ref]).trim(), main);
  git(s.remote, ['update-ref', '-d', first.ref]);
  assert.equal((await s.mirror(s.mirrorCommand, 0)).result.observation.status, 'missing');
  assert.ok((await s.mirror({ action: 'check-mirror', id: first.id }, 0)).result.confirmedAt);
  assert.throws(() => git(s.remote, ['show-ref', '--verify', '--quiet', first.ref]));
  assert.equal(git(s.remote, ['rev-parse', 'main']).trim(), main);
  assert.equal(git(s.root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(s.work.status().channels.find(item => item.name === 'mirror-test').head, s.acceptance.head);
  assert.equal(s.state().creates, 0);
  assert.equal(
    readdirSync(s.work.store.directory).filter(
      name => name.startsWith('publish-') || name.startsWith('channel-'),
    ).length,
    0,
  );
});

test('native mirror journal recovery, current destination authority and immutable source scopes survive failures', async t => {
  const s = await mirrorSetup(t);
  await assert.rejects(s.mirror(s.mirrorCommand, 0), code('WORK_STALE'));
  await assert.rejects(s.mirror({ ...s.mirrorCommand, expectedHead: '0'.repeat(40) }), code('NOT_FOUND'));
  s.change({ denied: true });
  await assert.rejects(s.mirror(), code('GITHUB_WRITE_DENIED'));
  s.change({ denied: false });
  s.change({ writePermission: 'true' });
  await assert.rejects(s.mirror(), code('GITHUB_WRITE_DENIED'));
  s.change({ writePermission: null });
  const save = s.work.store.save.bind(s.work.store);
  let failed = false;
  s.work.store.save = data => {
    if (!failed && data.mirrors[0]?.confirmedAt) {
      failed = true;
      throw new Error('Simulated lost mirror metadata reply');
    }
    save(data);
  };
  await assert.rejects(s.mirror(), /Simulated lost mirror metadata reply/);
  s.work.store.save = save;
  const first = (await s.mirror(s.mirrorCommand, 0)).result;
  assert.equal(first.observation.status, 'matching');
  assert.equal(s.work.status().mirrors.length, 1);
  await assert.rejects(
    s.mirror({ ...s.mirrorCommand, expectedHead: '0'.repeat(40) }, 0),
    code('MIRROR_CHANGED'),
  );
  s.change({ repositoryId: 88 });
  await assert.rejects(s.mirror(s.mirrorCommand, 0), code('MIRROR_CHANGED'));
  await assert.rejects(s.mirror({ action: 'check-mirror', id: first.id }, 0), code('MIRROR_CHANGED'));
  s.change({ repositoryId: 77 });
  s.change({ denied: true });
  await assert.rejects(s.mirror(s.mirrorCommand, 0), code('GITHUB_WRITE_DENIED'));
  assert.equal(
    (await s.mirror({ action: 'check-mirror', id: first.id }, 0)).result.observation.status,
    'matching',
  );
  assert.equal(s.work.status().mirrors.length, 1);
  assert.equal(s.state().creates, 0);
});

test('mirrors use the existing protected local HTTP, native CLI and opt-in SDK MCP transport', async t => {
  const s = await mirrorSetup(t),
    server = await serveRepository(s.root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    body = JSON.stringify({ command: s.mirrorCommand, revision: s.work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  const mirrored = (await response.json()).result;
  assert.equal(mirrored.observation.status, 'matching');
  const check = { action: 'check-mirror', id: mirrored.id };
  const read = JSON.parse(
    execFileSync(process.execPath, ['dist/cli.js', 'work', s.root, JSON.stringify(check), '0'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(read.result.observation.status, 'matching');
  const client = new Client({ name: 'forge-mirror-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/cli.js', 'mcp', s.root, '--work'],
      env: process.env,
      stderr: 'pipe',
    }),
  );
  const reply = JSON.parse(
    (
      await client.callTool({
        name: 'forge_work_command',
        arguments: { command: s.mirrorCommand, revision: 0 },
      })
    ).content[0].text,
  );
  assert.equal(reply.result.id, mirrored.id);
  assert.equal(s.work.status().mirrors.length, 1);
  assert.equal(s.state().creates, 0);
});

test('concurrent mirror requests and delayed provider reads preserve one mapping and the latest observation', async t => {
  const s = await mirrorSetup(t),
    revision = s.work.status().revision;
  const replies = await Promise.all([
    s.mirror(s.mirrorCommand, revision),
    s.mirror(s.mirrorCommand, revision),
    s.mirror(s.mirrorCommand, revision),
  ]);
  assert.equal(new Set(replies.map(reply => reply.result.id)).size, 1);
  assert.equal(s.work.status().mirrors.length, 1);
  const mirror = s.work.status().mirrors[0],
    check = { action: 'check-mirror', id: mirror.id };
  s.change({ holdMirror: true, releaseMirror: false });
  const slow = s.mirror(check, 0);
  try {
    const deadline = Date.now() + 10_000;
    while (!s.state().mirrorStarted) {
      assert.ok(Date.now() < deadline, 'Native provider read started');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const other = git(s.remote, ['rev-parse', 'main']).trim();
    git(s.remote, ['update-ref', mirror.ref, other]);
    assert.equal((await s.mirror(check, 0)).result.observation.status, 'diverged');
    s.change({ releaseMirror: true });
    assert.equal((await slow).result.observation.status, 'diverged');
    assert.equal(s.work.status().mirrors[0].observation.head, other);
    assert.equal(git(s.remote, ['rev-parse', mirror.ref]).trim(), other);
  } finally {
    s.change({ releaseMirror: true });
    await slow;
  }
  assert.equal(s.state().creates, 0);
  assert.equal(s.work.status().channels.find(item => item.name === 'mirror-test').head, s.acceptance.head);
});

for (const format of ['sha1', 'sha256'])
  test(`explicit ${format} GitHub branch mirrors fast-forward with exact leases and preserve divergence`, async t => {
    const before = process.env.GIT_DEFAULT_HASH;
    process.env.GIT_DEFAULT_HASH = format;
    let s;
    try {
      s = await mirrorSetup(t, { lostPush: true });
    } finally {
      if (before === undefined) delete process.env.GIT_DEFAULT_HASH;
      else process.env.GIT_DEFAULT_HASH = before;
    }
    const original = git(s.remote, ['rev-parse', 'main']).trim();
    const command = { ...s.mirrorCommand, destination: { branch: 'main', previous: original } };
    const revision = s.work.status().revision;
    await assert.rejects(s.mirror({ ...command, destination: { branch: '../main', previous: original } }));
    assert.equal(s.work.status().revision, revision);
    assert.equal(s.work.status().mirrors.length, 0);
    const first = (await s.mirror(command)).result;
    assert.equal(first.ref, 'refs/heads/main');
    assert.equal(first.observation.status, 'matching');
    assert.ok(first.confirmedAt);
    assert.equal(git(s.remote, ['rev-parse', 'main']).trim(), s.acceptance.head);
    assert.equal(git(s.remote, ['show', 'main:a.ts']), 'export const a = 2;\n');
    assert.equal((await s.mirror(command, 0)).result.id, first.id);
    await assert.rejects(
      s.mirror({ ...command, destination: { branch: 'other', previous: original } }, 0),
      code('MIRROR_CHANGED'),
    );
    const later = s.checkpoint('export const a = 3;\n').head;
    git(s.root, ['push', s.remote, `${later}:refs/heads/main`]);
    assert.equal((await s.mirror(command, 0)).result.observation.status, 'diverged');
    assert.equal(git(s.remote, ['rev-parse', 'main']).trim(), later);
    const rollback = (
      await s.mirror({
        ...command,
        operationId: randomUUID(),
        destination: { branch: 'main', previous: later },
      })
    ).result;
    assert.equal(rollback.diagnostic, 'non-fast-forward');
    assert.equal(rollback.confirmedAt, undefined);
    assert.equal(
      (await s.mirror({ action: 'check-mirror', id: rollback.id }, 0)).result.diagnostic,
      'non-fast-forward',
    );
    assert.equal(git(s.remote, ['rev-parse', 'main']).trim(), later);
    const missing = (
      await s.mirror({
        ...command,
        operationId: randomUUID(),
        destination: { branch: 'missing', previous: original },
      })
    ).result;
    assert.equal(missing.diagnostic, 'lease-changed');
    assert.equal(missing.observation.status, 'missing');
    const fresh = (
      await s.mirror({
        ...command,
        operationId: randomUUID(),
        destination: { branch: 'selected-new', previous: null },
      })
    ).result;
    assert.equal(fresh.observation.status, 'matching');
    assert.equal(git(s.remote, ['rev-parse', 'selected-new']).trim(), s.acceptance.head);
    git(s.remote, ['update-ref', '-d', 'refs/heads/selected-new']);
    assert.equal(
      (await s.mirror({ ...command, operationId: fresh.id, destination: fresh.destination }, 0)).result
        .observation.status,
      'missing',
    );
    assert.throws(() => git(s.remote, ['rev-parse', '--verify', 'selected-new']));
    assert.equal(s.work.status().channels.find(x => x.name === 'mirror-test').head, s.acceptance.head);
    assert.equal(s.state().creates, 0);
  });

test('a remote update between mirror observation and push survives the native lease', async t => {
  const s = await mirrorSetup(t),
    original = git(s.remote, ['rev-parse', 'main']).trim();
  const later = s.checkpoint('export const a = 3;\n').head;
  git(s.root, ['push', s.remote, `${later}:refs/heads/race-source`]);
  s.change({ mirrorRace: true, raceRef: 'refs/heads/main', raceHead: later });
  const command = { ...s.mirrorCommand, destination: { branch: 'main', previous: original } };
  const mirror = (await s.mirror(command)).result;
  assert.equal(mirror.confirmedAt, undefined);
  assert.equal(mirror.diagnostic, 'lease-changed');
  assert.equal(mirror.observation.head, later);
  assert.equal(git(s.remote, ['rev-parse', 'main']).trim(), later);
  assert.equal((await s.mirror(command, 0)).result.observation.head, later);
  assert.equal(s.work.status().channels.find(x => x.name === 'mirror-test').head, s.acceptance.head);
});
