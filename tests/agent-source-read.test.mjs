// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { SHOW_MAX_BYTES } from '../dist/agent-source-read.js';
import { fixture as gitFixture, git, code } from './helpers.mjs';
import { readWorkBytes } from './work-store-fixture.mjs';

function fixture(t, native) {
  const root = native ? mkdtempSync(join(tmpdir(), 'forge-source-read-')) : gitFixture(t);
  if (native) t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), '\ufeffone\r\nlast');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'colon:name.txt'), 'nested');
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 255, 1]));
  writeFileSync(join(root, 'invalid.dat'), Buffer.from([255, 254]));
  writeFileSync(join(root, 'large.txt'), 'x'.repeat(SHOW_MAX_BYTES + 1));
  writeFileSync(join(root, 'huge.txt'), 'h'.repeat(4 * 1024 * 1024 + 1));
  symlinkSync('a.txt', join(root, 'link'));
  if (native) initNative(root);
  else {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Synthetic source']);
  }
  const agent = new AgentWorkflow(root);
  return { root, agent, act: (action, input = {}) => agent.dispatch({ action, ...input }) };
}
for (const native of [true, false]) {
  const label = native ? 'native' : 'Git';
  test(`${label} diff reuses live Lane review and reads immutable State comparisons`, async t => {
    const f = fixture(t, native),
      lane = (await f.act('start', { outcome: 'Source reads' })).result;
    writeFileSync(join(lane.path, 'a.txt'), 'two\n');
    writeFileSync(join(lane.path, 'added.txt'), 'new\n');
    rmSync(join(lane.path, 'empty.txt'));
    const summary = (await f.act('diff', { laneId: lane.laneId })).result;
    assert.equal(summary.total, 3);
    assert.equal(
      summary.changes.some(change => 'hunks' in change),
      false,
    );
    const filtered = (await f.act('diff', { laneId: lane.laneId, paths: ['a.txt'] })).result;
    assert.equal(filtered.selectedTotal, 1);
    assert.equal(filtered.changes[0].path, 'a.txt');
    assert.ok(filtered.changes[0].hunks.length);
    const page = (await f.act('diff', { laneId: lane.laneId, limit: 1 })).result;
    assert.equal(page.nextOffset, 1);
    assert.equal(
      (await f.act('diff', { laneId: lane.laneId, offset: 1, expectedReviewTree: page.reviewTree })).result
        .changes.length,
      2,
    );
    if (!native) git(lane.path, ['add', '.']);
    const saved = (await f.act('checkpoint', { laneId: lane.laneId, message: 'Two' })).result;
    const request = { from: lane.base, to: saved.head, paths: ['a.txt'] },
      pinned = (await f.act('diff', request)).result;
    assert.equal(pinned.base, lane.base);
    assert.equal(pinned.head, saved.head);
    assert.equal(pinned.kind, 'states');
    assert.ok(pinned.changes[0].hunks.length);
    writeFileSync(join(lane.path, 'a.txt'), 'later');
    assert.deepEqual((await f.act('diff', request)).result, pinned);
    await assert.rejects(f.act('diff', { laneId: lane.laneId, expectedHead: lane.head }), code('VIEW_STALE'));
    await assert.rejects(
      f.act('diff', { laneId: lane.laneId, expectedReviewTree: page.reviewTree }),
      code('SOURCE_CHANGED'),
    );
    assert.equal((await f.act('diff', { from: saved.head, to: saved.head })).result.total, 0);
    writeFileSync(join(lane.path, 'a.txt'), 'z'.repeat(10000));
    const bounded = await f.act('diff', { laneId: lane.laneId, paths: ['a.txt'], maxBytes: 2048 });
    assert.equal(bounded.result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 2048);
  });
  test(`${label} show selects saved bytes and preserves raw CLI output and MCP-safe encoding`, async t => {
    const f = fixture(t, native),
      lane = (await f.act('start', { outcome: 'Show pinned bytes' })).result,
      before = readWorkBytes(join(f.agent.work.store.directory, 'work.json'));
    const show = (path, extra = {}) => f.act('show', { state: lane.head, path, ...extra });
    const text = (await show('a.txt')).result;
    assert.equal(text.state, lane.head);
    assert.equal(text.content, '\ufeffone\r\nlast');
    assert.equal(text.encoding, 'utf8');
    assert.equal((await show('nested/colon:name.txt')).result.content, 'nested');
    assert.equal((await show('empty.txt')).result.size, 0);
    assert.equal((await show('link')).result.content, 'a.txt');
    for (const path of ['binary.dat', 'invalid.dat']) {
      await assert.rejects(show(path), code('BINARY_FILE'));
      const result = (await show(path, { force: true })).result;
      assert.equal(result.encoding, 'base64');
    }
    await assert.rejects(show('large.txt'), code('FILE_LIMIT'));
    assert.equal((await show('large.txt', { force: true })).result.size, SHOW_MAX_BYTES + 1);
    assert.equal((await show('huge.txt', { force: true })).result.size, 4 * 1024 * 1024 + 1);
    await assert.rejects(show('missing.txt'), code('NOT_FOUND'));
    await assert.rejects(show('nested'), code('NOT_FOUND'));
    writeFileSync(join(lane.path, 'a.txt'), 'unsaved');
    assert.equal((await f.act('show', { laneId: lane.laneId, path: 'a.txt' })).result.content, text.content);
    assert.deepEqual(readWorkBytes(join(f.agent.work.store.directory, 'work.json')), before);
    const cli = input =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), 'agent', f.root, 'show', JSON.stringify(input)]);
    const raw = cli({ laneId: lane.laneId, path: 'a.txt' });
    assert.equal(raw.status, 0, raw.stderr.toString());
    assert.deepEqual(raw.stdout, Buffer.from('\ufeffone\r\nlast'));
    const binary = cli({ state: lane.head, path: 'binary.dat', force: true });
    assert.equal(binary.status, 0, binary.stderr.toString());
    assert.deepEqual(binary.stdout, Buffer.from([0, 255, 1]));
    assert.equal(cli({ state: lane.head, path: 'empty.txt' }).stdout.length, 0);
    const rejected = cli({ state: lane.head, path: 'binary.dat' });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout.length, 0);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'BINARY_FILE');
    if (!native) git(lane.path, ['add', '.']);
    const saved = (await f.act('checkpoint', { laneId: lane.laneId, message: 'Saved change' })).result;
    assert.equal((await f.act('show', { laneId: lane.laneId, path: 'a.txt' })).result.content, 'unsaved');
    assert.equal((await show('a.txt')).result.content, text.content);
    assert.notEqual(saved.head, lane.head);
  });
}

