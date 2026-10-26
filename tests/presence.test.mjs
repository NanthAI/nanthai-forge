// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
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
import { observePresenceFiles } from '../dist/presence-files.js';
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
  // The observer deliberately unrefs its handles. Keep callback waits alive
  // independently of mock timers and native-notification latency.
  const keepAlive = setInterval(() => {}, PRESENCE.touchMs);
  t.after(clearInterval.bind(null, keepAlive));
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: initial });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let acknowledgeEdit;
  const edited = new Promise(resolve => {
    acknowledgeEdit = resolve;
  });
  const watching = watchLanePresence(agent.work.store, lane.laneId, controller.signal, laneId => {
    assert.equal(laneId, lane.laneId);
    acknowledgeEdit();
  });
  mkdirSync(join(lane.path, 'dist'));
  writeFileSync(join(lane.path, 'dist/noise.js'), 'build');
  await new Promise(resolve => setTimeout(resolve, 100));
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].lastActivity, initial);
  writeFileSync(join(lane.path, 'file.txt'), 'two');
  writeFileSync(join(lane.path, 'file.txt'), 'three');
  // macOS may miss native events entirely; its minute tick must reconcile the real edits.
  // Other platforms publish activity on the tick after their native notification.
  if (process.platform === 'darwin') t.mock.timers.tick(PRESENCE.touchMs);
  await edited;
  if (process.platform !== 'darwin') t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].activityKind, 'edited files');
  assert.equal(observations()[0].lastActivity, initial + 2 * PRESENCE.touchMs);
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(observations()[0].lastActivity, initial + 2 * PRESENCE.touchMs);
  await agent.dispatch({ action: 'complete', laneId: lane.laneId });
  t.mock.timers.tick(PRESENCE.touchMs);
  await watching;
  assert.equal(observations()[0].status, 'completed');
});

test('Lane observation reconciles macOS edits without notifications and retains the native path elsewhere', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-dropped-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Dropped notification regression' })).result;
  const observation = () => Object.values(readHostState(agent.work.store).presence)[0];
  const initial = observation().lastActivity;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: initial });
  let notify, workerStarted;
  const ready = new Promise(resolve => {
    workerStarted = resolve;
  });
  t.mock.method(watcherRuntime, 'createWorker', () => {
    const worker = new FakeWatchWorker();
    notify = (event, name) => worker.event(name, event);
    workerStarted();
    return worker;
  });
  // The first write precedes observer attachment; no native callback is delivered.
  writeFileSync(join(lane.path, 'file.txt'), 'two');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const editedLanes = [];
  const watching = watchLanePresence(agent.work.store, lane.laneId, controller.signal, laneId => {
    editedLanes.push(laneId);
  });
  if (process.platform === 'darwin') {
    assert.equal(observation().activityKind, 'edited files', 'startup detects already dirty source');
    writeFileSync(join(lane.path, 'replacement.txt'), 'three');
    renameSync(join(lane.path, 'replacement.txt'), join(lane.path, 'file.txt'));
    t.mock.timers.tick(PRESENCE.touchMs);
    assert.equal(
      observation().lastActivity,
      initial + PRESENCE.touchMs,
      'missing notifications do not hide later edits',
    );
    assert.deepEqual(editedLanes, [lane.laneId], 'reconciliation reports the edited Lane');
    mkdirSync(join(lane.path, 'dist'));
    writeFileSync(join(lane.path, 'dist/noise.js'), 'generated');
    await ready;
    notify('rename', 'file.txt'); // replayed FSEvents must not invent a second source edit
    t.mock.timers.tick(PRESENCE.touchMs);
    assert.equal(observation().lastActivity, initial + PRESENCE.touchMs);
    assert.deepEqual(editedLanes, [lane.laneId, lane.laneId], 'native callbacks retain Lane identity');
  } else {
    assert.equal(observation().activityKind, 'started', 'other platforms retain native observation');
    await ready;
    notify('change', 'file.txt');
    t.mock.timers.tick(PRESENCE.touchMs);
    assert.equal(observation().activityKind, 'edited files');
    assert.deepEqual(editedLanes, [lane.laneId]);
  }
  controller.abort();
  await watching;
});

