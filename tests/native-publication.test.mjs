// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './publication-fixture.mjs';
import { git, code } from './helpers.mjs';
import { importNativeGit } from '../dist/native-git.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { serveRepository } from '../dist/http.js';

async function native(t, options) {
  const fixture = setup(t, options),
    root = join(fixture.root, '.git/native-owner');
  const imported = await importNativeGit(fixture.root, fixture.command.expectedHead, root),
    work = new WorkService(root);
  const local = c => work.execute(c, work.store.load().revision).result;
  const intent = local({ action: 'intent', outcome: 'Native publication' }),
    lane = local({ action: 'lane', intentId: intent.id, name: 'Native edit' });
  writeFileSync(join(work.store.path(lane.id), 'b.ts'), 'export const b=2;\n');
  const state = work.status().lanes[0],
    changed = local({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: state.head,
      expectedTree: state.indexTree,
      message: 'Native edit',
    });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: changed.head }],
  });
  const command = { ...fixture.command, operationId: randomUUID(), viewId: view.id, expectedHead: view.head };
  return {
    ...fixture,
    root,
    imported,
    work,
    local,
    intent,
    lane,
    view,
    command,
    publish: (c = command, r = work.store.load().revision) => work.dispatch(c, r),
  };
}

test(
  'native publication retains State/Git identity, reconciles unknown writes, imports exact checks and restores without Git',
  { timeout: 120000 },
  async t => {
    const { root, remote, work, command, state, change, publish, local, lane, view, intent } = await native(
      t,
      { lostPush: true, lostCreate: true },
    );
    const original = readFileSync(join(root, 'a.ts'));
    await assert.rejects(publish(command, 0), code('WORK_STALE'));
    assert.equal(state().creates, 0);
    const result = (await publish()).result,
      projected = result.projection.head;
    assert.equal(result.head, view.head);
    assert.notEqual(projected, view.head);
    assert.equal(state().creates, 1);
    assert.equal(
      git(remote, ['rev-parse', `refs/heads/forge/publish/${command.operationId}`]).trim(),
      projected,
    );
    assert.equal(git(remote, ['show', `${projected}:b.ts`]), 'export const b=2;\n');
    assert.equal(
      git(remote, ['rev-parse', `${projected}^`]).trim(),
      new NativeSource(root).state(view.base).git.commit,
    );
    local({ action: 'note', intentId: intent.id, kind: 'decision', text: 'Concurrent native Work survives' });
    assert.equal((await publish(command, 0)).result.number, 7);
    assert.equal(state().creates, 1);
    await assert.rejects(publish({ ...command, title: 'Changed title' }, 0), code('PUBLICATION_CHANGED'));
    change({ denied: true });
    await assert.rejects(publish(), code('GITHUB_WRITE_DENIED'));
    change({ denied: false });
    const input = {
      action: 'import-checks',
      operationId: randomUUID(),
      viewId: view.id,
      expectedHead: view.head,
      repository: command.repository,
    };
    change({ checkHead: view.head });
    await assert.rejects(work.dispatch(input, work.store.load().revision), code('EVIDENCE_CHANGED'));
    change({ checkHead: projected });
    const checks = (await work.dispatch(input, work.store.load().revision)).result;
    assert.equal(checks.head, view.head);
    assert.equal(checks.projection.head, projected);
    assert.equal(checks.checks[0].head_sha, projected);
    change({ deniedRead: true });
    assert.equal((await work.dispatch(input, 0)).result.id, input.operationId);
    await assert.rejects(
      work.dispatch({ action: 'check-publication', publicationId: result.id }, 0),
      code('PUBLISH_GITHUB_FAILED'),
    );
    change({ deniedRead: false });
    const base = git(remote, ['rev-parse', 'main']).trim(),
      accepted = git(remote, [
        'commit-tree',
        `${projected}^{tree}`,
        '-p',
        base,
        '-m',
        'Provider squash',
      ]).trim();
    const pulls = state().pulls;
    Object.assign(pulls[0], {
      state: 'closed',
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: accepted,
    });
    change({ pulls });
    git(remote, ['update-ref', 'refs/heads/main', accepted]);
    const observed = (
      await work.dispatch({ action: 'check-publication', publicationId: result.id }, 0)
    ).result.checks.at(-1);
    assert.equal(observed.acceptance, 'accepted');
    assert.equal(observed.acceptedCommit, accepted);
    assert.ok(observed.bundle);
    git(remote, ['update-ref', 'refs/heads/main', base]);
    assert.equal(
      (await work.dispatch({ action: 'check-publication', publicationId: result.id }, 0)).result.checks.at(-1)
        .acceptance,
      'unconfirmed',
    );
    assert.deepEqual(readFileSync(join(root, 'a.ts')), original);
    assert.equal(existsSync(join(root, '.git')), false);
    const server = await serveRepository(work.store.path(lane.id), 0);
    t.after(() => server.close());
    const url = new URL(server.url),
      token = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.equal(
      (
        await fetch(url.origin + '/api/work', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, revision: 0 }),
        })
      ).status,
      401,
    );
    const retry = await fetch(url.origin + '/api/work', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ command, revision: 0 }),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).result.projection.head, projected);
    const bin = join(root, '.forge/no-git'),
      called = join(bin, 'called');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`, { mode: 0o700 });
    for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      local({
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      });
      const archive = (
        await work.dispatch({ action: 'export-work', archive: true }, work.store.load().revision)
      ).result;
      const saved = work.store.load(),
        projection = structuredClone(saved.publications[0].projection);
      saved.publications[0].projection.state = '0'.repeat(64);
      work.store.save(saved);
      await assert.rejects(
        work.dispatch({ action: 'export-work', archive: true }, saved.revision),
        code('INVALID_NATIVE_GIT'),
      );
      saved.publications[0].projection = projection;
      work.store.save(saved);
      const destination = join(root, '.forge/restored');
      await restoreNativeWork(archive.archive.path, destination);
      const restored = new WorkService(destination).status();
      assert.equal(restored.channels[0].head, view.head);
      assert.equal(restored.publications[0].projection.head, projected);
      assert.equal(restored.githubChecks[0].checks[0].head_sha, projected);
      assert.equal(restored.publications[0].checks[0].bundle, observed.bundle);
      assert.equal(restored.intents[0].notes.length, 1);
      assert.equal(existsSync(called), false);
    } finally {
      process.env.PATH = previous;
    }
  },
);

test(
  'native publisher preserves a different remote branch and an externally changed PR',
  { timeout: 120000 },
  async t => {
    const { remote, command, state, publish, change, work } = await native(t);
    const base = git(remote, ['rev-parse', 'main']).trim();
    git(remote, ['update-ref', `refs/heads/forge/publish/${command.operationId}`, base]);
    await assert.rejects(publish(), code('PUBLICATION_CHANGED'));
    assert.equal(state().creates, 0);
    assert.equal(git(remote, ['rev-parse', `refs/heads/forge/publish/${command.operationId}`]).trim(), base);
    git(remote, ['update-ref', '-d', `refs/heads/forge/publish/${command.operationId}`]);
    await publish();
    const pulls = state().pulls;
    pulls[0].head.sha = base;
    change({ pulls });
    await assert.rejects(publish(command, 0), code('PUBLICATION_CHANGED'));
    const observed = (
      await work.dispatch({ action: 'check-publication', publicationId: command.operationId }, 0)
    ).result.checks.at(-1);
    assert.equal(observed.acceptance, 'unconfirmed');
    assert.match(observed.details, /candidate or destination changed/);
    assert.equal(state().creates, 1);
  },
);
