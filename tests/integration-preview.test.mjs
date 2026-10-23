import { previewMeasurements } from '../dist/preview-accounting.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { integrationPreview } from '../dist/integration-preview.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { agentPeers } from '../dist/agent-peers.js';

const compiler = resolve('node_modules/typescript/lib/tsc.js');
async function fixture(t, { check = true, baselineBad = false, packageScript = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-integration-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'types.ts'), 'export function value(): {a: string} { return {a: "ok"}; }\n');
  writeFileSync(
    join(root, 'consumer.ts'),
    'import {value} from "./types";\nexport const result = value();\n',
  );
  writeFileSync(
    join(root, 'other.ts'),
    baselineBad ? 'export const other: number = "bad";\n' : 'export const other = 1;\n',
  );
  const args = [compiler, '--noEmit', '--strict', '--skipLibCheck', 'types.ts', 'consumer.ts', 'other.ts'];
  if (packageScript)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: [process.execPath, ...args].map(value => JSON.stringify(value)).join(' '),
        },
      }),
    );
  const initial = initNative(root),
    agent = new AgentWorkflow(root),
    store = agent.work.store;
  // Synthetic main receipt avoids running any check/landing infrastructure.
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: initial.head,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  if (check)
    await agent.dispatch({
      action: 'define-check',
      name: 'Fixture types',
      static: true,
      executable: process.execPath,
      args,
      environmentLabel: 'Local TypeScript fixture',
    });
  const save = async (lane, path, text) => {
    writeFileSync(join(lane.path, path), text);
    const saved = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Fixture save' })
    ).result;
    lane.head = saved.head;
    return saved;
  };
  const start = async () =>
    (await agent.dispatch({ action: 'start', outcome: 'Synthetic integration change' })).result;
  const pair = async () => {
    const a = await start(),
      b = await start();
    await save(a, 'types.ts', 'export function value(): {a?: string} { return {a: "ok"}; }\n');
    await save(
      b,
      'consumer.ts',
      'import {value} from "./types";\nexport const result: string = value().a;\n',
    );
    return [a, b];
  };
  return {
    root,
    agent,
    store,
    save,
    start,
    pair,
    integrate: (input = {}) => integrationPreview(store, input).result,
  };
}

test('two individually type-correct Lanes clash together; both receive pinned notices and historical replay', async t => {
  const f = await fixture(t),
    lanes = await f.pair();
  const workBefore = readFileSync(join(f.store.directory, 'work.json'));
  const objectsBefore = readdirSync(join(f.store.directory, 'objects')).sort();
  const result = f.integrate();
  assert.equal(previewMeasurements(f.store.directory).rows.length, 1);
  assert.equal(result.status, 'clash');
  assert.equal(result.cached, false);
  assert.equal(result.pairs.length, 1);
  assert.deepEqual(new Set(result.pairs[0].laneIds), new Set(lanes.map(l => l.laneId)));
  assert.match(result.pairs[0].errors.join('\n'), /consumer.ts.*error TS2322/);
  assert.ok(result.individual.every(item => item.result.status === 'passed'));
  for (const lane of lanes) {
    const context = new CoordinationJournal(f.store).context(lane.laneId);
    assert.equal(context.notices.length, 1);
    assert.equal(context.messages.length, 1);
    assert.match(context.messages[0].text, /pass alone.*fail together/);
    assert.ok(
      agentPeers(f.store, { laneId: lane.laneId }).notices.some(n => /Integration preview/.test(n.text)),
    );
  }
  assert.deepEqual(readFileSync(join(f.store.directory, 'work.json')), workBefore);
  assert.deepEqual(readdirSync(join(f.store.directory, 'objects')).sort(), objectsBefore);
  const replay = f.integrate();
  assert.equal(replay.cached, false);
  assert.equal(previewMeasurements(f.store.directory).rows.length, 2);
  assert.deepEqual(replay.historical, { key: result.key, status: result.status });
  assert.equal(replay.status, result.status);
  assert.equal(new CoordinationJournal(f.store).context(lanes[0].laneId).notices.length, 1);
  await f.save(lanes[1], 'consumer.ts', 'import {value} from "./types";\nexport const result = value();\n');
  const changed = f.integrate();
  assert.equal(changed.cached, false);
  assert.equal(changed.status, 'clean');
  assert.notEqual(changed.key, result.key);
  assert.ok(
    !agentPeers(f.store, { laneId: lanes[0].laneId }).notices?.some(n => /Integration preview/.test(n.text)),
  );
});

