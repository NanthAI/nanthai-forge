// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { WorkService } from '../dist/work.js';
import { workGit } from '../dist/work-git.js';
import { serveRepository } from '../dist/http.js';
import { fixture, write } from './helpers.mjs';

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
    execFile(
      'git',
      ['-C', root, ...args],
      {
        env,
        encoding: 'utf8',
        timeout: Number(process.env.FORGE_GIT_TIMEOUT_MS ?? 60000),
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Native Git client failed (${error.code}, signal=${error.signal ?? 'none'}, Forge codes=${[...stderr.matchAll(/\[([A-Z][A-Z_]+)\]/g)].map(match => match[1]).join(',') || 'none'}); credentials and source output withheld.`,
            ),
          );
        else resolve(stdout.trim());
      },
    );
  });
}
for (const format of ['sha1', 'sha256'])
  test(`native protected Git HTTP ${format} clone/fetch preserves full original history and rejects unsupported writes without changing source`, async t => {
    const root = fixture(t),
      destination = fixture(t);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    workGit(root, ['init', '--object-format=' + format, '--initial-branch=main', '--template=']);
    write(root, 'a.ts', 'export const original = 1;\n');
    write(root, '.env', 'SYNTHETIC_ONLY=original\n');
    write(root, '.github/hidden.txt', 'Full original accepted source');
    const binary = randomBytes(5 * 1024 * 1024);
    write(root, 'large.bin', binary);
    workGit(root, ['add', '.']);
    workGit(root, ['commit', '-m', 'Original full source']);
    const work = new WorkService(root),
      local = input => work.execute(input, work.status().revision).result;
    const intent = local({ action: 'intent', outcome: 'Native accepted-source clone' }),
      lane = local({ action: 'lane', intentId: intent.id, name: 'Keep unfinished work' });
    const firstView = local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
    const firstId = randomUUID();
    await work.dispatch(
      {
        action: 'accept-channel',
        operationId: firstId,
        channel: 'main',
        viewId: firstView.id,
        expectedHead: firstView.head,
        expectedPrevious: null,
      },
      work.status().revision,
    );
    const unrelatedBlob = workGit(root, ['hash-object', '-w', '--stdin'], 'Unaccepted hidden source').trim();
    const unrelatedTree = workGit(root, ['mktree'], `100644 blob ${unrelatedBlob}\tunaccepted.txt\n`).trim();
    const unrelated = workGit(
      root,
      ['commit-tree', unrelatedTree, '-p', firstView.head],
      'Unrelated unaccepted source',
    ).trim();
    workGit(root, ['update-ref', 'refs/forge/channels/unrelated', unrelated]);
    const server = await serveRepository(root, 0);
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.port}/api/git/${firstId}/`,
      advertisement = `${url}info/refs?service=git-upload-pack`;
    const alias = `http://127.0.0.1:${server.port}/api/git/channel/main/`;
    assert.equal((await fetch(advertisement)).status, 401);
    assert.equal(
      (
        await fetch(advertisement, {
          headers: { Authorization: `Bearer ${server.token}`, Origin: 'https://outside.invalid' },
        })
      ).status,
      403,
    );
    const headers = { Authorization: `Bearer ${server.token}` };
    assert.equal((await fetch(alias + 'info/refs?service=git-upload-pack')).status, 401);
    assert.equal(
      (
        await fetch(alias + 'info/refs?service=git-upload-pack', {
          headers: { ...headers, Origin: 'https://outside.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(alias.replace('main/', 'missing/') + 'info/refs?service=git-upload-pack', { headers }))
        .status,
      404,
    );
    assert.equal((await fetch(url + 'info/refs?service=git-receive-pack', { headers })).status, 400);
    assert.equal((await fetch(url + 'git-receive-pack', { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(url + 'objects/info/packs', { headers })).status, 404);
    assert.equal(
      (await fetch(url + 'git-upload-pack', { method: 'POST', headers, body: 'Unrecognized input' })).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${server.port}/api/git/${randomUUID()}/info/refs?service=git-upload-pack`,
          { headers },
        )
      ).status,
      404,
    );
    const metadata = readWorkBytes(join(work.store.directory, 'work.json'));
    await client(
      destination,
      ['clone', '--template=', '--branch', 'accepted', '--', url, 'original-copy'],
      server.token,
    );
    const copy = join(destination, 'original-copy');
    await client(
      destination,
      ['clone', '--template=', '--branch', 'accepted', '--', alias, 'moving-copy'],
      server.token,
    );
    const moving = join(destination, 'moving-copy');
    assert.equal(workGit(moving, ['rev-parse', 'HEAD']).trim(), firstView.head);
    assert.throws(() => workGit(moving, ['cat-file', '-e', unrelated]));
    await assert.rejects(
      client(moving, ['fetch', 'origin', unrelated], server.token),
      /Native Git client failed/,
    );
    assert.equal(
      (await fetch(alias.replace('main/', 'unrelated/') + 'info/refs?service=git-upload-pack', { headers }))
        .status,
      404,
    );
    assert.equal(workGit(copy, ['rev-parse', 'HEAD']).trim(), firstView.head);
    assert.equal(workGit(copy, ['rev-parse', '--show-object-format']).trim(), format);
    assert.equal(readFileSync(join(copy, '.env'), 'utf8'), 'SYNTHETIC_ONLY=original\n');
    assert.deepEqual(readFileSync(join(copy, 'large.bin')), binary);
    assert.equal(readFileSync(join(copy, '.github/hidden.txt'), 'utf8'), 'Full original accepted source');
    assert.equal(workGit(copy, ['log', '--format=%H']).trim(), workGit(root, ['log', '--format=%H']).trim());
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), metadata);
    const path = work.store.path(lane.id);
    write(path, 'a.ts', 'export const original = 2;\n');
    workGit(path, ['add', 'a.ts']);
    const row = work.status().lanes[0];
    local({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: row.actualHead,
      expectedTree: row.indexTree,
      message: 'Next accepted candidate',
    });
    const current = work.status().lanes[0],
      nextView = local({
        action: 'compose',
        intentId: intent.id,
        inputs: [{ laneId: lane.id, head: current.head }],
      });
    const nextId = randomUUID();
    await work.dispatch(
      {
        action: 'accept-channel',
        operationId: nextId,
        channel: 'main',
        viewId: nextView.id,
        expectedHead: nextView.head,
        expectedPrevious: firstView.head,
      },
      work.status().revision,
    );
    write(root, 'unfinished.txt', 'Keep original dirty root');
    write(path, 'a.ts', 'Keep original dirty Lane');
    // Target hooks/config/replacement objects are outside the isolated native transport; source text is never executed.
    write(root, '.git/hooks/post-upload-pack', '#!/bin/sh\ntouch executed-gateway-hook\n');
    workGit(root, ['config', 'uploadpack.packObjectsHook', 'touch executed-gateway-hook']);
    const before = readWorkBytes(join(work.store.directory, 'work.json')),
      originalIndex = workGit(root, ['write-tree']),
      originalHead = workGit(root, ['rev-parse', 'HEAD']);
    await client(copy, ['fetch', 'origin'], server.token);
    assert.equal(workGit(copy, ['rev-parse', 'origin/accepted']).trim(), firstView.head);
    const nextUrl = `http://127.0.0.1:${server.port}/api/git/${nextId}/`;
    await client(copy, ['fetch', nextUrl, 'accepted:refs/remotes/new/accepted'], server.token);
    assert.equal(workGit(copy, ['rev-parse', 'new/accepted']).trim(), nextView.head);
    assert.equal(workGit(copy, ['rev-parse', 'HEAD']).trim(), firstView.head);
    assert.equal(workGit(copy, ['merge-base', '--is-ancestor', firstView.head, nextView.head]), '');
    await client(moving, ['fetch', 'origin'], server.token);
    assert.equal(workGit(moving, ['rev-parse', 'origin/accepted']).trim(), nextView.head);
    assert.equal(
      workGit(moving, ['rev-parse', 'HEAD']).trim(),
      firstView.head,
      'Fetching never moves the client checkout.',
    );
    assert.equal(workGit(moving, ['rev-parse', `origin/acceptances/${firstId}`]).trim(), firstView.head);
    if (format === 'sha1')
      assert.equal(
        await client(destination, ['-c', 'protocol.version=0', 'ls-remote', '--heads', url], server.token),
        `${firstView.head}\trefs/heads/accepted`,
      );
    await assert.rejects(
      client(copy, ['push', url, 'HEAD:refs/heads/accepted'], server.token),
      /Native Git client failed/,
    );
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
    assert.equal(workGit(root, ['rev-parse', 'HEAD']), originalHead);
    assert.equal(workGit(root, ['write-tree']), originalIndex);
    assert.equal(readFileSync(join(root, 'unfinished.txt'), 'utf8'), 'Keep original dirty root');
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'Keep original dirty Lane');
    assert(!readdirSync(root).includes('executed-gateway-hook'));
    assert(
      !readdirSync(work.store.directory).some(
        name => name.startsWith('channel-') || name.startsWith('publish-'),
      ),
    );
    assert.equal(work.status().channels[0].head, nextView.head);
    // Git advertised the newer commit, then the owner rolled back before upload-pack.
    // Retained acceptance refs keep that exact advertised source fetchable in the next request.
    const advertised = await fetch(alias + 'info/refs?service=git-upload-pack', { headers });
    assert.equal(advertised.status, 200);
    assert((await advertised.text()).includes(nextView.head));
    await work.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: firstView.id,
        expectedHead: firstView.head,
        expectedPrevious: nextView.head,
      },
      work.status().revision,
    );
    const rolledBack = readWorkBytes(join(work.store.directory, 'work.json'));
    const packet = text => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
    const response = await fetch(alias + 'git-upload-pack', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-git-upload-pack-request' },
      body: packet(`want ${nextView.head} object-format=${format}\n`) + '0000' + packet('done\n'),
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()),
      offset = bytes.indexOf('PACK');
    assert(offset >= 0);
    const packDestination = fixture(t);
    rmSync(join(packDestination, '.git'), { recursive: true, force: true });
    workGit(packDestination, ['init', '--bare', '--object-format=' + format, '--template=']);
    workGit(packDestination, ['index-pack', '--stdin'], bytes.subarray(offset));
    assert.equal(workGit(packDestination, ['show', `${nextView.head}:a.ts`]), 'export const original = 2;\n');
    await client(moving, ['fetch', 'origin'], server.token);
    assert.equal(workGit(moving, ['rev-parse', 'origin/accepted']).trim(), firstView.head);
    assert.equal(workGit(moving, ['rev-parse', `origin/acceptances/${nextId}`]).trim(), nextView.head);
    assert.equal(workGit(moving, ['rev-parse', 'HEAD']).trim(), firstView.head);
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), rolledBack);
    await assert.rejects(
      client(moving, ['push', 'origin', 'HEAD:refs/heads/accepted'], server.token),
      /Native Git client failed/,
    );
    // A raw unreceipted pointer/changed retained receipt never masquerades as verified acceptance.
    const channelRef = 'refs/forge/channels/main',
      receipt = `refs/forge/channel-moves/${nextId}`;
    workGit(root, ['update-ref', channelRef, nextView.head, firstView.head]);
    workGit(root, ['update-ref', receipt, firstView.head, nextView.head]);
    assert.equal((await fetch(alias + 'info/refs?service=git-upload-pack', { headers })).status, 404);
    workGit(root, ['update-ref', channelRef, firstView.head, nextView.head]);
    assert.equal((await fetch(alias + 'info/refs?service=git-upload-pack', { headers })).status, 400);
    const intact = await fetch(advertisement, { headers });
    assert.equal(
      intact.status,
      200,
      'Original immutable receipt remains available despite another history receipt changing.',
    );
    await intact.arrayBuffer();
    workGit(root, ['update-ref', receipt, nextView.head, firstView.head]);
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), rolledBack);
    assert.equal(workGit(root, ['rev-parse', 'HEAD']), originalHead);
    assert.equal(workGit(root, ['write-tree']), originalIndex);
    assert.equal(readFileSync(join(root, 'unfinished.txt'), 'utf8'), 'Keep original dirty root');
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'Keep original dirty Lane');
    const scratch = () =>
      readdirSync(work.store.directory).some(
        name => name.startsWith('channel-') || name.startsWith('publish-'),
      );
    for (let i = 0; i < 100 && scratch(); i++) await setTimeout(20); // Wait for native child close and ordinary request cleanup, not only response headers.
    assert(!scratch());
  });

