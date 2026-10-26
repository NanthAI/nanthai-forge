// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmSync,
  chmodSync,
  existsSync,
  symlinkSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { Workspace } from '../dist/workspace.js';
import { McpSourceRouting } from '../dist/mcp-source.js';
import { fixture, git, write } from './helpers.mjs';

const files = {
  '.gitignore': '.forge/\n',
  'a.ts': 'export const value = 1;\n',
  'b.ts': 'import { value } from "./a"; export const answer = value;\n',
};
function setup(t, native) {
  const root = native ? mkdtempSync(join(tmpdir(), 'forge-mcp-native-lanes-')) : fixture(t, files);
  let env = process.env,
    called;
  if (native) {
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, bytes] of Object.entries(files)) write(root, path, bytes);
    initNative(root);
    const bin = join(root, '.forge', 'no-git');
    mkdirSync(bin);
    called = join(root, '.forge', 'git-called');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
    chmodSync(join(bin, 'git'), 0o700);
    env = { ...process.env, PATH: bin };
  } else {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Synthetic baseline']);
  }
  return { root: realpathSync(root), env, called };
}
async function connect(t, root, env, work = true) {
  const client = new Client({ name: 'forge-lane-source-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', root, ...(work ? ['--work'] : [])],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    // Concurrent owner observers can legitimately report FIFO lock progress on
    // stderr. Protocol output is still parsed by the SDK; other diagnostics fail.
    const diagnostics = stderr.split('\n').filter(line => line && !line.startsWith('waiting for lock: '));
    assert.deepEqual(diagnostics, []);
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse(response.content[0].text);
  };
  const status = () => call('forge_work_status', { compact: true });
  const act = async command => call('forge_work_command', { command, revision: (await status()).revision });
  return { client, transport, call, status, act };
}

