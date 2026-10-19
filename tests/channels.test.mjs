// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t, format = 'sha1') {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n', 'README.md': '# Synthetic Channel fixture\n' });
  if (format === 'sha256') {
    rmSync(join(root, '.git'), { recursive: true });
    git(root, ['init', '-q', '--object-format=sha256']);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original source author']);
  const original = git(root, ['rev-parse', 'HEAD']).trim(),
    work = new WorkService(root);
  const run = command => work.execute(command, work.status().revision).result;
  const intent = run({ action: 'intent', outcome: 'Accept exact selected source' });
  const lane = run({ action: 'lane', intentId: intent.id, name: 'Selected candidate' });
  const view = text => {
    write(work.store.path(lane.id), 'a.ts', text);
    git(work.store.path(lane.id), ['add', 'a.ts']);
    const current = work.status().lanes.find(item => item.id === lane.id);
    const pin = run({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: current.actualHead,
      expectedTree: current.indexTree,
      message: text.trim(),
    });
    return run({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head: pin.head }] });
  };
  const first = view('export const a = 2;\n'),
    second = view('export const a = 3;\n');
  const command = (pin, previous = null, channel = 'main') => ({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel,
    viewId: pin.id,
    expectedHead: pin.head,
    expectedPrevious: previous,
  });
  const dispatch = input => work.dispatch(input, work.status().revision);
  return { root, work, run, intent, lane, original, first, second, command, dispatch };
}

test('Intents start from a pinned accepted Channel independently of checkout and retain its original receipt', async t => {
  for (const format of ['sha1', 'sha256']) {
    const { root, work, run, first, second, original, command, dispatch } = setup(t, format);
    const accepted = (await dispatch(command(first))).result;
    const baseChannel = { name: 'main', head: first.head, acceptanceId: accepted.id };
    write(root, 'a.ts', 'unfinished checkout');
    git(root, ['add', 'a.ts']);
    const tree = git(root, ['write-tree']),
      before = git(root, ['status', '--porcelain']);
    const intent = run({ action: 'intent', outcome: 'Next canonical change', baseChannel });
    assert.equal(intent.base, first.head);
    assert.deepEqual(intent.baseChannel, baseChannel);
    const lane = run({ action: 'lane', intentId: intent.id, name: 'Canonical next change' });
    assert.equal(lane.base, first.head);
    assert.equal(git(work.store.path(lane.id), ['rev-parse', 'HEAD']).trim(), first.head);
    assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'export const a = 2;\n');
    await dispatch(command(second, first.head));
    assert.deepEqual(
      new WorkService(root).status().intents.find(item => item.id === intent.id),
      intent,
    );
    const bytes = readWorkBytes(join(work.store.directory, 'work.json'));
    for (const pin of [
      baseChannel,
      { ...baseChannel, name: 'missing' },
      { ...baseChannel, head: second.head },
    ]) {
      assert.throws(
        () => run({ action: 'intent', outcome: 'Stale selection', baseChannel: pin }),
        code('CHANNEL_CHANGED'),
      );
      assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), bytes);
    }
    const rollback = (await dispatch(command(first, second.head))).result;
    assert.throws(
      () => run({ action: 'intent', outcome: 'ABA selection', baseChannel }),
      code('CHANNEL_CHANGED'),
    );
    assert.equal(
      run({
        action: 'intent',
        outcome: 'Current acceptance',
        baseChannel: { ...baseChannel, acceptanceId: rollback.id },
      }).base,
      first.head,
    );
    git(root, ['update-ref', `refs/forge/channel-moves/${rollback.id}`, second.head]);
    assert.throws(
      () =>
        run({
          action: 'intent',
          outcome: 'Altered receipt',
          baseChannel: { ...baseChannel, acceptanceId: rollback.id },
        }),
      code('CHANNEL_CHANGED'),
    );
    const checkout = run({ action: 'intent', outcome: 'Existing checkout default' });
    assert.equal(checkout.base, original);
    assert.equal(checkout.baseChannel, undefined);
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
    assert.equal(git(root, ['write-tree']), tree);
    assert.equal(git(root, ['status', '--porcelain']), before);
  }
});

