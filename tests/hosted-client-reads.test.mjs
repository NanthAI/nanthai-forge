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
  lanes: {},
  diff: {},
  peers: {},
  queue: {},
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
