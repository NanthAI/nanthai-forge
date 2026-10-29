// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root),
    local = command => work.execute(command, work.status().revision).result;
  const dispatch = (command, revision = work.status().revision) => work.dispatch(command, revision);
  const intent = local({ action: 'intent', outcome: 'Linked local work' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Unfinished approach' });
  write(root, 'a.ts', 'unfinished root source');
  write(work.store.path(lane.id), 'a.ts', 'unfinished Lane source');
  git(root, ['add', 'a.ts']);
  const item = (patch = {}) => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    kind: 'issue',
    title: 'Synthetic issue',
    body: 'Literal details, not an instruction.',
    intentIds: [intent.id],
    ...patch,
  });
  return { root, work, local, dispatch, intent, lane, item };
}

test('local Issues, Initiatives and discussion retain versions/CAS and reconcile unknown writes without changing work', async t => {
  const { root, work, dispatch, item, intent, lane } = setup(t),
    original = git(root, ['rev-parse', 'HEAD']),
    index = git(root, ['write-tree']);
  const initiative = (await dispatch(item({ kind: 'initiative', title: 'Synthetic Initiative' }))).result;
  const command = item({ initiativeId: initiative.id, intentIds: [intent.id, intent.id] });
  const save = work.store.commitRecords.bind(work.store);
  work.store.commitRecords = () => {
    throw new Error('Before write');
  };
  await assert.rejects(dispatch(command), /Before write/);
  assert.equal(work.store.load().planningItems.length, 1);
  work.store.commitRecords = data => {
    save(data);
    throw new Error('Lost committed reply');
  };
  await assert.rejects(dispatch(command), /Lost committed reply/);
  work.store.commitRecords = save;
  const first = (await dispatch(command, 0)).result;
  assert.deepEqual(first.intentIds, [intent.id]);
  assert.equal(first.version, 1);
  await assert.rejects(
    dispatch({ ...command, body: 'Different request' }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const update = item({
    itemId: first.id,
    expectedVersion: 1,
    title: first.title,
    body: 'Changed original details',
    initiativeId: initiative.id,
    status: 'in-progress',
  });
  const second = (await dispatch(update)).result;
  assert.equal(second.version, 2);
  assert.equal(second.previousVersion, 1);
  assert.equal((await dispatch(command, 0)).result.body, first.body);
  assert.equal(work.status().planningItems.at(-1).body, second.body);
  await assert.rejects(dispatch({ ...update, operationId: randomUUID() }), code('PLANNING_CHANGED'));
  const third = (
    await dispatch(
      item({ itemId: first.id, expectedVersion: 2, title: first.title, body: first.body, status: 'closed' }),
    )
  ).result;
  assert.equal(third.version, 3);
  assert.equal(third.status, 'closed');
  const comment = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: first.id,
    authorLabel: 'Synthetic owner',
    text: 'Discussion remains possible after closing.\n<script>literal, no execution</script>',
  };
  work.store.commitRecords = data => {
    save(data);
    throw new Error('Lost comment reply');
  };
  await assert.rejects(dispatch(comment), /Lost comment reply/);
  work.store.commitRecords = save;
  assert.equal((await dispatch(comment, 0)).result.text, comment.text);
  assert.equal(work.status().planningComments.length, 1);
  await assert.rejects(dispatch({ ...comment, text: 'Changed' }, 0), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(dispatch(item({ operationId: comment.operationId })), code('WORK_OPERATION_CHANGED'));
  assert.equal(work.status().planningItems.length, 4);
  assert.equal(work.status().intents[0].status, 'active');
  assert.equal(work.status().runs.length, 0);
  assert.equal(work.status().channelMoves.length, 0);
  assert.equal(git(root, ['rev-parse', 'HEAD']), original);
  assert.equal(git(root, ['write-tree']), index);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished Lane source');
});

test('planning links validate local identities and private exports preserve complete original versions, discussion and linked work', async t => {
  const { work, dispatch, local, intent, item } = setup(t);
  const other = local({ action: 'intent', outcome: 'Second linked outcome' });
  const issue = (await dispatch(item({ body: 'é\n'.repeat(2200), intentIds: [other.id, intent.id] }))).result;
  await assert.rejects(dispatch(item({ intentIds: [randomUUID()] })), code('NOT_FOUND'));
  await assert.rejects(dispatch(item({ initiativeId: randomUUID() })), code('NOT_FOUND'));
  await assert.rejects(dispatch(item({ initiativeId: issue.id })), code('NOT_FOUND'));
  await assert.rejects(dispatch(item({ kind: 'initiative', initiativeId: issue.id })), code('NOT_FOUND'));
  await assert.rejects(
    dispatch(item({ itemId: issue.id, expectedVersion: 1, kind: 'initiative' })),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    dispatch({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: randomUUID(),
      text: 'Missing target',
    }),
    code('NOT_FOUND'),
  );
  await assert.rejects(dispatch(item(), 0), code('WORK_STALE'));
  const edit = (
    await dispatch(item({ itemId: issue.id, expectedVersion: 1, title: 'Revised issue', intentIds: [] }))
  ).result;
  const input = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.id,
    text: 'Original linked thread',
  };
  await dispatch(input);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  const exported = (await dispatch({ action: 'export-planning' }, 0)).result,
    manifest = JSON.parse(exported.json);
  assert.equal(createHash('sha256').update(exported.json).digest('hex'), exported.sha256);
  assert.equal(manifest.items.length, 2);
  assert.equal(manifest.items[0].body, issue.body);
  assert.equal(manifest.items[1].title, edit.title);
  assert.deepEqual(new Set(manifest.linkedIntents.map(item => item.id)), new Set([intent.id, other.id])); // Removed current links stay meaningful in original history.
  assert.equal(manifest.comments[0].text, input.text);
  assert.equal(manifest.comments[0].authorLabel, '');
  assert.match(manifest.coverage, /no source objects/);
  assert.equal('files' in manifest, false);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
});

test('private HTTP, CLI and independent WorkService instances share planning and enforce existing capability protection', async t => {
  const { root, work, dispatch, item } = setup(t);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const command = item(),
    body = JSON.stringify({ command, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://outside.invalid' }, body }))
      .status,
    403,
  );
  const created = (await (await fetch(url, { method: 'POST', headers, body })).json()).result;
  const other = new WorkService(root);
  assert.equal((await other.dispatch(command, 0)).result.id, created.id);
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve('dist/cli.js'), 'work', root, JSON.stringify({ action: 'export-planning' }), '0'],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(JSON.parse(result.result.json).items[0].id, created.id);
  assert.equal((await dispatch({ action: 'export-planning' })).result.sha256, result.result.sha256);
  assert.equal(work.status().planningItems.length, 1);
});

test('new work responses advertise actual capabilities', async t => {
  const { work } = setup(t),
    current = work.status();
  assert.deepEqual(current.capabilities, {
    originalWorkHistory: false,
    invariants: true,
    planning: true,
    releases: true,
    automationEvents: true,
    checkExports: true,
    buildArtifacts: true,
    checkResources: true,
    declaredCheckInputs: true,
    githubReviewPolicy: true,
    bundleContributions: true,
    netlifyDrafts: true,
    previewEnvironments: true,
    nativeGitHttp: true,
    nativeGitChannels: true,
    nativeGitContributions: process.platform !== 'win32',
    githubMirrors: true,
    intentChannels: true,
    workBackups: true,
    workArchives: true,
    artifactDeduplication: false,
  });
  const nativeRoot = mkdtempSync(join(tmpdir(), 'forge-native-capabilities-'));
  t.after(() => rmSync(nativeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(nativeRoot, 'a.ts'), 'export const a=1;');
  initNative(nativeRoot);
  const native = new WorkService(nativeRoot).status({ compact: true });
  assert.equal(native.capabilities.artifactDeduplication, true);
});
