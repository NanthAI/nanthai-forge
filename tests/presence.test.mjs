// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESENCE, presenceState, collapseSessions } from '../dist/presence.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { watchLanePresence, watchOwnerPresence } from '../dist/presence-worker.js';
import { latestWorkFormat } from '../dist/work-format.js';
import { startOwnerPresence } from '../dist/presence-worker-start.js';
import { moduleUrl } from './convex-module.mjs';
const { Sessions } = await import(moduleUrl('../web/src/cockpit/Sessions.tsx'));

const session = (extra = {}) => ({
  sessionId: 'one',
  name: 'gpt-b6',
  status: 'working',
  lastSeen: 1_000_000,
  lastActivity: 1_000_000,
  activityKind: 'edited files',
  actor: 'owner',
  environment: 'Local Lane',
  summary: 'Implement presence',
  context: { laneId: 'lane' },
  ...extra,
});

test('fake clock crosses inclusive working and quiet boundaries; heartbeats do not extend activity', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const row = session();
  t.mock.timers.tick(PRESENCE.workingMs);
  assert.equal(presenceState(row, Date.now()), 'working');
  t.mock.timers.tick(1);
  row.lastSeen = Date.now();
  assert.equal(presenceState(row, Date.now()), 'quiet');
  t.mock.timers.tick(PRESENCE.foldMs - PRESENCE.workingMs - 1);
  assert.equal(presenceState(row, Date.now()), 'quiet');
  t.mock.timers.tick(1);
  assert.equal(presenceState(row, Date.now()), 'not-seen');
  assert.equal(row.status, 'working');
  assert.equal(presenceState({ ...row, status: 'completed' }, Date.now()), 'completed');
});

test('newest same-name Lane observation collapses duplicates including explicit completion', () => {
  const rows = collapseSessions([
    session(),
    session({ sessionId: 'two', lastActivity: 1_000_001, status: 'completed' }),
    session({ sessionId: 'other-lane', context: { laneId: 'other' } }),
    session({ sessionId: 'other-name', name: 'claude-3' }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'completed');
});

test('quiet sessions remain visible, old sessions fold, and copy records activity kind', () => {
  const now = 10_000_000;
  const html = renderToStaticMarkup(
    h(Sessions, {
      now,
      laneName: () => 'Presence',
      sessions: [
        session({ lastActivity: now - 25 * 60_000 }),
        session({ sessionId: 'dup', lastActivity: now - 26 * 60_000 }),
        session({ name: 'older', lastActivity: now - 91 * 60_000 }),
      ],
    }),
  );
  assert.match(html, /quiet · 25 min/);
  assert.match(html, /Implement presence/);
  const kindOnly = renderToStaticMarkup(
    h(Sessions, {
      now,
      laneName: () => 'Presence',
      sessions: [session({ summary: 'Presence', lastActivity: now - 25 * 60_000 })],
    }),
  );
  assert.match(kindOnly, /edited files/);
  assert.match(html, /1 not seen since/);
  assert.doesNotMatch(html, />older</);
  assert.equal((html.match(/>gpt-b6</g) ?? []).length, 1);
});

test('Lane watcher coalesces real edits, ignores build noise, and stops on explicit completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic presence', actor: 'gpt-b6' }))
    .result;
  const observations = () => Object.values(readHostState(agent.work.store).presence);
  const initial = observations()[0].lastActivity;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: initial });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const watching = watchLanePresence(agent.work.store, lane.laneId, controller.signal);
  mkdirSync(join(lane.path, 'dist'));
  writeFileSync(join(lane.path, 'dist/noise.js'), 'build');
  await new Promise(resolve => setTimeout(resolve, 100));
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].lastActivity, initial);
  writeFileSync(join(lane.path, 'file.txt'), 'two');
  writeFileSync(join(lane.path, 'file.txt'), 'three');
  await new Promise(resolve => setTimeout(resolve, 100));
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].activityKind, 'edited files');
  assert.equal(observations()[0].lastActivity, initial + 2 * PRESENCE.touchMs);
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].lastActivity, initial + 2 * PRESENCE.touchMs);
  await agent.dispatch({ action: 'complete', laneId: lane.laneId });
  t.mock.timers.tick(PRESENCE.touchMs);
  await watching;
  assert.equal(observations()[0].status, 'completed');
});