test('three Lanes report only the failing pair; explicit selection ignores an unrelated Lane', async t => {
  const f = await fixture(t),
    lanes = await f.pair(),
    c = await f.start();
  await f.save(c, 'other.ts', 'export const other = 2;\n');
  const result = f.integrate();
  assert.equal(result.status, 'clash');
  assert.equal(result.inputs.length, 3);
  assert.equal(result.pairs.length, 1);
  assert.deepEqual(new Set(result.pairs[0].laneIds), new Set(lanes.map(l => l.laneId)));
  assert.equal(new CoordinationJournal(f.store).context(c.laneId).notices.length, 0);
  const selected = f.integrate({ laneIds: [lanes[0].laneId, c.laneId] });
  assert.equal(selected.status, 'clean');
  assert.equal(selected.notices.length, 0);
});

test('non-clashing Lanes are clean and unsaved working copy changes are excluded', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  await f.save(a, 'types.ts', 'export function value(): {a?: string} { return {}; }\n');
  await f.save(b, 'other.ts', 'export const other = 3;\n');
  writeFileSync(join(a.path, 'types.ts'), 'this is unsaved invalid TypeScript');
  const result = f.integrate();
  assert.equal(result.status, 'clean');
  assert.equal(result.notices.length, 0);
  assert.equal(new CoordinationJournal(f.store).context(a.laneId).notices.length, 0);
  assert.equal(readFileSync(join(a.path, 'types.ts'), 'utf8'), 'this is unsaved invalid TypeScript');
});

test('a failing individual Lane is not blamed on another Lane', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  await f.save(a, 'other.ts', 'export const other: string = 7;\n');
  await f.save(b, 'consumer.ts', 'import {value} from "./types";\nexport const result = value().a;\n');
  const result = f.integrate();
  assert.equal(result.status, 'failed');
  assert.equal(result.pairs.length, 0);
  assert.equal(result.individual.find(row => row.laneId === a.laneId).result.status, 'failed');
  assert.equal(result.notices.length, 0);
});

test('an already failing main reports baseline failure without clashing notices', async t => {
  const f = await fixture(t, { baselineBad: true });
  await f.pair();
  const result = f.integrate();
  assert.equal(result.status, 'baseline-failed');
  assert.equal(result.pairs.length, 0);
  assert.equal(result.notices.length, 0);
});

test('text composition conflicts remain distinct from semantic failures', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  await f.save(a, 'other.ts', 'export const other = 2;\n');
  await f.save(b, 'other.ts', 'export const other = 3;\n');
  const result = f.integrate();
  assert.equal(result.status, 'text-conflict');
  assert.deepEqual(result.combined.errors, ['other.ts']);
  assert.equal(result.notices.length, 0);
});

test('CLI registers integrate and uses existing package static scripts without marked definitions', async t => {
  const f = await fixture(t, { check: false, packageScript: true });
  await f.pair();
  const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'agent', f.root, 'integrate', '{}'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout).result;
  assert.equal(result.status, 'clash');
  assert.deepEqual(
    result.checks.map(check => check.name),
    ['typecheck'],
  );
});

test('missing configuration, empty selection and invalid Lane IDs are explicit', async t => {
  const f = await fixture(t, { check: false });
  assert.equal(f.integrate().status, 'no-lanes');
  const lane = await f.start();
  assert.throws(() => f.integrate({ laneIds: [lane.laneId] }), { code: 'INTEGRATION_LANE_UNAVAILABLE' });
  await f.save(lane, 'other.ts', 'export const other = 2;\n');
  assert.equal(f.integrate().status, 'not-configured');
  assert.throws(() => f.integrate({ laneIds: [lane.laneId, lane.laneId] }), { code: 'BAD_ARGUMENT' });
  assert.throws(() => f.integrate({ laneIds: [randomUUID()] }), { code: 'INTEGRATION_LANE_UNAVAILABLE' });
});

