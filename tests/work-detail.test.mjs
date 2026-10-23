// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkService } from '../dist/work.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, code } from './helpers.mjs';

function setup(t, native) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-detail-'));
  const resources = [];
  t.after(async () => {
    for (const resource of resources.toReversed()) await resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let root;
  if (native) {
    root = join(dir, 'owner');
    mkdirSync(root);
    writeFileSync(join(root, '.gitignore'), '.forge/\n');
    writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
    initNative(root);
  } else {
    root = fixture(t, { '.gitignore': '.forge/\n', 'a.ts': 'export const a=1;\n' });
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Initial']);
  }
  const w = new WorkService(root),
    data = () => w.store.load(),
    act = c => w.execute(c, data().revision).result;
  const intent = act({ action: 'intent', outcome: 'Review on demand' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' }),
    path = w.store.path(lane.id);
  const edit = value => writeFileSync(join(path, 'a.ts'), value);
  const checkpoint = () => {
    if (!native) git(path, ['add', '.']);
    const l = w.status().lanes[0];
    return act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: l.actualHead,
      expectedTree: l.indexTree,
      message: 'Candidate',
    });
  };
  const compose = () =>
    act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: data().lanes[0].head }],
    });
  const detail = l =>
    w.dispatch({ action: 'read-work-detail', kind: 'lane', id: l.id, expectedHead: l.actualHead }, 0);
  const viewDetail = v =>
    w.dispatch(
      {
        action: 'read-work-detail',
        kind: 'view',
        id: v.id,
        expectedHead: v.head,
        expectedBase: v.base,
        expectedStatus: v.status,
      },
      0,
    );
  return {
    dir,
    root,
    w,
    data,
    act,
    intent,
    lane,
    path,
    edit,
    checkpoint,
    compose,
    detail,
    viewDetail,
    resources,
  };
}

for (const native of [false, true])
  test(`${native ? 'native' : 'Git'} compact status preserves pins and full on-demand review, including external edits without Work revisions`, async t => {
    const f = setup(t, native);
    f.edit('export const a=2;\n');
    f.checkpoint();
    const old = f.compose(),
      same = f.compose();
    f.edit('export const a=3;\n');
    const revision = f.data().revision,
      full = f.w.status(),
      compact = f.w.status({ compact: true });
    assert.equal(compact.revision, revision);
    assert.equal(full.lanes[0].detailDeferred, undefined);
    assert.deepEqual(compact.pendingStatus, full.pendingStatus);
    assert.ok(full.lanes[0].diff);
    assert.ok(full.views[0].details);
    assert.equal(compact.lanes[0].diff, '');
    assert.equal(compact.views[0].details, '');
    assert.equal(compact.lanes[0].detailDeferred, true);
    assert.equal(compact.views[0].detailDeferred, true);
    for (const key of [
      'actualHead',
      'available',
      'base',
      'head',
      'checkpoints',
      ...(native ? [] : ['indexTree', 'changes', 'staged']),
    ])
      assert.deepEqual(compact.lanes[0][key], full.lanes[0][key]);
    for (const key of ['base', 'head', 'status', 'inputs', 'dependencies', 'operation'])
      assert.deepEqual(compact.views[0][key], full.views[0][key]);
    assert.deepEqual((await f.detail(compact.lanes[0])).result.lane, full.lanes[0]);
    assert.deepEqual((await f.viewDetail(old)).result.view, full.views[0]);
    assert.equal((await f.viewDetail(same)).result.view.id, same.id);
    f.edit('export const a=4;\n');
    const next = (await f.detail(compact.lanes[0])).result.lane;
    assert.equal(f.data().revision, revision);
    assert.notEqual(next.diff, full.lanes[0].diff);
    if (!native) git(f.path, ['add', 'a.ts']);
    else assert.notEqual(next.indexTree, compact.lanes[0].indexTree);
    assert.throws(
      () =>
        f.act({
          action: 'checkpoint',
          laneId: f.lane.id,
          expectedHead: next.actualHead,
          expectedTree: full.lanes[0].indexTree,
          message: 'Stale review',
        }),
      code('LANE_STALE'),
    );
    f.checkpoint();
    f.compose();
    assert.deepEqual((await f.viewDetail(old)).result.view, full.views[0]);
    await assert.rejects(f.viewDetail({ ...old, base: f.data().lanes[0].head }), code('VIEW_STALE'));
    await assert.rejects(f.detail({ ...compact.lanes[0], actualHead: null }), code('LANE_STALE'));
    await assert.rejects(
      f.w.dispatch({ action: 'read-work-detail', kind: 'lane', id: randomUUID(), expectedHead: null }, 0),
      code('NOT_FOUND'),
    );
    assert.equal(f.data().revision, revision + (native ? 2 : 3));
    if (!native) {
      renameSync(join(f.path, 'a.ts'), join(f.path, 'renamed.ts'));
      git(f.path, ['add', '.']);
      writeFileSync(join(f.path, 'untracked.ts'), 'export const c=1;');
      const l = f.w.status().lanes[0];
      assert.match(l.changes, /untracked/);
      assert.match(l.staged, /renamed/);
      assert.deepEqual((await f.detail(l)).result.lane, l);
      git(f.path, ['commit', '-qm', 'External staged change']);
      await assert.rejects(f.detail(l), code('LANE_STALE'));
    }
  });