for (const native of [false, true])
  test(`real MCP explicit Lane context isolates source and retains ${native ? 'native' : 'Git'} Work owner`, async t => {
    const { root, env, called } = setup(t, native),
      m = await connect(t, root, env);
    const tools = (await m.client.listTools()).tools;
    assert.equal(tools.length, 10);
    for (const tool of tools.filter(tool => !tool.name.startsWith('forge_work_')))
      assert.ok(tool.inputSchema.properties.laneId);
    await m.call('forge_reindex');
    const original = await m.call('forge_current');
    const rootArtifact = readFileSync(join(root, '.forge', 'index.json'));
    const intent = (await m.act({ action: 'intent', outcome: 'Explicit Lane context' })).result;
    const first = (await m.act({ action: 'lane', intentId: intent.id, name: 'First' })).result;
    const second = (await m.act({ action: 'lane', intentId: intent.id, name: 'Second' })).result;
    const status = await m.status(),
      a = status.lanes.find(lane => lane.id === first.id),
      b = status.lanes.find(lane => lane.id === second.id);
    write(a.path, 'a.ts', 'export const value = 2;\n');
    write(b.path, 'a.ts', 'export const value = 3;\n');
    write(a.path, 'only.ts', 'export const firstOnly = 2;\n');
    write(b.path, 'only.ts', 'export const secondOnly = 3;\n');
    const store = new WorkService(root).store,
      beforeWork = readWorkBytes(join(store.directory, 'work.json'));
    const nativeObjects = () =>
      readdirSync(join(store.directory, 'objects'))
        .sort()
        .map(name => [name, readFileSync(join(store.directory, 'objects', name))]);
    const objectsBefore = native ? nativeObjects() : null;
    const indexBefore = native ? null : git(a.path, ['write-tree']);
    const cold = await m.call('forge_current', { laneId: first.id });
    assert.equal(cold.error.code, 'INDEX_MISSING');
    assert.equal(cold.sourceContext.sourceRoot, a.path);
    const [indexedA, indexedB] = await Promise.all([
      m.call('forge_reindex', { laneId: first.id }),
      m.call('forge_reindex', { laneId: second.id }),
    ]);
    assert.notEqual(indexedA.sourceId, indexedB.sourceId);
    for (const [lane, expected] of [
      [a, 2],
      [b, 3],
    ]) {
      const selector = { laneId: lane.id },
        current = await m.call('forge_current', selector);
      assert.equal(current.freshness, 'current');
      assert.equal(current.sourceContext.startupRoot, root);
      assert.equal(current.sourceContext.sourceRoot, lane.path);
      assert.equal(current.sourceContext.workDirectory, store.directory);
      assert.equal(current.sourceContext.recordedHead, lane.head);
      assert.equal(current.sourceContext.workRevision, status.revision);
      const contextual = await m.call('forge_context', { ...selector, search: 'Only' });
      assert.equal(
        contextual.results.find(item => item.name)?.name,
        expected === 2 ? 'firstOnly' : 'secondOnly',
      );
      const inspected = await m.call('forge_inspect', { ...selector, symbol: 'value' });
      const referenced = await m.call('forge_references', { ...selector, symbol: inspected.results[0].id });
      assert.ok(referenced.total > 0);
      const traced = await m.call('forge_trace', { ...selector, file: 'b.ts' });
      assert.equal(traced.results[0].target, 'a.ts');
      const impacted = await m.call('forge_impact', { ...selector, file: 'a.ts' });
      assert.equal(impacted.results[0].from, 'b.ts');
      const source = await m.call('forge_source', { ...selector, file: 'a.ts' });
      assert.equal(source.results[0].text, `export const value = ${expected};\n`);
      for (const response of [contextual, inspected, referenced, traced, impacted, source]) {
        assert.equal(response.sourceContext.laneId, lane.id);
        assert.equal(response.sourceId, current.sourceId);
      }
    }
    const parallel = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        m.call('forge_source', { laneId: i % 2 ? a.id : b.id, file: 'a.ts' }),
      ),
    );
    assert.deepEqual(
      parallel.map(response => response.results[0].text),
      Array.from({ length: 8 }, (_, i) => `export const value = ${i % 2 ? 2 : 3};\n`),
    );
    const [refresh1, refresh2] = await Promise.all([
      m.call('forge_reindex', { laneId: a.id }),
      m.call('forge_reindex', { laneId: a.id }),
    ]);
    assert.deepEqual(refresh1, refresh2);
    assert.deepEqual(await m.call('forge_current'), original);
    assert.equal((await m.call('forge_source', { file: 'a.ts' })).results[0].text, files['a.ts']);
    assert.deepEqual(readFileSync(join(root, '.forge', 'index.json')), rootArtifact);
    assert.deepEqual(readWorkBytes(join(store.directory, 'work.json')), beforeWork);
    if (!native) assert.equal(git(a.path, ['write-tree']), indexBefore);
    write(a.path, 'a.ts', 'export const value = 4;\n');
    const stale = await m.call('forge_source', { laneId: a.id, file: 'a.ts' });
    assert.equal(stale.error.code, 'SOURCE_STALE');
    assert.equal(stale.sourceContext.laneId, a.id);
    assert.equal((await m.call('forge_current', { laneId: b.id })).freshness, 'current');
    await m.call('forge_reindex', { laneId: a.id });
    renameSync(join(a.path, 'only.ts'), join(a.path, 'renamed.ts'));
    assert.equal(
      (await m.call('forge_inspect', { laneId: a.id, symbol: 'firstOnly' })).error.code,
      'SOURCE_STALE',
    );
    await m.call('forge_reindex', { laneId: a.id });
    assert.equal(
      (await m.call('forge_inspect', { laneId: a.id, symbol: 'firstOnly' })).results[0].locator.file,
      'renamed.ts',
    );
    unlinkSync(join(a.path, 'renamed.ts'));
    await m.call('forge_reindex', { laneId: a.id });
    assert.equal((await m.call('forge_inspect', { laneId: a.id, symbol: 'firstOnly' })).total, 0);
    // A Lane-rooted restart shares Work and can explicitly query a sibling without changing its default.
    const restarted = await connect(t, a.path, env);
    assert.equal((await restarted.status()).revision, (await m.status()).revision);
    const sibling = await restarted.call('forge_source', { laneId: b.id, file: 'a.ts' });
    assert.equal(sibling.results[0].text, 'export const value = 3;\n');
    assert.equal(sibling.sourceContext.startupRoot, a.path);
    assert.equal(
      (await restarted.call('forge_source', { file: 'a.ts' })).results[0].text,
      'export const value = 4;\n',
    );
    const unknown = randomUUID();
    assert.equal((await m.call('forge_current', { laneId: unknown })).error.code, 'NOT_FOUND');
    const foreign = setup(t, native),
      foreignWork = new WorkService(foreign.root);
    const foreignIntent = foreignWork.execute(
      { action: 'intent', outcome: 'Another owner' },
      foreignWork.store.load().revision,
    ).result;
    const foreignLane = foreignWork.execute(
      { action: 'lane', intentId: foreignIntent.id, name: 'Foreign' },
      foreignWork.store.load().revision,
    ).result;
    const foreignRead = await m.call('forge_current', { laneId: foreignLane.id });
    assert.equal(foreignRead.error.code, 'NOT_FOUND');
    assert.equal(foreignRead.sourceContext.sourceRoot, undefined);
    assert.equal(existsSync(join(foreignWork.store.path(foreignLane.id), '.forge', 'index.json')), false);
    const missingPath = a.path + '-held';
    renameSync(a.path, missingPath);
    assert.equal(
      (await m.call('forge_source', { laneId: a.id, file: 'a.ts' })).error.code,
      'LANE_UNAVAILABLE',
    );
    symlinkSync(b.path, a.path, 'dir');
    assert.equal((await m.call('forge_current', { laneId: a.id })).error.code, 'LANE_UNAVAILABLE');
    unlinkSync(a.path);
    renameSync(missingPath, a.path);
    assert.deepEqual(await m.call('forge_current'), original);
    assert.deepEqual(readWorkBytes(join(store.directory, 'work.json')), beforeWork);
    if (native) {
      assert.equal(existsSync(called), false);
      assert.deepEqual(nativeObjects(), objectsBefore);
    }
  });