test('source-read actions validate selectors, full digests and contained paths', async t => {
  const f = fixture(t, true),
    lane = (await f.act('start', { outcome: 'Invalid selectors' })).result;
  for (const input of [
    { action: 'diff' },
    { action: 'diff', from: lane.head },
    { action: 'diff', from: 'abcd', to: lane.head },
    { action: 'diff', laneId: lane.laneId, from: lane.head, to: lane.head },
    { action: 'diff', laneId: lane.laneId, paths: ['../outside'] },
    { action: 'show', path: 'a.txt' },
    { action: 'show', laneId: lane.laneId, state: lane.head, path: 'a.txt' },
    { action: 'show', state: 'main', path: 'a.txt' },
    ...['../outside', '/absolute', 'nested/../a.txt', 'nested\\a.txt'].map(path => ({
      action: 'show',
      state: lane.head,
      path,
    })),
  ])
    await assert.rejects(f.agent.dispatch(input), code('BAD_ARGUMENT'));
  const missing = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(f.act('diff', { laneId: missing }), code('NOT_FOUND'));
  await assert.rejects(f.act('show', { laneId: missing, path: 'a.txt' }), code('NOT_FOUND'));
  await assert.rejects(
    f.act('show', { state: '0'.repeat(64), path: 'a.txt' }),
    code('INVALID_NATIVE_SOURCE'),
  );
});

test('diff and show action help works without opening an owner', () => {
  for (const action of ['diff', 'show']) {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'agent', '/unavailable/owner', action, '--help'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /laneId/);
    assert.match(result.stdout, action === 'show' ? /force:true/ : /from\/to/);
  }
});
