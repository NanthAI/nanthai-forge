// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { git, write, code } from './helpers.mjs';

import { setup } from './publication-fixture.mjs';

test('publication transfers the exact commit, reconciles lost push/create replies and stale retry without duplicating PRs', async t => {
  const { root, remote, work, command, state, change, checkpoint, publish } = setup(t, {
    lostPush: true,
    lostCreate: true,
  });
  const original = git(root, ['rev-parse', 'HEAD']).trim();
  const revision = work.status().revision;
  // Target Git settings and hooks must not become authority for credential-bearing network commands.
  const marker = join(root, 'executed');
  writeFileSync(join(root, '.git/hooks/pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(root, ['config', 'url.file:///invalid.insteadOf', 'https://github.com/']);
  const first = await publish();
  assert.equal(first.result.status, 'published');
  assert.equal(first.result.base, 'main');
  assert.equal(
    git(remote, ['rev-parse', `refs/heads/forge/publish/${command.operationId}`]).trim(),
    command.expectedHead,
  );
  assert.equal(state().pulls[0].draft, false);
  assert.equal(state().creates, 1);
  checkpoint('export const a = 3;\n'); // A retry resolves the old pinned operation even after the Lane advances.
  assert.equal((await publish(command, revision)).result.number, 7);
  assert.equal(state().creates, 1);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readdirSync(work.store.directory).filter(name => name.startsWith('publish-')).length, 0);
  assert.equal(readdirSync(root).includes('executed'), false);
  change({ denied: true });
  await assert.rejects(publish(), code('GITHUB_WRITE_DENIED'));
});

test('stale/new candidates and changed operation scopes fail before writes; an existing remote branch is never overwritten', async t => {
  const { root, remote, work, command, state, publish } = setup(t);
  await assert.rejects(publish(command, 0), code('WORK_STALE'));
  assert.equal(work.status().publications.length, 0);
  await assert.rejects(publish({ ...command, expectedHead: '0'.repeat(40) }), code('VIEW_STALE'));
  git(remote, [
    'update-ref',
    `refs/heads/forge/publish/${command.operationId}`,
    git(root, ['rev-parse', 'HEAD']).trim(),
  ]);
  await assert.rejects(publish(), code('PUBLICATION_CHANGED'));
  assert.equal(state().creates, 0);
  assert.equal(work.status().publications[0].status, 'pending');
  await assert.rejects(publish({ ...command, draft: true }), code('PUBLICATION_CHANGED'));
  assert.equal(
    git(remote, ['rev-parse', `refs/heads/forge/publish/${command.operationId}`]).trim(),
    git(root, ['rev-parse', 'HEAD']).trim(),
  );
});

test('upstream conflict is visible without altering the selected candidate; draft is optional and changed external PRs are preserved', async t => {
  const { root, remote, command, state, change, publish } = setup(t);
  write(root, 'a.ts', 'export const a = 9;\n');
  git(root, ['add', 'a.ts']);
  git(root, ['commit', '-qm', 'Upstream changed']);
  const upstream = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['push', remote, 'HEAD:refs/heads/main']);
  const result = await publish({ ...command, draft: true });
  assert.equal(result.result.upstream.head, upstream);
  assert.equal(result.result.upstream.status, 'conflict');
  assert.match(result.result.upstream.details, /CONFLICT/);
  assert.equal(state().pulls[0].draft, true);
  assert.equal(result.result.head, command.expectedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), upstream);
  const pulls = state().pulls;
  pulls[0].head.sha = upstream;
  change({ pulls });
  await assert.rejects(publish({ ...command, draft: true }), code('PUBLICATION_CHANGED'));
  assert.equal(state().creates, 1);
});