for (const format of ['sha1', 'sha256'])
  test(`native protected ${format} Git push journals one full original contribution Lane before acknowledgment without accepting source`, async t => {
    // check-runtime disables lock waits for synthetic busy-lock tests. Real concurrent
    // receive hooks must wait through bakery admission, including a peer choosing its ticket.
    const priorWait = process.env.FORGE_WORK_LOCK_WAIT_MS;
    process.env.FORGE_WORK_LOCK_WAIT_MS = '60000';
    t.after(() => {
      if (priorWait === undefined) delete process.env.FORGE_WORK_LOCK_WAIT_MS;
      else process.env.FORGE_WORK_LOCK_WAIT_MS = priorWait;
    });
    const root = fixture(t),
      destination = fixture(t);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    workGit(root, ['init', '--object-format=' + format, '--initial-branch=main', '--template=']);
    write(root, 'a.ts', 'export const original = 1;\n');
    write(root, '.env', 'SYNTHETIC_ONLY=hidden_history\n');
    workGit(root, ['add', '.']);
    workGit(root, ['commit', '-m', 'Original full history']);
    workGit(root, ['rm', '.env']);
    workGit(root, ['commit', '-m', 'Current original source']);
    const w = new WorkService(root),
      local = input => w.execute(input, w.status().revision).result;
    const intent = local({ action: 'intent', outcome: 'Native returned contribution' }),
      original = local({ action: 'lane', intentId: intent.id, name: 'Preserve original Lane' });
    const view = local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: original.id, head: original.head }],
    });
    const acceptedId = randomUUID();
    await w.dispatch(
      {
        action: 'accept-channel',
        operationId: acceptedId,
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      },
      w.status().revision,
    );
    write(root, 'dirty-root.txt', 'Original root work');
    write(w.store.path(original.id), 'dirty-lane.txt', 'Original Lane work');
    write(root, '.git/hooks/pre-receive', '#!/bin/sh\ntouch ' + root + '/root-hook-ran\n');
    chmodSync(join(root, '.git/hooks/pre-receive'), 0o700);
    const baseline = w.store.load(),
      originalIndex = workGit(root, ['write-tree']),
      originalHead = workGit(root, ['rev-parse', 'HEAD']);
    const operationId = randomUUID(),
      server = await serveRepository(root, 0);
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.port}/api/git/contribute/${intent.id}/${operationId}/${intent.base}/`,
      headers = { Authorization: `Bearer ${server.token}` };
    assert.equal((await fetch(url + 'info/refs?service=git-receive-pack')).status, 401);
    assert.equal(
      (
        await fetch(url + 'info/refs?service=git-receive-pack', {
          headers: { ...headers, Origin: 'https://outside.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url.replace(intent.id, randomUUID()) + 'info/refs?service=git-upload-pack', { headers }))
        .status,
      400,
    );
    await client(destination, ['clone', '--template=', '--', url, 'contributor'], server.token);
    const copy = join(destination, 'contributor'),
      history = workGit(copy, ['rev-parse', 'HEAD~1']).trim();
    assert.equal(workGit(copy, ['rev-parse', 'HEAD']).trim(), intent.base);
    assert.equal(workGit(copy, ['show', history + ':.env']), 'SYNTHETIC_ONLY=hidden_history\n');
    const pack = randomBytes(5 * 1024 * 1024);
    write(copy, 'a.ts', 'export const original = 2;\n');
    write(copy, 'new-large.bin', pack);
    workGit(copy, ['add', '.']);
    workGit(copy, ['commit', '-m', 'Original returned source']);
    const head = workGit(copy, ['rev-parse', 'HEAD']).trim(),
      commit = workGit(copy, ['cat-file', 'commit', head]);
    await assert.rejects(client(copy, ['push', 'origin', 'HEAD:refs/heads/main'], server.token));
    assert.deepEqual(w.store.load(), baseline, 'An unsupported destination creates no Lane or acceptance.');
    const push = async () => {
      await client(copy, ['push', 'origin', 'HEAD:refs/heads/contribution'], server.token);
      // Observe the journal at acknowledgment, before either reconciliation retry.
      const lane = w.store.load().lanes.find(item => item.id === operationId);
      return {
        lane,
        workspaceHead:
          lane?.state === 'active' ? workGit(w.store.path(lane.id), ['rev-parse', 'HEAD']).trim() : undefined,
      };
    };
    const concurrent = await Promise.allSettled([push(), push()]);
    assert(
      concurrent.some(result => result.status === 'fulfilled'),
      `At least one original native push completes; another reply may require reconciliation. ${concurrent
        .filter(result => result.status === 'rejected')
        .map(result => result.reason.message)
        .join(' ')}`,
    );
    for (const result of concurrent.filter(result => result.status === 'fulfilled')) {
      assert.equal(result.value.lane?.state, 'active', 'The Lane is journaled before acknowledgment.');
      assert.equal(result.value.lane?.contribution.head, head);
      assert.equal(result.value.workspaceHead, head, 'The Lane is usable before acknowledgment.');
    }
    const lane = w.store.load().lanes.find(item => item.id === operationId);
    assert(lane);
    assert.equal(lane.state, 'active');
    assert.equal(lane.contribution.head, head);
    assert.equal(lane.contribution.base, intent.base);
    assert.equal(lane.contribution.provenance, 'unverified-git-bundle');
    assert.equal(workGit(root, ['cat-file', 'commit', head]), commit);
    assert.deepEqual(readFileSync(join(w.store.path(lane.id), 'new-large.bin')), pack);
    assert.equal(
      workGit(w.store.path(lane.id), ['show', history + ':.env']),
      'SYNTHETIC_ONLY=hidden_history\n',
    );
    assert.equal(
      workGit(w.store.path(lane.id), ['rev-parse', 'HEAD']).trim(),
      head,
      'The durable Lane is usable before native push returns.',
    );
    const after = readWorkBytes(join(w.store.directory, 'work.json'));
    await client(copy, ['push', 'origin', 'HEAD:refs/heads/contribution'], server.token);
    assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), after);
    await client(copy, ['fetch', 'origin'], server.token);
    assert.equal(workGit(copy, ['rev-parse', 'origin/contribution']).trim(), head);
    const pending = w.store.load();
    pending.lanes.find(item => item.id === operationId).state = 'creating';
    pending.revision++;
    w.store.save(pending);
    const advertisement = await fetch(url + 'info/refs?service=git-receive-pack', { headers });
    assert.equal(advertisement.status, 200);
    assert(
      !(await advertisement.text()).includes('refs/heads/contribution'),
      'An unfinished Lane is not advertised as an acknowledged contribution.',
    );
    await client(copy, ['push', 'origin', 'HEAD:refs/heads/contribution'], server.token);
    assert.equal(w.store.load().lanes.find(item => item.id === operationId).state, 'active');
    assert.equal(w.store.load().lanes.filter(item => item.id === operationId).length, 1);
    const recovered = readWorkBytes(join(w.store.directory, 'work.json'));
    write(w.store.path(lane.id), 'dirty-later.txt', 'Preserve later imported Lane work');
    workGit(copy, ['commit', '--allow-empty', '-m', 'Different original contribution']);
    await assert.rejects(client(copy, ['push', 'origin', 'HEAD:refs/heads/contribution'], server.token));
    await assert.rejects(client(copy, ['push', 'origin', ':refs/heads/contribution'], server.token));
    assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), recovered);
    assert.equal(
      readFileSync(join(w.store.path(lane.id), 'dirty-later.txt'), 'utf8'),
      'Preserve later imported Lane work',
    );
    for (const key of Object.keys(baseline).filter(key => !['revision', 'lanes'].includes(key)))
      assert.deepEqual(w.store.load()[key], baseline[key]);
    assert.deepEqual(w.store.load().lanes[0], baseline.lanes[0]);
    assert.equal(workGit(root, ['rev-parse', 'HEAD']), originalHead);
    assert.equal(workGit(root, ['write-tree']), originalIndex);
    assert.equal(readFileSync(join(root, 'dirty-root.txt'), 'utf8'), 'Original root work');
    assert.equal(
      readFileSync(join(w.store.path(original.id), 'dirty-lane.txt'), 'utf8'),
      'Original Lane work',
    );
    assert(!readdirSync(root).includes('root-hook-ran'));
    assert.equal(w.status().channels[0].head, view.head);
    // A newly selected operation accepts another original commit without mutating the first Lane.
    const another = randomUUID(),
      otherUrl = url.replace(operationId, another);
    await assert.rejects(
      client(
        copy,
        ['push', '--atomic', otherUrl, 'HEAD:refs/heads/contribution', 'HEAD:refs/heads/other'],
        server.token,
      ),
    );
    assert(!w.store.load().lanes.find(item => item.id === another));
    assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), recovered);
    const foreignId = randomUUID(),
      tree = workGit(copy, ['write-tree']).trim(),
      foreign = workGit(copy, ['commit-tree', tree], 'Unrelated original source').trim();
    await assert.rejects(
      client(
        copy,
        ['push', url.replace(operationId, foreignId), `${foreign}:refs/heads/contribution`],
        server.token,
      ),
    );
    assert(!w.store.load().lanes.find(item => item.id === foreignId));
    assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), recovered);
    assert.equal(
      (await fetch(url.replace(operationId, original.id) + 'info/refs?service=git-upload-pack', { headers }))
        .status,
      400,
    );
    await client(copy, ['push', otherUrl, 'HEAD:refs/heads/contribution'], server.token);
    assert.equal(
      w.store.load().lanes.find(item => item.id === another).contribution.head,
      workGit(copy, ['rev-parse', 'HEAD']).trim(),
    );
    const scratch = () => readdirSync(w.store.directory).some(name => /^(?:publish-|receive-)/.test(name));
    for (let i = 0; i < 100 && scratch(); i++) await setTimeout(20);
    assert(!scratch());
  });