test('source-only MCP keeps eight tools and reports explicitly requested Lane selection unsupported', async t => {
  const { root, env } = setup(t, false),
    m = await connect(t, root, env, false);
  assert.equal((await m.client.listTools()).tools.length, 8);
  const requested = randomUUID(),
    selected = await m.call('forge_current', { laneId: requested });
  assert.equal(selected.error.code, 'WORK_DISABLED');
  assert.equal(selected.sourceContext.laneId, requested);
  assert.equal(existsSync(join(root, '.git', 'forge-work')), false);
  await m.call('forge_reindex');
  assert.equal((await m.call('forge_current')).freshness, 'current');
  const invalid = await m.client.callTool({
    name: 'forge_source',
    arguments: { laneId: '../elsewhere', file: 'a.ts' },
  });
  assert.equal(invalid.isError, true);
});

test('selected refresh reuses the existing Workspace promise and closes its real worker without Work writes', async t => {
  const { root } = setup(t, true),
    work = new WorkService(root);
  const act = command => work.execute(command, work.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Worker lifecycle' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Refresh' });
  const before = readWorkBytes(join(work.store.directory, 'work.json')),
    routing = new McpSourceRouting(new Workspace(root), work.store);
  t.after(() => routing.close());
  const pending = routing.run(lane.id, workspace => workspace.reindex());
  const interrupted = assert.rejects(
    pending,
    error => ['INDEX_STOPPED', 'INDEX_FAILED'].includes(error.code) && error.sourceContext.laneId === lane.id,
  );
  await routing.close();
  await interrupted;
  await assert.rejects(
    routing.run(lane.id, workspace => workspace.reindex()),
    error => error.code === 'WORKSPACE_CLOSED',
  );
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
});