test('local HTTP and CLI publish through the shared owner, with normal PR default and retry reconciliation', async t => {
  const { root, command, state, work } = setup(t);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const input = { ...command };
  delete input.draft;
  const body = JSON.stringify({ command: input, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body }))
      .status,
    403,
  );
  assert.equal(state().creates, 0);
  const response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.number, 7);
  assert.equal(state().pulls[0].draft, false);
  const retry = JSON.parse(
    execFileSync(process.execPath, ['dist/cli.js', 'work', root, JSON.stringify(input), '0'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(retry.result.number, 7);
  assert.equal(state().creates, 1);
});

test('a durable pending publication resumes after PR creation fails, and concurrent retries converge on one branch/PR', async t => {
  const { root, remote, command, work, state, change, publish, local, intent } = setup(t, {
    failCreate: true,
  });
  await assert.rejects(publish(), code('PUBLICATION_PENDING'));
  assert.equal(
    git(remote, ['rev-parse', `refs/heads/forge/publish/${command.operationId}`]).trim(),
    command.expectedHead,
  );
  assert.equal(work.status().publications[0].status, 'pending');
  assert.equal(state().creates, 0);
  local({
    action: 'note',
    intentId: intent.id,
    text: 'A concurrent decision must survive reconciliation.',
    kind: 'decision',
  });
  change({ failCreate: false });
  const results = await Promise.all([new WorkService(root).dispatch(command, 0), publish(command, 0)]);
  assert(results.every(result => result.result.number === 7));
  assert.equal(state().creates, 1);
  assert.equal(work.status().publications.length, 1);
  assert.equal(work.status().intents[0].notes.length, 1);
  await assert.rejects(publish(command, Number.NaN), code('BAD_ARGUMENT'));
  // Observing a closed, merged PR does not recreate it or mutate the local Intent/Lane lifecycle.
  const pulls = state().pulls;
  pulls[0].state = 'closed';
  pulls[0].merged_at = new Date().toISOString();
  change({ pulls });
  git(remote, ['update-ref', '-d', `refs/heads/forge/publish/${command.operationId}`]);
  assert.equal((await publish()).result.merged, true);
  assert.equal(state().creates, 1);
  assert.equal(work.status().intents[0].status, 'active');
  assert.equal(work.status().lanes[0].state, 'active');
});

test('external PR import retains fork authorship, exact objects, earlier pins and local decisions; checks use current read access', async t => {
  const { root, remote, work, state, change, publish, local } = setup(t);
  await publish();
  const base = git(remote, ['rev-parse', 'main']).trim();
  const original = git(root, ['rev-parse', 'HEAD']).trim();
  const externalCommit = message =>
    execFileSync('git', ['-C', remote, 'commit-tree', `${state().pulls[0].head.sha}^{tree}`, '-p', base], {
      input: message,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Original contributor',
        GIT_AUTHOR_EMAIL: 'original@localhost',
        GIT_COMMITTER_NAME: 'Original contributor',
        GIT_COMMITTER_EMAIL: 'original@localhost',
      },
    }).trim();
  const head = externalCommit('An upstream contribution\n');
  const pulls = state().pulls;
  pulls[0].head.sha = head;
  pulls[0].head.repo.full_name = 'contributor/fork';
  change({ pulls, denied: true });
  git(remote, ['update-ref', 'refs/pull/7/head', head]);
  git(root, ['config', 'url.file:///invalid.insteadOf', 'https://github.com/']);
  const input = { action: 'import-pr', url: 'https://github.com/tests/example/pull/7' };
  await assert.rejects(work.dispatch(input, 0), code('WORK_STALE'));
  const imported = (await work.dispatch(input, work.status().revision)).result;
  assert.equal(imported.external.author.login, 'upstream-author');
  assert.equal(imported.base, base);
  assert.equal(imported.external.observations[0].head, head);
  assert.equal(
    git(root, ['show', '-s', '--format=%an <%ae>', head]).trim(),
    'Original contributor <original@localhost>',
  );
  assert.match(work.status().intents.find(i => i.id === imported.id).externalDiff, /a = 2/);
  assert.equal((await work.dispatch(input, 0)).result.id, imported.id);
  assert.equal(work.status().intents.length, 2);
  local({
    action: 'note',
    intentId: imported.id,
    text: 'Local discussion survives upstream changes.',
    kind: 'decision',
  });
  const next = externalCommit('A new upstream candidate\n');
  pulls[0].head.sha = next;
  pulls[0].state = 'closed';
  change({ pulls });
  git(remote, ['update-ref', 'refs/pull/7/head', next]);
  const updated = (await work.dispatch({ action: 'check-pr', intentId: imported.id }, 0)).result;
  assert.equal(updated.notes.length, 1);
  assert.equal(updated.external.observations.at(-1).head, next);
  assert.equal(updated.external.observations.at(-1).prState, 'closed');
  assert.equal(updated.external.observations[0].head, head);
  assert.equal(git(root, ['rev-parse', `refs/forge/github/${head}`]).trim(), head);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(work.status().lanes.length, 1);
  change({ deniedRead: true });
  const revision = work.status().revision;
  await assert.rejects(
    work.dispatch({ action: 'check-pr', intentId: imported.id }, revision),
    code('PUBLISH_GITHUB_FAILED'),
  );
  assert.equal(work.status().revision, revision);
  assert.equal(git(root, ['rev-parse', head]).trim(), head);
});

