// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t, format = 'sha1') {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  if (format === 'sha256') {
    rmSync(join(root, '.git'), { recursive: true });
    git(root, ['init', '-q', '--object-format=sha256']);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original release source']);
  const work = new WorkService(root),
    run = c => work.execute(c, work.status().revision).result;
  const dispatch = (c, revision = work.status().revision) => work.dispatch(c, revision);
  const intent = run({ action: 'intent', outcome: 'Release an exact accepted source' });
  const initialLane = run({ action: 'lane', intentId: intent.id, name: 'Original accepted source' });
  const view = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: initialLane.id, head: initialLane.base }],
  });
  const accept = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  const release = {
    action: 'create-release',
    operationId: randomUUID(),
    acceptanceId: accept.operationId,
    expectedHead: view.head,
    name: 'v1.0.0',
    notes: 'Original notes é <script>literal</script>',
  };
  return { root, work, run, dispatch, intent, view, accept, release };
}

test('source releases retain original acceptance through Channel advance/rollback and exact SHA-1/SHA-256 bundle manifests', async t => {
  for (const format of ['sha1', 'sha256']) {
    const { root, work, run, dispatch, intent, view, accept, release } = setup(t, format);
    const lane = run({ action: 'lane', intentId: intent.id, name: 'Next release work' }),
      path = work.store.path(lane.id);
    write(path, 'a.ts', 'export const a = 2;\n');
    git(path, ['add', '.']);
    const state = work.status().lanes.find(item => item.id === lane.id);
    const pin = run({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: state.actualHead,
      expectedTree: state.indexTree,
      message: 'Later source',
    });
    const newer = run({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: pin.head }],
    });
    const acceptance = (await dispatch(accept)).result,
      created = (await dispatch(release)).result;
    // Completion receipts describe the Lanes closed at accept time; the retained acceptance omits them.
    const { completed: _completed, lifecycleAction: _lifecycleAction, ...retained } = acceptance;
    assert.deepEqual(created.acceptance, retained);
    assert.equal(created.notes, release.notes);
    await dispatch({
      ...accept,
      operationId: randomUUID(),
      viewId: newer.id,
      expectedHead: newer.head,
      expectedPrevious: view.head,
    });
    write(root, 'a.ts', 'unfinished root');
    git(root, ['add', 'a.ts']);
    write(path, 'a.ts', 'unfinished Lane');
    const index = git(root, ['write-tree']);
    const before = readWorkBytes(join(work.store.directory, 'work.json'));
    const result = (await dispatch({ action: 'export-release', id: created.id }, 0)).result,
      manifest = JSON.parse(result.json);
    assert.deepEqual(manifest.release, created);
    assert.equal(result.bundle.head, view.head);
    assert.equal(createHash('sha256').update(result.json).digest('hex'), result.sha256);
    assert.equal(
      createHash('sha256').update(readFileSync(result.bundle.path)).digest('hex'),
      manifest.artifact.sha256,
    );
    assert.equal(statSync(result.bundle.path).size, manifest.artifact.size);
    assert.equal(statSync(result.bundle.path).mode & 0o777, 0o600);
    assert.equal('path' in manifest.artifact, false);
    assert.match(manifest.coverage, /no build, provider deployment/);
    const clone = join(root, 'release-copy');
    git(root, ['clone', '--branch=accepted', '--', result.bundle.path, clone]);
    assert.equal(git(clone, ['rev-parse', 'HEAD']).trim(), view.head);
    assert.equal(git(clone, ['rev-parse', '--show-object-format']).trim(), format);
    assert.equal(
      git(clone, ['log', '--format=%H %P %an %ae %s']),
      git(root, ['log', '--format=%H %P %an %ae %s', view.head]),
    );
    assert.equal(readFileSync(join(clone, 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
    assert.equal(work.status().channels[0].head, newer.head);
    assert.equal(git(root, ['write-tree']), index);
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'unfinished Lane');
    await dispatch({ ...accept, operationId: randomUUID(), expectedPrevious: newer.head });
    assert.deepEqual(work.status().releases[0], created);
    assert.equal((await dispatch(release, 0)).result.id, created.id);
  }
});

test('release request reconciliation survives lost saves, rejects changed pins and never invents missing acceptance or source', async t => {
  const { root, work, dispatch, accept, release } = setup(t);
  await assert.rejects(dispatch(release), code('NOT_FOUND'));
  await dispatch(accept);
  const save = work.store.save.bind(work.store);
  work.store.save = () => {
    throw new Error('Before write');
  };
  await assert.rejects(dispatch(release), /Before write/);
  assert.equal(work.store.load().releases.length, 0);
  work.store.save = d => {
    save(d);
    throw new Error('Lost saved reply');
  };
  await assert.rejects(dispatch(release), /Lost saved reply/);
  work.store.save = save;
  assert.equal((await dispatch(release, 0)).result.name, release.name);
  assert.equal(work.status().releases.length, 1);
  await assert.rejects(dispatch({ ...release, notes: 'Changed request' }, 0), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(dispatch({ ...release, operationId: randomUUID() }, 0), code('WORK_STALE'));
  await assert.rejects(
    dispatch({ ...release, operationId: randomUUID(), expectedHead: '0'.repeat(40) }),
    code('NOT_FOUND'),
  );
  const original = work.store.load(),
    changed = structuredClone(original);
  changed.channelMoves[0].viewId = randomUUID();
  save(changed);
  await assert.rejects(
    dispatch({ action: 'export-release', id: release.operationId }),
    code('RELEASE_CHANGED'),
  );
  save(original);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  git(root, ['update-ref', '-d', `refs/forge/channel-moves/${accept.operationId}`]);
  await assert.rejects(dispatch({ action: 'export-release', id: release.operationId }), code('NOT_FOUND'));
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  await assert.rejects(dispatch({ action: 'export-release', id: randomUUID() }), code('NOT_FOUND'));
});

test('private HTTP, CLI and actual current capabilities share local release owner and leave unauthorized writes unchanged', async t => {
  const { root, work, dispatch, accept, release } = setup(t);
  await dispatch(accept);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  const body = JSON.stringify({ command: release, revision: work.status().revision }),
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
  assert.equal(work.status().releases.length, 0);
  assert.equal(work.status().capabilities.releases, true);
  const created = (await (await fetch(url, { method: 'POST', headers, body })).json()).result;
  assert.equal(created.id, release.operationId);
  const exported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'work',
        root,
        JSON.stringify({ action: 'export-release', id: created.id }),
        '0',
      ],
      { encoding: 'utf8' },
    ),
  ).result;
  assert.equal(JSON.parse(exported.json).release.id, created.id);
  assert.equal(exported.bundle.head, accept.expectedHead);
  assert.equal(createHash('sha256').update(exported.json).digest('hex'), exported.sha256);
});
