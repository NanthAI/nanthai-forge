// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { digest } from '../dist/hash.js';
import { hostedClientReadSchemas } from '../dist/hosted-agent-reads.js';
import { hostedAgentHelpEntries } from '../dist/hosted-agent-help.js';
import { validateHostedCliCommand } from '../dist/hosted-cli-validation.js';
import { showHostedSource } from '../dist/mcp-hosted-source.js';
import { hostedDoctor } from '../dist/hosted-doctor.js';

const minimal = {
  records: { collection: 'lanes' },
  log: { runId: randomUUID() },
  lanes: {},
  diff: {},
  peers: {},
  queue: {},
  'lane-history': {},
  landings: { from: '2026-11-05T21:00:00Z', to: '2026-11-05T23:20:00Z' },
  wait: { runId: randomUUID() },
  show: { path: 'a.ts' },
  board: {},
  'board-post': { to: 'project', text: 'Synthetic note' },
  'board-reply': { id: 'abcdef12', text: 'Synthetic reply' },
  'board-resolve': { id: 'abcdef12' },
};

// 60720390: `queue` was advertised in help but unknown to validation, so it failed before dispatch.
test('every client-side read passes CLI validation, appears in help and dispatches', async t => {
  assert.deepEqual(Object.keys(minimal).sort(), Object.keys(hostedClientReadSchemas).sort());
  const f = agentFixture(t);
  for (const action of Object.keys(hostedClientReadSchemas)) {
    assert.doesNotThrow(
      () => validateHostedCliCommand(f.root, action, minimal[action]),
      `${action} validates without HOSTED_ACTION_UNSUPPORTED`,
    );
    assert(
      hostedAgentHelpEntries.some(entry => entry.action === action),
      `${action} has help`,
    );
  }
  const transport = f.transport();
  const laneId = randomUUID();
  f.queueView.entries = [
    { position: 1, submissionId: randomUUID(), laneId: randomUUID(), phase: 'checking' },
    { position: 2, submissionId: randomUUID(), laneId, phase: 'queued' },
  ];
  f.queueView.total = f.queueView.listed = 2;
  const reply = await transport.dispatch('queue', { laneId, limit: 5 });
  assert.deepEqual(
    f.calls.map(c => c.name),
    ['projectHostedQueueView:read'],
  );
  assert.deepEqual(f.calls[0].args, { projectId: 'project', limit: 5 }, 'laneId is never sent to the server');
  assert.equal(reply.result.entries.length, 2);
  assert.equal(reply.result.yourLane.listed, true);
  assert.deepEqual(
    reply.result.yourLane.entries.map(e => e.position),
    [2],
  );
  // lane-history defaults to the checkout's Lane or a given laneId; one query, laneId only.
  f.calls.length = 0;
  const history = await transport.dispatch('lane-history', { laneId });
  assert.deepEqual(history.result, { schema: 1, laneId });
  assert.deepEqual(
    f.calls.map(c => c.name),
    ['projectHostedLaneHistory:read'],
  );
  await assert.rejects(transport.dispatch('lane-history', {}), e => e.code === 'BAD_ARGUMENT');
  f.queueView.entries.pop();
  f.queueView.more = true;
  const absent = await transport.dispatch('queue', { laneId });
  assert.equal(absent.result.yourLane.listed, false);
  assert.match(absent.result.yourLane.note, /Not in this page/);
});