test('nested sessions share quiet/folded states, collapse across roots, and survive completed or accepted parents', async () => {
  const { sessionTreeRows } = await import(moduleUrl('../web/src/cockpit/session-tree.ts'));
  const now = 10_000_000;
  const child = session({
    sessionId: 'child',
    name: 'claude-3',
    context: { laneId: 'child-lane' },
    lastActivity: now - 25 * 60_000,
  });
  const parent = session({ sessionId: 'parent', lastActivity: now, subagents: [child] });
  const old = session({
    sessionId: 'old',
    name: 'older-child',
    lastActivity: now - 91 * 60_000,
    context: { laneId: 'old-lane' },
  });
  const roots = [
    { ...parent, subagents: [child, old] },
    { ...child, sessionId: 'duplicate', lastActivity: now - 26 * 60_000 },
  ];
  const tree = sessionTreeRows(roots, now, false);
  assert.equal(tree.listed, 2);
  assert.equal(tree.folded.length, 1);
  assert.deepEqual(
    tree.visible.map(row => row.sessionId),
    ['parent'],
  );
  assert.deepEqual(
    tree.visible[0].subagents.map(row => row.sessionId),
    ['child'],
  );
  const html = renderToStaticMarkup(h(Sessions, { now, laneName: () => undefined, sessions: roots }));
  assert.match(html, /quiet · 25 min/);
  assert.doesNotMatch(html, />older-child</);
  assert.equal((html.match(/>claude-3</g) ?? []).length, 1);
  for (const [sessions, ended] of [
    [[{ ...parent, status: 'completed' }], []],
    [[parent], ['lane']],
  ]) {
    assert.deepEqual(
      sessionTreeRows(sessions, now, false, ended).visible.map(row => row.sessionId),
      ['child'],
    );
  }
});

test("day-old sessions leave Who's working and older last-seen shows a date", async () => {
  const { sessionTreeRows } = await import(moduleUrl('../web/src/cockpit/session-tree.ts'));
  const { seenAt } = await import(moduleUrl('../web/src/ui/status.ts'));
  const now = new Date(2026, 9, 17, 9, 0).getTime();
  const at = (days, hour, minute = 0) => new Date(2026, 9, 17 - days, hour, minute).getTime();
  assert.equal(seenAt(at(0, 8, 5), now), '08:05');
  assert.equal(seenAt(at(1, 19, 23), now), 'yesterday 19:23');
  assert.match(seenAt(at(2, 19, 23), now), /15/);
  assert.doesNotMatch(seenAt(at(2, 19, 23), now), /19:23/);
  const rows = [
    session({ sessionId: 'yesterday', name: 'last-night', lastActivity: at(1, 19, 23) }),
    session({ sessionId: 'gone', name: 'long-gone', lastActivity: now - PRESENCE.hideMs - 1 }),
  ];
  const tree = sessionTreeRows(rows, now, true);
  assert.deepEqual(
    tree.visible.map(row => row.sessionId),
    ['yesterday'],
  );
  assert.equal(tree.total, 1);
  const html = renderToStaticMarkup(h(Sessions, { now, laneName: () => undefined, sessions: rows }));
  assert.match(html, /1 not seen since yesterday 19:23/);
  assert.doesNotMatch(html, /long-gone/);
});