test('Channels retain exact Git history through advance, rollback and native SHA-1/SHA-256 bundle round trips', async t => {
  for (const format of ['sha1', 'sha256']) {
    const { root, work, run, intent, lane, original, first, second, command, dispatch } = setup(t, format);
    const excluded = run({ action: 'lane', intentId: intent.id, name: 'Unselected private candidate' });
    const path = work.store.path(excluded.id);
    write(path, 'not-selected.ts', 'export const unselected = 1;');
    git(path, ['add', '.']);
    const staged = work.status().lanes.find(item => item.id === excluded.id);
    const other = run({
      action: 'checkpoint',
      laneId: excluded.id,
      expectedHead: staged.actualHead,
      expectedTree: staged.indexTree,
      message: 'Unselected commit',
    });
    write(path, 'not-selected.ts', 'unfinished edits');
    write(root, 'a.ts', 'original dirty checkout');
    git(root, ['add', 'a.ts']);
    const stagedRoot = git(root, ['write-tree']).trim();
    const marker = join(root, 'hook-executed');
    writeFileSync(join(root, '.git/hooks/reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    const start = command(first),
      initial = await dispatch(start);
    assert.equal(initial.result.status, 'accepted');
    assert.equal(initial.result.provenance, 'user-declared-local');
    const oldRevision = work.status().revision;
    await assert.rejects(work.dispatch(command(second, first.head), oldRevision - 1), code('WORK_STALE'));
    await assert.rejects(dispatch(command(second)), code('CHANNEL_CHANGED'));
    await assert.rejects(dispatch({ ...start, expectedHead: second.head }), code('CHANNEL_CHANGED'));
    await assert.rejects(dispatch(command(first, null, '../outside')), code('WORK_GIT_FAILED'));
    const advanced = await dispatch(command(second, first.head));
    assert.equal(work.status().channels[0].head, second.head);
    assert.equal((await work.dispatch(start, 0)).result.id, start.operationId); // Old operation cannot rewind a later acceptance.
    assert.equal(work.status().channels[0].head, second.head);
    const rollback = await dispatch(command(first, second.head));
    assert.equal(rollback.result.previous, second.head);
    assert.equal(work.status().channelMoves.length, 3);
    assert.equal(work.status().channels[0].moveId, rollback.result.id);
    const before = readWorkBytes(join(work.store.directory, 'work.json'));
    const bundle = (await dispatch({ action: 'export-channel', id: advanced.result.id })).result;
    assert.equal(bundle.head, second.head);
    assert.equal(statSync(bundle.path).mode & 0o777, 0o600);
    assert.equal(createHash('sha256').update(readFileSync(bundle.path)).digest('hex'), bundle.sha256);
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
    const clone = join(root, 'native-clone');
    git(root, ['clone', '--branch=accepted', '--', bundle.path, clone]);
    assert.equal(git(clone, ['rev-parse', 'HEAD']).trim(), second.head);
    assert.equal(git(clone, ['rev-parse', '--show-object-format']).trim(), format);
    assert.deepEqual(
      git(clone, ['log', '--format=%H %P %an %ae %s']),
      git(root, ['log', '--format=%H %P %an %ae %s', second.head]),
    );
    assert.equal(git(clone, ['ls-tree', '-r', 'HEAD']), git(root, ['ls-tree', '-r', second.head]));
    assert.match(git(clone, ['show', `${original}`]), /Original source author/);
    assert.equal(existsSync(join(clone, 'not-selected.ts')), false);
    assert.throws(() => git(clone, ['cat-file', '-e', other.head]));
    assert.equal(git(clone, ['for-each-ref', '--format=%(refname)']).includes('forge'), false);
    assert.equal(existsSync(join(clone, '.git/forge-work')), false);
    const oldBundle = (await dispatch({ action: 'export-channel', id: initial.result.id })).result;
    git(clone, ['fetch', '--', oldBundle.path, 'refs/heads/accepted']);
    assert.equal(git(clone, ['rev-parse', 'FETCH_HEAD']).trim(), first.head);
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
    assert.equal(git(root, ['write-tree']).trim(), stagedRoot);
    assert.equal(git(work.store.path(lane.id), ['rev-parse', 'HEAD']).trim(), second.head);
    assert.equal(readFileSync(join(path, 'not-selected.ts'), 'utf8'), 'unfinished edits');
    assert.equal(existsSync(marker), false);
  }
});

test('Channel journals reconcile lost replies and preserve later pointers, notes and atomic compare-and-swap failures', async t => {
  const { root, work, run, intent, first, second, command, dispatch } = setup(t);
  const save = work.store.save.bind(work.store);
  let input = command(first);
  work.store.save = () => {
    throw new Error('Before journal');
  };
  await assert.rejects(dispatch(input), /Before journal/);
  assert.throws(() => git(root, ['rev-parse', '--verify', 'refs/forge/channels/main']));
  assert.equal(work.store.load().channelMoves.length, 0);
  work.store.save = data => {
    save(data);
    throw new Error('Lost pending-journal reply');
  };
  await assert.rejects(dispatch(input), /Lost pending-journal reply/);
  assert.equal(work.store.load().channelMoves[0].status, 'pending');
  assert.throws(() => git(root, ['rev-parse', '--verify', 'refs/forge/channels/main']));
  work.store.save = save;
  assert.equal((await work.dispatch(input, 0)).result.status, 'accepted');
  input = command(second, first.head);
  work.store.save = data => {
    if (data.channelMoves.at(-1).status === 'accepted') throw new Error('Lost final journal');
    save(data);
  };
  await assert.rejects(dispatch(input), /Lost final journal/);
  assert.equal(work.store.load().channelMoves.at(-1).status, 'pending');
  assert.equal(git(root, ['rev-parse', 'refs/forge/channels/main']).trim(), second.head);
  assert.equal(work.status().channels[0].moveId, input.operationId);
  work.store.save = save;
  run({
    action: 'note',
    intentId: intent.id,
    kind: 'decision',
    text: 'Independent decision survives recovery.',
  });
  await dispatch(command(first, second.head));
  assert.equal((await work.dispatch(input, 0)).result.status, 'accepted');
  assert.equal(work.status().channels[0].head, first.head);
  assert.equal(work.status().channelMoves.length, 3);
  assert.equal(work.status().intents[0].notes[0].text, 'Independent decision survives recovery.');
  const racing = command(second, first.head);
  const refLock = join(root, '.git/refs/forge/channels/main.lock');
  work.store.save = data => {
    save(data);
    writeFileSync(refLock, 'another native Git writer', { flag: 'wx' });
  };
  await assert.rejects(dispatch(racing), code('WORK_GIT_FAILED'));
  assert.throws(() => git(root, ['rev-parse', '--verify', `refs/forge/channel-moves/${racing.operationId}`]));
  assert.equal(git(root, ['rev-parse', 'refs/forge/channels/main']).trim(), first.head);
  rmSync(refLock);
  git(root, ['update-ref', 'refs/forge/channels/main', second.head]);
  work.store.save = save;
  await assert.rejects(work.dispatch(racing, 0), code('CHANNEL_CHANGED'));
  git(root, ['update-ref', `refs/forge/channel-moves/${racing.operationId}`, first.head]);
  await assert.rejects(work.dispatch(racing, 0), code('CHANNEL_CHANGED'));
  assert.equal(git(root, ['rev-parse', `refs/forge/channel-moves/${racing.operationId}`]).trim(), first.head);
  git(root, ['update-ref', 'refs/forge/channels/main', intent.base]);
  assert.match(work.status().channels[0].diagnostic, /no matching/);
  git(root, ['update-ref', 'refs/forge/channels/external', second.head]);
  const external = work.status().channels.find(item => item.name === 'external');
  assert.equal(external.head, second.head);
  assert.match(external.diagnostic, /no matching/);
  await dispatch(command(first, external.head, external.name));
  run({
    action: 'note',
    intentId: intent.id,
    kind: 'comment',
    text: 'Unexpected pointer does not block notes.',
  });
  assert.equal(work.status().intents[0].notes.length, 2);
});

test('real HTTP and CLI Channel commands share existing capability protection and reject changed View pins', async t => {
  const { root, work, first, second, command, dispatch } = setup(t);
  git(root, ['update-ref', `refs/forge/views/${first.id}`, second.head]);
  await assert.rejects(dispatch(command(first)), code('VIEW_STALE'));
  assert.equal(work.status().channelMoves.length, 0);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    input = command(second);
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ command: input, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://outside.invalid' }, body }))
      .status,
    403,
  );
  const accepted = await (await fetch(url, { method: 'POST', headers, body })).json();
  assert.equal(accepted.result.head, second.head);
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'work',
        root,
        JSON.stringify({ action: 'export-channel', id: accepted.result.id }),
        String(work.status().revision),
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(
    git(root, ['bundle', 'list-heads', result.result.path]).trim(),
    `${second.head} refs/heads/accepted`,
  );
  assert.equal(work.status().channelMoves.length, 1);
});

test('incomplete shallow ancestry fails export without fetching or publishing an incomplete bundle', async t => {
  const { root, work, first, command, dispatch, original } = setup(t);
  const accepted = await dispatch(command(first));
  writeFileSync(join(root, '.git/shallow'), `${first.head}\n`);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  // A shallow boundary is harmless when the original objects are locally available: the bare export traverses full ancestry.
  const complete = (await dispatch({ action: 'export-channel', id: accepted.result.id })).result;
  const clone = join(root, 'complete-clone');
  git(root, ['clone', '--branch=accepted', '--', complete.path, clone]);
  assert.equal(git(clone, ['rev-parse', 'HEAD~1']).trim(), original);
  rmSync(complete.path);
  const parentObject = join(root, '.git/objects', original.slice(0, 2), original.slice(2)),
    bytes = readFileSync(parentObject);
  rmSync(parentObject);
  try {
    await assert.rejects(
      work.dispatch({ action: 'export-channel', id: accepted.result.id }, JSON.parse(before).revision),
      code('WORK_GIT_FAILED'),
    );
  } finally {
    writeFileSync(parentObject, bytes);
  }
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  assert.equal(
    readdirSync(work.store.directory).filter(name => name.endsWith('.bundle') || name.startsWith('publish-'))
      .length,
    0,
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(work.status().channels[0].head, first.head);
});