// bc930af0: no way to read a file at the Lane base or main without the stale project clone.
test('show at:"base" reads the pinned Lane base and at:"main" reads current main', async t => {
  const f = agentFixture(t);
  const put = text => {
    const bytes = Buffer.from(text);
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = text => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [{ path: 'docs/a.md', blob: put(text), mode: 'file' }],
        message: 'Synthetic',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  f.lane.base.head = state('base text\n');
  f.lane.head = state('lane text\n');
  f.main.head = state('main text\n');
  const transport = f.transport();
  const show = input => showHostedSource(transport, { action: 'show', path: 'docs/a.md', ...input });
  const base = await show({ laneId: f.lane.laneId, at: 'base' });
  assert.equal(base.result.content, 'base text\n');
  assert.equal(base.result.at, 'base');
  assert.equal(base.result.state, f.lane.base.head);
  assert.equal((await show({ laneId: f.lane.laneId })).result.content, 'lane text\n', 'default unchanged');
  const main = await show({ at: 'main' });
  assert.equal(main.result.content, 'main text\n');
  assert.equal(main.result.channel, 'main');
  for (const bad of [
    { at: 'base', channel: 'main' },
    { at: 'base', state: f.lane.head },
    { at: 'main', laneId: f.lane.laneId },
    { at: 'main', state: f.lane.head },
  ])
    await assert.rejects(show(bad), e => e.code === 'BAD_ARGUMENT', JSON.stringify(bad));
  // The base is immutable, but access is rechecked before bytes return.
  f.allow(false);
  await assert.rejects(show({ laneId: f.lane.laneId, at: 'base' }), e => e.code === 'PROJECT_UNAVAILABLE');
});

// ef45884e: "are this Lane's saved changes already on main" without hunks or blob reads.
test('diff summary:true says equal/absent/different against main from manifests only', async t => {
  const f = agentFixture(t);
  const put = text => {
    const bytes = Buffer.from(text);
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = files => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: Object.entries(files).map(([path, text]) => ({ path, blob: put(text), mode: 'file' })),
        message: 'Synthetic',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  f.lane.base.head = state({ 'a.ts': 'a0', 'b.ts': 'b0', 'c.ts': 'c0', 'g.ts': 'g0', 'h.ts': 'h0' });
  f.lane.head = state({ 'a.ts': 'a1', 'c.ts': 'c0', 'e.ts': 'e1', 'f.ts': 'f1', 'g.ts': 'g1' });
  f.main.head = state({ 'a.ts': 'a1', 'c.ts': 'c0', 'f.ts': 'fX', 'g.ts': 'gX', 'h.ts': 'h0' });
  const manifests = new Set([f.lane.base.head, f.lane.head, f.main.head]);
  const touched = [];
  for (const name of ['downloadToFile', 'downloadBatch', 'objects']) {
    const original = f.exchange[name];
    f.exchange[name] = async (first, ...rest) => {
      for (const item of [first].flat()) touched.push(item?.sha256 ?? item);
      return original(first, ...rest);
    };
  }
  const reply = await f.transport().dispatch('diff', { laneId: f.lane.laneId, summary: true });
  const { result } = reply;
  assert.deepEqual(
    result.items.map(item => [item.path, item.status, item.main]),
    [
      ['a.ts', 'modified', 'equal'],
      ['b.ts', 'deleted', 'equal'],
      ['e.ts', 'added', 'absent'],
      ['f.ts', 'added', 'different'],
      ['g.ts', 'modified', 'different'],
      ['h.ts', 'deleted', 'different'],
    ],
  );
  assert.deepEqual(result.counts, { equal: 2, absent: 1, different: 3 });
  assert.equal(result.total, 6);
  assert.equal(result.nextCursor, null);
  assert.equal(result.main, f.main.head);
  assert(
    result.items.every(item => !('hunks' in item) && !('before' in item)),
    'no hunks, no file bodies',
  );
  assert.equal(result.cost.sourceBytes, 0);
  assert.equal(result.cost.metadataPages, 0);
  assert(touched.length > 0 && touched.every(id => manifests.has(id)), 'only the three manifests were read');
  // Paths filter and a one-path budget page: the cursor resumes at the pinned pair.
  const page = (
    await f.transport().dispatch('diff', { laneId: f.lane.laneId, summary: true, byteBudget: 1024 })
  ).result;
  assert.equal(page.items.length, 6, 'a small budget still fits these short rows');
  const only = (
    await f.transport().dispatch('diff', { laneId: f.lane.laneId, summary: true, paths: ['g.ts', 'e.ts'] })
  ).result;
  assert.deepEqual(
    only.items.map(item => item.path),
    ['e.ts', 'g.ts'],
  );
  f.allow(false);
  await assert.rejects(
    f.transport().dispatch('diff', { laneId: f.lane.laneId, summary: true }),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
});

// c3e6ce8b: doctor refused every Forge clone and Lane with a Git error.
test('doctor reports CLI, hooks and checkout health for a Forge clone and a Lane, offline', async t => {
  const f = agentFixture(t);
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [],
    message: 'Synthetic',
    at: '2026-01-01T00:00:00.000Z',
  };
  const home = join(f.root, '..', 'home');
  mkdirSync(home, { recursive: true });
  const clone = join(f.root, '..', 'clone');
  mkdirSync(join(clone, '.forge'), { recursive: true });
  writeFileSync(join(clone, '.forge', 'hosted-main.json'), JSON.stringify({ selection: f.main, state }));
  const report = hostedDoctor(clone, home);
  assert.equal(report.kind, 'forge-clone');
  assert.equal(report.checkout.head, f.main.head);
  assert.equal(report.networkRequired, false);
  assert.equal(typeof report.cli.version, 'string');
  assert(['ok', 'disabled', 'attention'].includes(report.hooks.status));
  assert.deepEqual(report.problems, []);

  const lane = join(f.root, '..', 'lane');
  mkdirSync(join(lane, '.forge'), { recursive: true });
  const marker = {
    schema: 1,
    kind: 'forge-hosted-lane-checkout',
    url: f.address.url,
    operationId: randomUUID(),
    selection: f.lane,
    state,
    scope: null,
    materialized: [],
  };
  writeFileSync(join(lane, '.forge', 'hosted-lane.json'), JSON.stringify(marker));
  const inLane = hostedDoctor(join(lane, '.forge'), home);
  assert.equal(inLane.kind, 'forge-lane');
  assert.equal(inLane.checkout.laneId, f.lane.laneId);
  assert.deepEqual(inLane.address, f.address);

  writeFileSync(join(lane, '.forge', 'hosted-lane.json'), '{broken');
  const broken = hostedDoctor(lane, home);
  assert.equal(broken.ready, false);
  assert.equal(broken.problems.length, 1);
  assert.equal(hostedDoctor(join(f.root, '..'), home), null, 'other roots keep the Git doctor');
});