test('a check launch error is inconclusive, is not reused and emits no notices', async t => {
  const f = await fixture(t, { check: false });
  await f.pair();
  await f.agent.dispatch({
    action: 'define-check',
    name: 'Unavailable check',
    static: true,
    executable: join(f.root, 'missing-compiler'),
    args: [],
  });
  for (let i = 0; i < 2; i++) {
    const result = f.integrate();
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.combined.code, 'INTEGRATION_CHECK_ERROR');
    assert.equal(result.cached, false);
  }
  assert.equal(new CoordinationJournal(f.store).context().notices.length, 0);
});

test('main and static definition changes invalidate the cache and current peer advice', async t => {
  const f = await fixture(t),
    lanes = await f.pair(),
    original = f.integrate();
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(f.root);
  const main = source.writeState(
    source.state(original.main).files,
    [original.main],
    'Synthetic main advance',
    new Date().toISOString(),
  );
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: main,
      previous: original.main,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    f.store.commitRecords(tx);
  });
  assert.ok(
    !agentPeers(f.store, { laneId: lanes[0].laneId }).notices?.some(n => /Integration preview/.test(n.text)),
  );
  const advanced = f.integrate();
  assert.equal(advanced.cached, false);
  assert.notEqual(advanced.key, original.key);
  assert.equal(advanced.main, main);
  const check = f.store.load().checks[0];
  await f.agent.dispatch({
    action: 'define-check',
    checkId: check.id,
    name: check.name,
    static: true,
    executable: check.executable,
    args: [...check.args, '--pretty', 'false'],
    environmentLabel: check.environmentLabel,
  });
  const changed = f.integrate();
  assert.equal(changed.cached, false);
  assert.notEqual(changed.key, advanced.key);
});

test('static commands receive the existing private check environment, never undeclared process values', async t => {
  const f = await fixture(t, { check: false });
  const lane = await f.start();
  await f.save(lane, 'other.ts', 'export const other = 2;\n');
  const original = process.env.FORGE_INTEGRATION_SYNTHETIC_SECRET;
  process.env.FORGE_INTEGRATION_SYNTHETIC_SECRET = 'synthetic-fixture-value';
  t.after(() => {
    if (original === undefined) delete process.env.FORGE_INTEGRATION_SYNTHETIC_SECRET;
    else process.env.FORGE_INTEGRATION_SYNTHETIC_SECRET = original;
  });
  await f.agent.dispatch({
    action: 'define-check',
    name: 'Environment fixture',
    static: true,
    executable: process.execPath,
    args: [
      '-e',
      `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      assert.equal(process.env.FORGE_INTEGRATION_SYNTHETIC_SECRET, undefined);
      for (const key of ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR']) {
        assert.ok(process.env[key].includes('forge-integration-'));
        assert.ok(fs.statSync(process.env[key]).isDirectory());
      }
    `,
    ],
  });
  assert.equal(f.integrate().status, 'clean');
});

test('main advances are composed with Lanes still based on an earlier accepted main', async t => {
  const f = await fixture(t),
    lane = await f.start();
  await f.save(lane, 'types.ts', 'export function value(): {a?: string} { return {}; }\n');
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(f.root),
    before = f.integrate();
  const files = source
    .state(before.main)
    .files.map(file =>
      file.path === 'other.ts'
        ? { ...file, blob: source.put(Buffer.from('export const other = 5;\n')) }
        : file,
    );
  const main = source.writeState(files, [before.main], 'Concurrent main source', new Date().toISOString());
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: main,
      previous: before.main,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    f.store.commitRecords(tx);
  });
  const result = f.integrate();
  assert.equal(result.status, 'clean');
  assert.equal(result.main, main);
  assert.equal(result.inputs[0].head, lane.head);
});

test('unavailable advisory accounting preserves the observed preview verdict and original Work', async t => {
  const f = await fixture(t);
  await f.pair();
  const before = readFileSync(join(f.store.directory, 'work.json'));
  t.mock.method(CoordinationJournal.prototype, 'recordPreview', () => {
    throw new Error('synthetic write failure');
  });
  const result = f.integrate();
  assert.equal(result.status, 'clash');
  assert.equal(result.accounting.status, 'unavailable');
  assert.equal(result.accounting.code, 'PREVIEW_COST_UNAVAILABLE');
  assert.deepEqual(readFileSync(join(f.store.directory, 'work.json')), before);
});
