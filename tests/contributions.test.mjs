// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

async function setup(t, format = 'sha1') {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n', 'hidden.ts': 'Original complete source\n' });
  if (format === 'sha256') {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    git(root, ['init', '-q', '--object-format=sha256']);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original source']);
  const w = new WorkService(root),
    local = c => w.execute(c, w.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Accept an original Git contribution' }),
    lane = local({ action: 'lane', intentId: intent.id, name: 'Unfinished original Lane' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const move = (
    await w.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      },
      w.status().revision,
    )
  ).result;
  const bundle = (await w.dispatch({ action: 'export-channel', id: move.id }, 0)).result;
  const clone = join(root, '.git/contributor-copy');
  git(root, ['clone', '--template=', '--branch', 'accepted', '--', bundle.path, clone]);
  git(clone, ['checkout', '-qb', 'contribution']);
  write(clone, 'a.ts', 'export const a = 2;\n');
  git(clone, ['add', 'a.ts']);
  git(clone, ['commit', '-qm', 'Original contributor commit']);
  const head = git(clone, ['rev-parse', 'HEAD']).trim(),
    input = join(root, '.git/contribution.bundle');
  git(clone, ['bundle', 'create', input, 'refs/heads/contribution']);
  chmodSync(input, 0o600);
  const sha256 = createHash('sha256').update(readFileSync(input)).digest('hex');
  write(root, 'a.ts', 'Unfinished root\n');
  write(w.store.path(lane.id), 'a.ts', 'Unfinished original Lane\n');
  const command = {
    action: 'import-bundle',
    operationId: randomUUID(),
    intentId: intent.id,
    expectedBase: intent.base,
    expectedHead: head,
    path: input,
    ref: 'refs/heads/contribution',
    sha256,
    name: 'Returned source <script>literal</script>',
  };
  return {
    root,
    w,
    intent,
    lane,
    view,
    clone,
    input,
    head,
    command,
    dispatch: (c, r = w.status().revision) => w.dispatch(c, r),
  };
}

test('full native Git export/edit/contribution round trip preserves original source, authorship, hidden content and unselected Channels', async t => {
  for (const format of ['sha1', 'sha256']) {
    const s = await setup(t, format),
      originalCommit = git(s.clone, ['cat-file', 'commit', s.head]),
      rootIndex = git(s.root, ['write-tree']);
    git(s.root, ['update-ref', 'refs/replace/' + s.head, s.intent.base]);
    write(s.root, '.git/hooks/post-checkout', '#!/bin/sh\ntouch "' + s.root + '/hook-ran"\n');
    chmodSync(join(s.root, '.git/hooks/post-checkout'), 0o700);
    const result = (await s.dispatch(s.command)).result;
    assert.equal(result.head, s.head);
    assert.equal(result.base, s.head);
    assert.equal(result.contribution.base, s.intent.base);
    assert.equal(result.contribution.sha256, s.command.sha256);
    assert.equal(result.contribution.provenance, 'unverified-git-bundle');
    assert.equal(git(s.root, ['--no-replace-objects', 'cat-file', 'commit', s.head]), originalCommit);
    assert.equal(git(s.w.store.path(result.id), ['rev-parse', 'HEAD']).trim(), s.head);
    assert.equal(
      readFileSync(join(s.w.store.path(result.id), 'hidden.ts'), 'utf8'),
      'Original complete source\n',
    );
    assert.equal(readFileSync(join(s.root, 'a.ts'), 'utf8'), 'Unfinished root\n');
    assert.equal(readFileSync(join(s.w.store.path(s.lane.id), 'a.ts'), 'utf8'), 'Unfinished original Lane\n');
    assert.equal(git(s.root, ['write-tree']), rootIndex);
    assert.equal(git(s.root, ['rev-parse', 'refs/forge/channels/main']).trim(), s.view.head);
    const data = readWorkBytes(join(s.w.store.directory, 'work.json'));
    const retry = (await s.dispatch(s.command, 0)).result;
    assert.equal(retry.id, result.id);
    assert.deepEqual(readWorkBytes(join(s.w.store.directory, 'work.json')), data);
    await assert.rejects(
      s.dispatch({ ...s.command, name: 'Changed original request' }, 0),
      code('WORK_OPERATION_CHANGED'),
    );
    write(s.w.store.path(result.id), 'next.ts', 'export const next = true;');
    git(s.w.store.path(result.id), ['add', 'next.ts']);
    git(s.w.store.path(result.id), ['commit', '-qm', 'Later local work']);
    const advanced = git(s.w.store.path(result.id), ['rev-parse', 'HEAD']);
    await s.dispatch(s.command, 0);
    assert.equal(git(s.w.store.path(result.id), ['rev-parse', 'HEAD']), advanced);
    const composed = s.w.execute(
      { action: 'compose', intentId: s.intent.id, inputs: [{ laneId: result.id, head: advanced.trim() }] },
      s.w.status().revision,
    ).result;
    assert.equal(composed.status, 'clean');
    assert.equal(git(s.root, ['show', composed.head + ':a.ts']), 'export const a = 2;\n');
    assert.equal(git(s.root, ['show', composed.head + ':hidden.ts']), 'Original complete source\n');
    assert.equal(s.w.status().runs.length, 0);
    assert.equal(existsSync(join(s.root, 'hook-ran')), false);
  }
});

test('invalid/partial/foreign bundles and stale requests preserve existing work; original creation journals recover without rereading changed input', async t => {
  const s = await setup(t),
    data = readWorkBytes(join(s.w.store.directory, 'work.json')),
    refs = git(s.root, ['for-each-ref']);
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { expectedHead: 'c'.repeat(40) },
    { ref: 'refs/heads/missing' },
    { expectedBase: 'd'.repeat(40) },
    { path: 'relative.bundle' },
  ]) {
    await assert.rejects(s.dispatch({ ...s.command, operationId: randomUUID(), ...patch }));
    assert.deepEqual(readWorkBytes(join(s.w.store.directory, 'work.json')), data);
    assert.equal(git(s.root, ['for-each-ref']), refs);
  }
  await assert.rejects(s.dispatch({ ...s.command, operationId: randomUUID() }, 0), code('WORK_STALE'));
  const unrelated = fixture(t, { 'a.ts': 'export const unrelated = true;' });
  git(unrelated, ['add', '.']);
  git(unrelated, ['commit', '-qm', 'Unrelated original source']);
  git(unrelated, ['checkout', '-qb', 'contribution']);
  const foreign = join(unrelated, 'foreign.bundle');
  git(unrelated, ['bundle', 'create', foreign, 'refs/heads/contribution']);
  await assert.rejects(
    s.dispatch({
      ...s.command,
      operationId: randomUUID(),
      path: foreign,
      ref: 'refs/heads/contribution',
      expectedHead: git(unrelated, ['rev-parse', 'HEAD']).trim(),
      sha256: createHash('sha256').update(readFileSync(foreign)).digest('hex'),
    }),
  );
  const partial = join(s.root, '.git/partial.bundle');
  git(s.clone, ['bundle', 'create', partial, 'refs/heads/contribution', '^' + s.intent.base]);
  await assert.rejects(
    s.dispatch({
      ...s.command,
      operationId: randomUUID(),
      path: partial,
      sha256: createHash('sha256').update(readFileSync(partial)).digest('hex'),
    }),
    code('WORK_GIT_FAILED'),
  );
  assert.deepEqual(readWorkBytes(join(s.w.store.directory, 'work.json')), data);
  assert.equal(git(s.root, ['for-each-ref']), refs);
  const save = s.w.store.save.bind(s.w.store);
  s.w.store.save = d => {
    save(d);
    if (d.lanes.at(-1).id === s.command.operationId && d.lanes.at(-1).state === 'creating')
      throw new Error('Lost creation journal reply');
  };
  await assert.rejects(s.dispatch(s.command), /Lost creation journal reply/);
  s.w.store.save = save;
  assert.equal(s.w.store.load().lanes.at(-1).state, 'creating');
  assert.equal(existsSync(s.w.store.path(s.command.operationId)), false);
  writeFileSync(s.input, 'Changed original file after import journal');
  const recovered = (await s.dispatch(s.command, 0)).result;
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.head, s.head);
  assert.equal(s.w.status().lanes.filter(l => l.contribution).length, 1);
  const concurrent = await setup(t),
    revision = concurrent.w.status().revision;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => new WorkService(concurrent.root).dispatch(concurrent.command, revision)),
  );
  assert.equal(new Set(results.map(r => r.result.id)).size, 1);
  assert.equal(concurrent.w.status().lanes.filter(l => l.contribution).length, 1);
  assert.equal(git(concurrent.root, ['rev-parse', 'refs/forge/channels/main']).trim(), concurrent.view.head);
});

test('existing protected HTTP, CLI and opt-in SDK MCP import full source through the same native owner', async t => {
  const s = await setup(t),
    server = await serveRepository(s.root, 0);
  t.after(() => server.close());
  const body = JSON.stringify({ command: s.command, revision: s.w.status().revision }),
    url = `http://127.0.0.1:${server.port}/api/work`,
    headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://outside.invalid' }, body }))
      .status,
    403,
  );
  const response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.contribution.head, s.head);
  const cli = JSON.parse(
    execFileSync(process.execPath, [resolve('dist/cli.js'), 'work', s.root, JSON.stringify(s.command), '0'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(cli.result.id, s.command.operationId);
  const client = new Client({ name: 'contribution-check', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', s.root, '--work'],
      stderr: 'pipe',
    }),
  );
  const reply = await client.callTool({
    name: 'forge_work_command',
    arguments: {
      command: { ...s.command, operationId: randomUUID(), name: 'Independent SDK contribution' },
      revision: s.w.status().revision,
    },
  });
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.result.contribution.sha256, s.command.sha256);
  assert.equal(result.result.head, s.head);
  assert.equal(s.w.status().runs.length, 0);
});