test('acceptance requires canonical merge plus selected-base ancestry, including squash commits and force-pushed bases', async t => {
  const { root, remote, work, state, change, command, publish } = setup(t);
  await publish();
  const input = { action: 'check-publication', publicationId: command.operationId };
  const check = async () => (await work.dispatch(input, 0)).result.checks.at(-1);
  assert.equal((await check()).acceptance, 'unconfirmed');
  const base = git(remote, ['rev-parse', 'main']).trim();
  const pulls = state().pulls;
  const accepted = git(remote, [
    'commit-tree',
    `${command.expectedHead}^{tree}`,
    '-p',
    base,
    '-m',
    'GitHub squash merge',
  ]).trim();
  assert.notEqual(accepted, command.expectedHead);
  pulls[0].state = 'closed';
  pulls[0].merged = true;
  pulls[0].merged_at = new Date().toISOString();
  pulls[0].merge_commit_sha = accepted;
  change({ pulls, denied: true }); // A read/check does not demand publication write access.
  assert.equal((await check()).acceptance, 'unconfirmed'); // Host merge by itself is insufficient.
  git(remote, ['update-ref', 'refs/heads/main', accepted]);
  git(remote, ['update-ref', '-d', `refs/heads/forge/publish/${command.operationId}`]);
  const result = await check();
  assert.equal(result.acceptance, 'accepted');
  assert.equal(result.acceptedCommit, accepted);
  assert.equal(result.baseHead, accepted);
  assert.equal(git(root, ['rev-parse', `refs/forge/github/${accepted}`]).trim(), accepted);
  assert.equal(work.status().intents[0].status, 'active');
  assert.equal(work.status().lanes[0].state, 'active');
  git(remote, ['update-ref', 'refs/heads/main', base]);
  assert.equal((await check()).acceptance, 'unconfirmed');
  assert(work.status().publications[0].checks.some(c => c.acceptance === 'accepted'));
  pulls[0].base.ref = 'other';
  change({ pulls });
  assert.match((await check()).details, /destination changed/);
  assert.equal(state().creates, 1);
  assert.equal(work.status().publications[0].base, 'main');
});