test('metadata reconciliation detects edits without native events and ignores protected output and symlink targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-metadata-'));
  const external = mkdtempSync(join(tmpdir(), 'forge-presence-external-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested/file.txt'), 'one');
  fs.symlinkSync(external, join(root, 'linked'));
  const observe = observePresenceFiles(root);
  assert.equal(observe(), false);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/noise.js'), 'generated');
  writeFileSync(join(external, 'outside.txt'), 'outside');
  assert.equal(observe(), false);
  writeFileSync(join(root, 'nested/file.txt'), 'two');
  // Coarse filesystem clocks (Linux CI) can leave a same-size rewrite with an unchanged mtime.
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(join(root, 'nested/file.txt'), later, later);
  assert.equal(observe(), true, 'same-size edits change metadata');
  assert.equal(observe(), false, 'edits coalesce');
  writeFileSync(join(root, 'nested/replacement.txt'), 'replacement');
  renameSync(join(root, 'nested/replacement.txt'), join(root, 'nested/file.txt'));
  assert.equal(observe(), true, 'atomic editor saves change identity');
  mkdirSync(join(root, 'new'));
  writeFileSync(join(root, 'new/added.txt'), 'new');
  assert.equal(observe(), true, 'new subtrees are observed');
  rmSync(join(root, 'nested/file.txt'));
  assert.equal(observe(), true, 'deletions are observed');
  const moved = root + '-moved';
  renameSync(root, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  assert.equal(observe(), false, 'unavailable is not empty');
  writeFileSync(join(moved, 'new/added.txt'), 'changed while unavailable');
  renameSync(moved, root);
  assert.equal(observe(), true, 'recovery compares with the last complete observation');
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
  // Abortable observers do not own process lifetime; other platforms await a native event here.
  const keepAlive = setInterval(() => {}, PRESENCE.touchMs);
  t.after(clearInterval.bind(null, keepAlive));
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let acknowledgeEdit;
  const edited = new Promise(resolve => {
    acknowledgeEdit = resolve;
  });
  let editedLane;
  const editedLanes = new Set();
  const observing = watchOwnerPresence(agent.work.store, controller.signal, laneId => {
    editedLanes.add(laneId);
    if (laneId === editedLane) acknowledgeEdit();
  });
  assert.ok((await watchOwnerPresence(agent.work.store)).waiting);
  const second = (
    await agent.dispatch({ action: 'start', outcome: 'Second synthetic Lane', actor: 'gpt-second' })
  ).result;
  // Reconcile the newly created Lane before editing it, independently of root notification latency.
  t.mock.timers.tick(PRESENCE.touchMs);
  editedLane = second.laneId;
  writeFileSync(join(second.path, 'file.txt'), 'two');
  if (process.platform === 'darwin') t.mock.timers.tick(PRESENCE.touchMs);
  await edited;
  t.mock.timers.tick(PRESENCE.touchMs);
  const rows = Object.values(readHostState(agent.work.store).presence);
  assert.equal(rows.find(row => row.name === 'gpt-second').activityKind, 'edited files');
  // A backend may replay creation events after attachment. macOS metadata rejects
  // those as activity; other platforms retain main's native-notification behavior.
  assert.equal(
    rows.find(row => row.name === 'gpt-first').activityKind,
    process.platform !== 'darwin' && editedLanes.has(first.laneId) ? 'edited files' : 'started',
  );
  await agent.dispatch({ action: 'complete', laneId: first.laneId });
  await agent.dispatch({ action: 'complete', laneId: second.laneId });
  t.mock.timers.tick(PRESENCE.touchMs);
  await observing;
});