test('native compact avoids historical diff expansion and detail retains binary/mode/conflict and missing object behavior with Git unavailable', async t => {
  const f = setup(t, true),
    shim = join(f.dir, 'bin'),
    sentinel = join(f.dir, 'git-used');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho used > '${sentinel}'\nexit 98\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = shim + ':' + previous;
  t.after(() => {
    process.env.PATH = previous;
    assert.equal(existsSync(sentinel), false);
  });
  writeFileSync(join(f.path, 'binary.bin'), Buffer.from([0, 255, 1]));
  chmodSync(join(f.path, 'a.ts'), 0o755);
  f.checkpoint();
  const view = f.compose();
  const full = f.w.status(),
    source = new NativeSource(f.root),
    blob = source.state(view.head).files.find(x => x.path === 'binary.bin').blob;
  const object = join(source.directory, blob);
  assert.match(full.views[0].details, /binary.bin/);
  assert.match(full.views[0].details, /mode/);
  assert.deepEqual((await f.viewDetail(view)).result.view, full.views[0]);
  const original = NativeSource.prototype.object;
  let reads = 0;
  NativeSource.prototype.object = function (id) {
    if (id === blob) reads++;
    return original.call(this, id);
  };
  try {
    f.w.status({ compact: true });
    assert.equal(reads, 0, 'Compact must avoid source-body diff reads');
  } finally {
    NativeSource.prototype.object = original;
  }
  const bytes = readFileSync(object);
  rmSync(object);
  f.w.status({ compact: true });
  await assert.rejects(f.viewDetail(view), code('INVALID_NATIVE_SOURCE'));
  writeFileSync(object, bytes, { mode: 0o600 });
  assert.deepEqual((await f.viewDetail(view)).result.view, full.views[0]);
  const second = f.act({ action: 'lane', intentId: f.intent.id, name: 'Conflicting candidate' });
  writeFileSync(join(f.w.store.path(second.id), 'a.ts'), 'export const a=7;\n');
  const secondFiles = source.capture(f.w.store.path(second.id), false, second.head);
  const updated = f.act({
    action: 'checkpoint',
    laneId: second.id,
    expectedHead: second.head,
    expectedTree: source.tree(secondFiles),
    message: 'Conflict',
  });
  f.edit('export const a=9;\n');
  f.checkpoint();
  const conflict = f.act({
    action: 'compose',
    intentId: f.intent.id,
    inputs: [
      { laneId: f.lane.id, head: f.data().lanes[0].head },
      { laneId: second.id, head: updated.head },
    ],
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(f.w.status({ compact: true }).views.at(-1).details, '');
  assert.equal((await f.viewDetail(conflict)).result.view.details, conflict.details);
});

test('compact external PR review preserves original observation pins without new provider reads', async t => {
  const f = setup(t, false),
    base = f.intent.base;
  f.edit('export const a=8;\n');
  f.checkpoint();
  const head = f.data().lanes[0].head,
    data = f.data();
  const observation = {
    at: new Date().toISOString(),
    head,
    base,
    headRef: 'candidate',
    baseRef: 'main',
    title: 'Original observation',
    author: { id: 1, login: 'fixture' },
    prState: 'open',
    merged: false,
    acceptance: 'unconfirmed',
    details: 'Synthetic retained observation; no provider call.',
  };
  data.intents[0].external = {
    repository: 'example/repo',
    number: 1,
    url: 'https://github.com/example/repo/pull/1',
    author: observation.author,
    observations: [observation],
  };
  f.w.store.save(data);
  const full = f.w.status(),
    compact = f.w.status({ compact: true });
  assert.equal(compact.intents[0].externalDiff, undefined);
  assert.equal(compact.intents[0].detailDeferred, true);
  assert.deepEqual(compact.intents[0].external, full.intents[0].external);
  const command = {
    action: 'read-work-detail',
    kind: 'external',
    id: f.intent.id,
    observation: 0,
    expectedHead: head,
    expectedBase: base,
  };
  assert.equal((await f.w.dispatch(command, 0)).result.details, full.intents[0].externalDiff);
  await assert.rejects(f.w.dispatch({ ...command, expectedBase: head }, 0), code('VIEW_STALE'));
  await assert.rejects(f.w.dispatch({ ...command, observation: 1 }, 0), code('NOT_FOUND'));
});

test('compact Work and detail retain protected HTTP and actual CLI/MCP parity', async t => {
  const f = setup(t, true);
  f.edit('export const a=2;\n');
  f.checkpoint();
  const view = f.compose(),
    command = {
      action: 'read-work-detail',
      kind: 'view',
      id: view.id,
      expectedHead: view.head,
      expectedBase: view.base,
      expectedStatus: view.status,
    };
  const server = await serveRepository(f.root, 0);
  f.resources.push(server);
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token'),
    headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url.origin + '/api/work?compact=true')).status, 401);
  assert.equal(
    (
      await fetch(url.origin + '/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, command }),
      })
    ).status,
    401,
  );
  const get = await fetch(url.origin + '/api/work?compact=true', { headers }),
    compact = await get.json();
  assert.equal(compact.views[0].detailDeferred, true);
  const posted = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers,
    body: JSON.stringify({ revision: 0, command }),
  });
  assert.equal(posted.status, 200);
  const expected = await posted.json();
  const cli = JSON.parse(
    execFileSync(process.execPath, [resolve('dist/cli.js'), 'work', f.root, '--compact'], {
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(cli, compact);
  const cliDetail = JSON.parse(
    execFileSync(process.execPath, [resolve('dist/cli.js'), 'work', f.root, JSON.stringify(command), '0'], {
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(cliDetail, expected);
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    }),
    client = new Client({ name: 'detail-acceptance', version: '1' });
  f.resources.push(client);
  await client.connect(transport);
  const result = async (name, args) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  assert.deepEqual(await result('forge_work_status', { compact: true }), compact);
  assert.deepEqual(await result('forge_work_command', { command, revision: 0 }), expected);
  assert.ok((await result('forge_work_status', {})).views[0].details);
});

test('native compact overview does not capture unrelated source; selected detail verifies its live bytes', async t => {
  const f = setup(t, true),
    other = f.act({ action: 'lane', intentId: f.intent.id, name: 'Cold unrelated Lane' });
  const capture = NativeSource.prototype.captureReport,
    paths = [];
  NativeSource.prototype.captureReport = function (root, ...args) {
    paths.push(root);
    if (root === f.w.store.path(other.id)) throw Error('Unrelated source unavailable');
    return capture.call(this, root, ...args);
  };
  t.after(() => {
    NativeSource.prototype.captureReport = capture;
  });
  const before = readWorkBytes(join(f.w.store.directory, 'work.json')),
    overview = f.w.status({ compact: true });
  assert.deepEqual(paths, []);
  assert.equal(overview.lanes[0].indexTree, null);
  f.edit('export const a=99;');
  const selected = (await f.detail(overview.lanes[0])).result.lane;
  assert.deepEqual(paths, [f.path]);
  assert.match(selected.diff, /99/);
  assert.ok(selected.indexTree);
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  await assert.rejects(f.detail(overview.lanes[1]), /Unrelated source unavailable/);
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
});

test('native compact status leaves existing interrupted source for exact original-Lane resume', async t => {
  const f = setup(t, true),
    original = f.data();
  original.lanes[0].state = 'creating';
  f.w.store.save(original);
  const capture = NativeSource.prototype.captureReport;
  NativeSource.prototype.captureReport = function () {
    throw Error('Cold interrupted source');
  };
  try {
    assert.equal(f.w.status({ compact: true }).lanes[0].state, 'creating');
  } finally {
    NativeSource.prototype.captureReport = capture;
  }
  const resumed = f.act({ action: 'resume', laneId: f.lane.id });
  assert.equal(resumed.id, f.lane.id);
  assert.equal(resumed.state, 'active');
  assert.equal(f.data().lanes.length, 1);
  const changed = f.data();
  changed.lanes[0].state = 'creating';
  f.w.store.save(changed);
  f.edit('unfinished native source');
  const before = readWorkBytes(join(f.w.store.directory, 'work.json'));
  assert.throws(() => f.act({ action: 'resume', laneId: f.lane.id }), code('LANE_UNAVAILABLE'));
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  assert.equal(readFileSync(join(f.path, 'a.ts'), 'utf8'), 'unfinished native source');
});

test('one missing native Lane remains an unavailable full-status record and cannot hide usable Work', async t => {
  const f = setup(t, true),
    missing = f.act({ action: 'lane', intentId: f.intent.id, name: 'Missing interrupted Lane' });
  rmSync(f.w.store.path(missing.id), { recursive: true });
  const data = f.data();
  data.lanes.find(l => l.id === missing.id).state = 'creating';
  f.w.store.save(data);
  const full = f.w.status();
  assert.equal(full.lanes[0].available, true);
  assert.equal(full.lanes[1].available, false);
  assert.equal(full.intents[0].id, f.intent.id);
  await assert.rejects(f.detail(full.lanes[1]), code('LANE_UNAVAILABLE'));
});