test('a delayed GitHub check cannot overwrite a later observation or concurrent local work', async t => {
  const { work, state, change, publish, command, local, intent } = setup(t);
  await publish();
  change({ holdDetail: true });
  const input = { action: 'check-publication', publicationId: command.operationId };
  let slowFinished = false;
  const slow = work.dispatch(input, 0).then(result => {
    slowFinished = true;
    return result;
  });
  try {
    for (let tries = 0; !state().delayStarted && tries < 500; tries++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(state().delayStarted, true);
    const pulls = state().pulls;
    pulls[0].state = 'closed';
    change({ pulls });
    local({ action: 'note', intentId: intent.id, text: 'Keep concurrent local work.', kind: 'decision' });
    const fast = await work.dispatch(input, 0);
    assert.equal(fast.result.checks.at(-1).prState, 'closed');
    assert.equal(slowFinished, false); // Prove response ordering without relying on fixture execution speed.
  } finally {
    change({ releaseDetail: true });
    await slow;
  } // Release provider activity before fixture cleanup, even on assertion failure.
  assert.equal(work.status().publications[0].checks.at(-1).prState, 'closed');
  assert.equal(work.status().intents[0].notes.length, 1);
});

test('PR import/check share the protected local HTTP and CLI boundary; invalid input and unknown outcomes preserve work', async t => {
  const { root, work, state, change, publish, command, remote } = setup(t);
  await publish();
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const input = { action: 'import-pr', url: 'https://github.com/tests/example/pull/7' };
  const body = JSON.stringify({ command: input, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  const response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const imported = (await response.json()).result;
  const checked = JSON.parse(
    execFileSync(
      process.execPath,
      ['dist/cli.js', 'work', root, JSON.stringify({ action: 'check-pr', intentId: imported.id }), '0'],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(checked.result.id, imported.id);
  assert.equal(work.status().intents.length, 2);
  await assert.rejects(
    work.dispatch(
      { action: 'import-pr', url: 'https://github.com.evil/tests/example/pull/7' },
      work.status().revision,
    ),
    code('BAD_ARGUMENT'),
  );
  const revision = work.status().revision;
  change({ deniedRead: true });
  await assert.rejects(
    work.dispatch({ action: 'check-publication', publicationId: command.operationId }, 0),
    code('PUBLISH_GITHUB_FAILED'),
  );
  assert.equal(work.status().revision, revision);
  change({ deniedRead: false });
  const pulls = state().pulls;
  pulls[0].head.sha = '0'.repeat(40);
  change({ pulls });
  assert.equal(git(remote, ['rev-parse', 'refs/pull/7/head']).trim(), command.expectedHead);
  await assert.rejects(work.dispatch({ action: 'check-pr', intentId: imported.id }, 0), code('PR_CHANGED'));
  assert.equal(work.status().revision, revision);
  assert.equal(state().creates, 1);
});

test('a large imported diff reports a diagnostic without making unrelated local work unavailable', async t => {
  const { root, remote, work, state, change, publish } = setup(t);
  await publish();
  // Node's synchronous large-input pipe can stall under concurrent test load.
  // Hash the identical fixture bytes from a file, outside the source checkout.
  const inputPath = join(root, '.git', 'large-diff-input');
  writeFileSync(inputPath, 'large line\n'.repeat(500_000));
  const blob = execFileSync('git', ['-C', remote, 'hash-object', '-w', inputPath], {
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['-C', remote, 'mktree'], {
    input: `100644 blob ${blob}\tlarge.txt\n`,
    encoding: 'utf8',
  }).trim();
  const head = git(remote, [
    'commit-tree',
    tree,
    '-p',
    git(remote, ['rev-parse', 'main']).trim(),
    '-m',
    'Large external contribution',
  ]).trim();
  const pulls = state().pulls;
  pulls[0].head.sha = head;
  change({ pulls });
  git(remote, ['update-ref', 'refs/pull/7/head', head]);
  const imported = (
    await work.dispatch(
      { action: 'import-pr', url: 'https://github.com/tests/example/pull/7' },
      work.status().revision,
    )
  ).result;
  const status = work.status();
  assert.equal(status.intents.length, 2);
  assert.equal(status.lanes[0].available, true);
  assert.match(status.intents.find(i => i.id === imported.id).externalDiffError, /Git operation failed/);
  assert.equal(git(root, ['rev-parse', `refs/forge/github/${head}`]).trim(), head);
});

test('opt-in MCP publication, import, retained PR dependency and checks use current GitHub transport', async t => {
  const { root, command, work, change, state, intent } = setup(t, { lostCreate: true });
  const client = new Client({ name: 'forge-network-work-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/cli.js', 'mcp', root, '--work'],
      env: process.env,
      stderr: 'pipe',
    }),
  );
  const call = async (command, revision = work.status().revision) =>
    JSON.parse(
      (await client.callTool({ name: 'forge_work_command', arguments: { command, revision } })).content[0]
        .text,
    );
  const published = await call(command);
  assert.equal(published.result.number, 7);
  assert.equal((await call(command, 0)).result.number, 7);
  assert.equal(state().creates, 1);
  const imported = (await call({ action: 'import-pr', url: 'https://github.com/tests/example/pull/7' }))
    .result;
  const pin = {
    kind: 'pr',
    intentId: imported.id,
    observation: 0,
    head: imported.external.observations[0].head,
  };
  const composed = (await call({ action: 'compose', intentId: intent.id, inputs: [], dependencies: [pin] }))
    .result;
  assert.equal(composed.head, command.expectedHead);
  assert.deepEqual(composed.dependencies, [pin]);
  const basePin = { ...pin, part: 'base', head: imported.external.observations[0].base };
  assert.equal(
    (await call({ action: 'compose', intentId: intent.id, inputs: [], dependencies: [basePin] })).result.head,
    intent.base,
  );
  assert.equal((await call({ action: 'check-pr', intentId: imported.id })).result.id, imported.id);
  assert.equal(
    (await call({ action: 'check-publication', publicationId: command.operationId })).result.checks.at(-1)
      .acceptance,
    'unconfirmed',
  );
  const discussionCommand = {
    action: 'import-discussion',
    operationId: randomUUID(),
    target: { kind: 'intent', id: imported.id },
    feed: 'conversation',
    page: 1,
  };
  const discussion = (await call(discussionCommand)).result;
  assert.equal(
    (await call({ action: 'read-discussion', id: discussion.id }, 0)).result.items[0].provider_extension
      .retained,
    true,
  );
  change({ deniedRead: true });
  const revision = work.status().revision;
  assert.equal((await call(discussionCommand, 0)).result.id, discussion.id);
  assert.equal(
    (await call({ action: 'export-discussion', id: discussion.id }, 0)).result.items[0].body,
    'Original private provider comment',
  );
  assert.equal(
    (await call({ action: 'check-pr', intentId: imported.id })).error.code,
    'PUBLISH_GITHUB_FAILED',
  );
  assert.equal(work.status().revision, revision);
  assert.equal(
    (await call({ action: 'import-pr', url: 'https://github.com.evil/tests/example/pull/7' })).error.code,
    'BAD_ARGUMENT',
  );
  assert.equal(state().creates, 1);
  await client.close();
});