test('one owner observer reconciles new Lanes and rejects a duplicate observer without a second watcher', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const first = (
    await agent.dispatch({ action: 'start', outcome: 'First synthetic Lane', actor: 'gpt-first' })
  ).result;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const observing = watchOwnerPresence(agent.work.store, controller.signal);
  assert.ok((await watchOwnerPresence(agent.work.store)).waiting);
  const second = (
    await agent.dispatch({ action: 'start', outcome: 'Second synthetic Lane', actor: 'gpt-second' })
  ).result;
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(join(second.path, 'file.txt'), 'two');
  await new Promise(resolve => setTimeout(resolve, 100));
  t.mock.timers.tick(PRESENCE.touchMs);
  const rows = Object.values(readHostState(agent.work.store).presence);
  assert.equal(rows.find(row => row.name === 'gpt-second').activityKind, 'edited files');
  assert.equal(rows.find(row => row.name === 'gpt-first').activityKind, 'started');
  await agent.dispatch({ action: 'complete', laneId: first.laneId });
  await agent.dispatch({ action: 'complete', laneId: second.laneId });
  t.mock.timers.tick(PRESENCE.touchMs);
  await observing;
});

test('owner observer does not revive a completed duplicate after binding changes while its Lane stays open', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-duplicate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({ action: 'start', outcome: 'Synthetic open Lane', actor: 'gpt-b6' });
  updateHostState(agent.work.store, state => {
    const row = Object.values(state.presence)[0];
    state.presence.rebound = {
      ...row,
      sessionId: 'rebound',
      status: 'completed',
      lastActivity: row.lastActivity + 1,
    };
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  t.after(() => clearTimeout(timeout));
  await watchOwnerPresence(agent.work.store, controller.signal);
  assert.equal(
    controller.signal.aborted,
    false,
    'completed observation ends the owner observer despite the older duplicate',
  );
});

test('owned presence close drains Lane queues and leaves no later writes or handles', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Owned observation' })).result;
  const stop = startOwnerPresence(agent.work.store);
  const stopSecond = startOwnerPresence(agent.work.store);
  await new Promise(resolve => setTimeout(resolve, 100));
  const queue = join(agent.work.store.directory, 'presence-workers', lane.laneId);
  assert.equal(readdirSync(queue).length, 1);
  await stop();
  assert.equal(readdirSync(queue).length, 1, 'another open handle retains observation');
  await stopSecond();
  await stopSecond();
  assert.deepEqual(readdirSync(queue), [], 'close awaits the Lane queue release');
  assert.deepEqual(readdirSync(join(agent.work.store.directory, 'presence-owner')), []);
  rmSync(root, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(root), false);
});

test('immediate owned presence close never starts a deferred observer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-immediate-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initNative(root);
  const agent = new AgentWorkflow(root);
  const stop = startOwnerPresence(agent.work.store);
  await stop();
  assert.equal(existsSync(join(agent.work.store.directory, 'presence-owner')), false);
});

test('a new owner handle during close waits for the old observer before starting', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-reopen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Reopened observation' })).result;
  const stop = startOwnerPresence(agent.work.store);
  await new Promise(resolve => setTimeout(resolve, 100));
  const closing = stop();
  const stopNew = startOwnerPresence(agent.work.store);
  await closing;
  await new Promise(resolve => setTimeout(resolve, 100));
  const queue = join(agent.work.store.directory, 'presence-workers', lane.laneId);
  assert.equal(readdirSync(queue).length, 1);
  await stopNew();
  assert.deepEqual(readdirSync(queue), []);
});

test('unsupported Work never creates owner or Lane presence tickets, including owned close', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initNative(root);
  const agent = new AgentWorkflow(root);
  const store = agent.work.store;
  const bytes = JSON.stringify({ schema: latestWorkFormat + 1, revision: 0 });
  writeFileSync(join(store.directory, 'work.json'), bytes);
  const before = readdirSync(store.directory);
  await assert.rejects(watchOwnerPresence(store), { code: 'WORK_UPGRADE_REQUIRED' });
  await assert.rejects(watchLanePresence(store, 'unsupported'), { code: 'WORK_UPGRADE_REQUIRED' });
  const stop = startOwnerPresence(store);
  await new Promise(resolve => setTimeout(resolve, 100));
  await stop();
  await stop();
  assert.deepEqual(readdirSync(store.directory), before);
});
