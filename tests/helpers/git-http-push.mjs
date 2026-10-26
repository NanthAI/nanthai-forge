// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from '../work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { WorkService } from '../../dist/work.js';
import { workGit } from '../../dist/work-git.js';
import { serveRepository } from '../../dist/http.js';
import { write } from '../helpers.mjs';
import { fixture, client } from './git-http-fixture.mjs';

export function registerPushTests(format) {
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
}