test('owner observer reconciles edits made before the helper attaches without a later timer or native event', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-attach-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const first = (await agent.dispatch({ action: 'start', outcome: 'Unedited Lane' })).result;
  let worker;
  const started = new Promise(resolve => {
    t.mock.method(watcherRuntime, 'createWorker', () => {
      worker = new FakeWatchWorker({ hangStartup: true });
      resolve();
      return worker;
    });
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController();
  const edits = [];
  const observing = watchOwnerPresence(agent.work.store, controller.signal, id => edits.push(id));
  t.after(async () => {
    controller.abort();
    await observing;
  });
  await started;
  const second = (await agent.dispatch({ action: 'start', outcome: 'Edited during attachment' })).result;
  t.mock.timers.tick(PRESENCE.touchMs);
  mkdirSync(join(first.path, 'dist'));
  writeFileSync(join(first.path, 'dist/noise.js'), 'generated');
  writeFileSync(join(second.path, 'file.txt'), 'edited before native open');
  worker.emit('message', { type: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(edits, [second.laneId], 'attachment reconciles source but ignores generated output');
  t.mock.timers.tick(PRESENCE.touchMs);
  const rows = Object.values(readHostState(agent.work.store).presence);
  assert.equal(rows.find(row => row.context.laneId === second.laneId).activityKind, 'edited files');
  assert.equal(rows.find(row => row.context.laneId === first.laneId).activityKind, 'started');
  controller.abort();
  await observing;
  assert.equal(worker.subscriptions.size, 0);
  assert.equal(worker.terminations, 1);
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

for (const phase of ['opening', 'healthy'])
  test(`owner close during ${phase} releases its real shared helper and IPC`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-presence-helper-close-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'file.txt'), 'one');
    initNative(root);
    const agent = new AgentWorkflow(root);
    const lane = (await agent.dispatch({ action: 'start', outcome: 'Real helper lifecycle' })).result;
    const workers = [];
    const create = watcherRuntime.createWorker;
    let started;
    const startup = new Promise(resolve => {
      started = resolve;
    });
    t.mock.method(watcherRuntime, 'createWorker', () => {
      const child = create();
      child.received = [];
      child.on('message', message => child.received.push(message));
      workers.push(child);
      started(child);
      return child;
    });
    const controller = new AbortController();
    let edits = 0;
    const observing = watchOwnerPresence(agent.work.store, controller.signal, () => edits++);
    t.after(async () => {
      controller.abort();
      await observing;
    });
    const child = await startup;
    if (phase === 'healthy') {
      const deadline = performance.now() + 10_000;
      while (child.received.filter(message => message.type === 'healthy').length < 2) {
        assert.ok(performance.now() < deadline, 'owner and Lane subscriptions become healthy');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    await observing;
    assert.equal(child.connected, false, 'close disconnects IPC without awaiting native teardown');
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const bound = setTimeout(() => reject(new Error('owner helper retained after close')), 2000);
      child.once('exit', () => {
        clearTimeout(bound);
        resolve();
      });
    });
    assert.equal(workers.length, 1);
    assert.deepEqual(readdirSync(join(agent.work.store.directory, 'presence-owner')), []);
    assert.deepEqual(readdirSync(join(agent.work.store.directory, 'presence-workers', lane.laneId)), []);
    const before = edits;
    writeFileSync(join(lane.path, 'file.txt'), 'after close');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(edits, before, 'a closed observer never reports later edits');
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

test('degraded presence keeps the minute fallback and stays quiet when idle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-presence-degraded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic degraded presence' })).result;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw new Error('network forbidden');
  });
  t.mock.method(watcherRuntime, 'createWorker', () => new FakeWatchWorker({ code: 'EMFILE' }));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController();
  const watching = watchLanePresence(agent.work.store, lane.laneId, controller.signal);
  t.after(() => controller.abort());
  await new Promise(resolve => setImmediate(resolve));
  const initial = Object.values(readHostState(agent.work.store).presence)[0].lastActivity;
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(Object.values(readHostState(agent.work.store).presence)[0].lastActivity, initial);
  writeFileSync(join(lane.path, 'file.txt'), 'changed source');
  t.mock.timers.tick(PRESENCE.touchMs);
  assert.equal(Object.values(readHostState(agent.work.store).presence)[0].activityKind, 'edited files');
  assert.equal(calls, 0);
  controller.abort();
  await watching;
});
