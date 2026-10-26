// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { serveRepository } from '../dist/http.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-policy-')),
    root = join(dir, 'owner'),
    shim = join(dir, 'bin'),
    called = join(dir, 'git-called');
  mkdirSync(root);
  mkdirSync(shim);
  writeFileSync(join(root, '.gitignore'), '.forge/\n');
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho attempted >> '${called}'\nexit 97\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = shim + ':' + oldPath;
  t.after(() => {
    process.env.PATH = oldPath;
    assert.equal(existsSync(called), false, 'Native workflow must not call Git');
    rmSync(dir, { recursive: true, force: true });
  });
  initNative(root);
  const w = new WorkService(root),
    data = () => w.store.load(),
    act = cmd => w.execute(cmd, data().revision).result,
    call = (cmd, revision = data().revision) => w.dispatch(cmd, revision);
  const intent = act({ action: 'intent', outcome: 'Native optional policy and events' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const compose = (
    operationId = randomUUID(),
    inputs = [{ laneId: lane.id, head: data().lanes.find(l => l.id === lane.id).head }],
  ) => act({ action: 'compose', operationId, intentId: intent.id, inputs });
  const view = compose(),
    check = (script = 'console.log("checked")') =>
      act({
        action: 'define-check',
        name: 'Selected check',
        executable: process.execPath,
        args: ['-e', script],
      });
  const define = (patch = {}) => ({
    action: 'define-invariant',
    operationId: randomUUID(),
    invariantId: randomUUID(),
    intentId: intent.id,
    name: 'Exact candidate',
    checkIds: [],
    reviewers: [],
    ...patch,
  });
  const assess = (policy, pin = view) =>
    call(
      {
        action: 'assess-invariant',
        id: policy.id,
        definition: policy.definition,
        viewId: pin.id,
        expectedHead: pin.head,
      },
      0,
    );
  const accept = (policy, patch = {}) => ({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
    ...(policy ? { invariant: { id: policy.id, definition: policy.definition } } : {}),
    ...patch,
  });
  const book = async checks =>
    (await call({ action: 'define-playbook', name: 'Selected sequence', checkIds: checks.map(c => c.id) }))
      .result;
  const runCommand = (book, pin = view, onFailure = 'stop') => ({
    action: 'run-playbook',
    operationId: randomUUID(),
    playbookId: book.id,
    viewId: pin.id,
    expectedHead: pin.head,
    expectedDefinition: book.definition,
    expectedEnvironment: w.status().environment.fingerprint,
    expectedChecks: book.checkIds.map(id => {
      const c = data().checks.find(c => c.id === id);
      return { id, definition: c.definition };
    }),
    onFailure,
  });
  const rule = (book, event, enabled = true) =>
    act({
      action: 'define-automation',
      automationId: randomUUID(),
      intentId: intent.id,
      name: event,
      event,
      enabled,
      playbookId: book.id,
      expectedPlaybook: book.definition,
      expectedChecks: runCommand(book).expectedChecks,
      expectedEnvironment: w.status().environment.fingerprint,
      onFailure: 'stop',
    });
  return {
    dir,
    root,
    w,
    data,
    act,
    call,
    intent,
    lane,
    compose,
    view,
    check,
    define,
    assess,
    accept,
    book,
    runCommand,
    rule,
  };
}
async function wait(f, id, kind = 'playbookRuns') {
  for (let n = 0; n < 250; n++) {
    f.w.status();
    const run = f.data()[kind].find(r => r.id === id);
    if (run?.endedAt) return run;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('Selected native run did not finish');
}
async function runCheck(f, c, pin = f.view) {
  const result = await f.call({
    action: 'run-check',
    operationId: randomUUID(),
    viewId: pin.id,
    expectedHead: pin.head,
    checkId: c.id,
    expectedDefinition: c.definition,
    expectedEnvironment: f.w.status().environment.fingerprint,
  });
  return wait(f, result.result.id, 'runs');
}
const code = expected => error => error.code === expected;

test('native optional Invariants assess exact checks and separate reviews, while unselected acceptance remains available', async t => {
  const f = fixture(t),
    { w, call, act, check, define, assess, accept, view, compose } = f,
    c = check();
  assert.equal(w.status().capabilities.invariants, true);
  assert.equal(w.status().capabilities.automationEvents, true);
  assert.equal(w.status().capabilities.githubReviewPolicy, false);
  const request = define({ checkIds: [c.id], reviewers: ['Owner label'] }),
    save = w.store.save.bind(w.store);
  w.store.save = data => {
    save(data);
    throw Error('Lost definition reply');
  };
  await assert.rejects(call(request), /Lost definition reply/);
  w.store.save = save;
  const policy = (await call(request, 0)).result;
  assert.equal((await assess(policy)).result.satisfied, false);
  const untouched = readWorkBytes(join(w.store.directory, 'work.json'));
  await assess(policy);
  assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), untouched);
  await assert.rejects(call(accept(policy)), code('INVARIANT_UNSATISFIED'));
  assert.equal(f.data().channelMoves.length, 0);
  const unselected = (await call(accept())).result;
  assert.equal(unselected.status, 'accepted');
  assert.equal(unselected.invariant, undefined);
  assert.equal((await runCheck(f, c)).status, 'passed');
  act({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Owner label',
    decision: 'approve',
  });
  assert.equal((await assess(policy)).result.satisfied, false);
  act({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Owner label',
    decision: 'approve',
    invariant: { id: policy.id, definition: policy.definition },
  });
  assert.equal((await assess(policy)).result.satisfied, true);
  const successor = compose();
  assert.equal(successor.head, view.head);
  assert.equal((await assess(policy, successor)).result.satisfied, false);
  const acceptance = accept(policy, { expectedPrevious: view.head });
  // Native edits stage pages outside the lock, then publish the prepared pointer.
  const publish = w.store.publishSave.bind(w.store);
  w.store.publishSave = (...args) => {
    publish(...args);
    throw Error('Lost accepted reply');
  };
  await assert.rejects(call(acceptance), /Lost accepted reply/);
  w.store.publishSave = publish;
  const retained = (await call(acceptance, 0)).result;
  assert.equal(retained.invariant.satisfied, true);
  const latest = (
    await call(
      define({ invariantId: policy.id, expectedDefinition: policy.definition, reviewers: ['Other label'] }),
    )
  ).result;
  assert.equal((await assess(latest)).result.satisfied, false);
  assert.equal((await call(acceptance, 0)).result.id, retained.id);
  await assert.rejects(
    call({ ...acceptance, invariant: { id: latest.id, definition: latest.definition } }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const oldCheck = act({
    action: 'define-check',
    checkId: c.id,
    name: c.name,
    executable: c.executable,
    args: ['-e', 'process.exit(8)'],
  });
  assert.equal(oldCheck.id, c.id);
  assert.equal((await assess(policy)).result.checks[0].status, 'stale');
});

test('native manual Playbooks retain fail/continue/cancel outcomes and reconcile original runs without replay', async t => {
  const f = fixture(t),
    marker = join(f.dir, 'sequence'),
    first = f.check(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'A')`),
    second = f.check('process.exit(7)'),
    third = f.check(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'B')`);
  const book = await f.book([first, second, third]),
    stop = f.runCommand(book);
  await f.call(stop);
  assert.equal((await wait(f, stop.operationId)).status, 'failed');
  assert.equal(readFileSync(marker, 'utf8'), 'A');
  await f.call(stop, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'A');
  const continued = f.runCommand(book, f.view, 'continue');
  await f.call(continued);
  assert.equal((await wait(f, continued.operationId)).status, 'failed');
  assert.equal(readFileSync(marker, 'utf8'), 'AAB');
  const long = f.check('console.log("live");setInterval(()=>{},1000)'),
    cancelBook = await f.book([long, third]),
    cancel = f.runCommand(cancelBook);
  await f.call(cancel);
  await f.call({ action: 'cancel-playbook', operationId: cancel.operationId }, 0);
  assert.equal((await wait(f, cancel.operationId)).status, 'cancelled');
  assert.equal(readFileSync(marker, 'utf8'), 'AAB');
  const exported = (await f.call({ action: 'export-playbook', kind: 'run', id: continued.operationId }, 0))
    .result;
  assert.equal(exported.private, true);
  assert.deepEqual(
    exported.steps.map(s => s.outcome.status),
    ['passed', 'failed', 'passed'],
  );
});

test('native clean/resolved View, Channel and release events are opt-in and preserve original event identities across retry', async t => {
  const f = fixture(t),
    marker = join(f.dir, 'events'),
    c = f.check(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'X')`),
    book = await f.book([c]);
  f.rule(book, 'clean-view', false);
  f.compose();
  assert.equal(f.data().playbookRuns.length, 0);
  const rules = ['clean-view', 'channel-accepted', 'release-created'].map(event => f.rule(book, event));
  const composition = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: f.intent.id,
    inputs: [{ laneId: f.lane.id, head: f.lane.head }],
  };
  const view = f.act(composition),
    clean = f.data().playbookRuns.at(-1);
  await wait(f, clean.id);
  await f.call(composition, 0);
  assert.equal(f.data().playbookRuns.length, 1);
  const channel = f.accept(undefined, { viewId: view.id, expectedHead: view.head });
  const accepted = (await f.call(channel)).result;
  await wait(f, f.data().playbookRuns.at(-1).id);
  await f.call(channel, 0);
  const release = {
    action: 'create-release',
    operationId: randomUUID(),
    name: 'Native event trial',
    notes: '',
    acceptanceId: accepted.id,
    expectedHead: accepted.head,
  };
  await f.call(release);
  await wait(f, f.data().playbookRuns.at(-1).id);
  await f.call(release, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'XXX');
  assert.deepEqual(
    f.data().playbookRuns.map(r => r.automation.event),
    rules.map(r => r.event),
  );
  assert.deepEqual(
    f.data().playbookRuns.map(r => r.automation.eventId),
    [view.id, accepted.id, release.operationId],
  );
  f.act({
    action: 'define-check',
    checkId: c.id,
    name: c.name,
    executable: c.executable,
    args: ['-e', 'throw Error("must not substitute")'],
  });
  f.compose();
  assert.equal(f.data().playbookRuns.at(-1).status, 'interrupted');
  assert.equal(readFileSync(marker, 'utf8'), 'XXX');
  f.act({ action: 'define-check', checkId: c.id, name: c.name, executable: c.executable, args: c.args });
  const source = new NativeSource(f.root),
    checkpoint = id => {
      const lane = f.data().lanes.find(l => l.id === id),
        files = source.capture(f.w.store.path(id), false, lane.head);
      return f.act({
        action: 'checkpoint',
        laneId: id,
        expectedHead: lane.head,
        expectedTree: source.tree(files),
        message: 'Conflicting candidate',
      });
    };
  writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'export const a=2;\n');
  checkpoint(f.lane.id);
  const other = f.act({ action: 'lane', intentId: f.intent.id, name: 'Other candidate' });
  writeFileSync(join(f.w.store.path(other.id), 'a.ts'), 'export const a=3;\n');
  checkpoint(other.id);
  const before = f.data().playbookRuns.length,
    conflict = f.compose(
      randomUUID(),
      f.data().lanes.map(l => ({ laneId: l.id, head: l.head })),
    );
  assert.equal(conflict.status, 'conflict');
  assert.equal(f.data().playbookRuns.length, before);
  const resolution = {
    action: 'resolve-native-view',
    operationId: randomUUID(),
    viewId: conflict.id,
    laneId: f.lane.id,
    expectedHead: f.data().lanes.find(l => l.id === f.lane.id).head,
  };
  const resolved = f.act(resolution),
    resolvedRun = f.data().playbookRuns.at(-1);
  await wait(f, resolvedRun.id);
  assert.equal(resolvedRun.automation.eventId, resolved.id);
  await f.call(resolution, 0);
  assert.equal(f.data().playbookRuns.length, before + 1);
  const advanced = (
    await f.call(
      f.accept(undefined, { viewId: resolved.id, expectedHead: resolved.head, expectedPrevious: view.head }),
    )
  ).result;
  await wait(f, f.data().playbookRuns.at(-1).id);
  const after = f.data().playbookRuns.length;
  assert.equal((await f.call(channel, 0)).result.id, accepted.id);
  assert.equal(f.w.status().channels.find(c => c.name === 'main').moveId, advanced.id);
  assert.equal(f.data().playbookRuns.length, after);
  assert.equal(readFileSync(marker, 'utf8'), 'XXXXX');
});

test('native lost event registration and dead sequence recovery never restart commands; private restore retains exact policy/event records', async t => {
  const f = fixture(t),
    marker = join(f.dir, 'must-not-run'),
    c = f.check(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`),
    book = await f.book([c]);
  f.rule(book, 'clean-view');
  const command = {
      action: 'compose',
      operationId: randomUUID(),
      intentId: f.intent.id,
      inputs: [{ laneId: f.lane.id, head: f.lane.head }],
    },
    publish = f.w.store.publishSave.bind(f.w.store);
  let lost = false;
  f.w.store.publishSave = (...args) => {
    publish(...args);
    if (!lost && f.w.store.load().playbookRuns.length) {
      lost = true;
      throw Error('Lost registered reply');
    }
  };
  assert.throws(() => f.act(command), /Lost registered reply/);
  f.w.store.publishSave = publish;
  await f.call(command, 0);
  assert.equal(f.data().playbookRuns.length, 1);
  assert.equal(f.data().playbookRuns[0].status, 'interrupted');
  assert.equal(existsSync(marker), false);
  const policy = (await f.call(f.define({ reviewers: ['Label'] }))).result;
  const data = f.data();
  const sequence = data.playbookRuns[0];
  sequence.status = 'running';
  delete sequence.endedAt;
  sequence.runner.pid = 2147483647;
  data.revision++;
  f.w.store.save(data);
  assert.equal(f.w.status().playbookRuns[0].status, 'interrupted');
  assert.equal(existsSync(marker), false);
  const backup = (await f.call({ action: 'export-work', archive: true })).result,
    target = join(f.dir, 'restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new WorkService(target);
  assert.equal(restored.status().invariants[0].definition, policy.definition);
  assert.equal(restored.status().playbookRuns[0].automation.eventId, f.data().views.at(-1).id);
  assert.deepEqual(
    readWorkBytes(join(restored.store.directory, 'work.json')),
    readWorkBytes(join(f.w.store.directory, 'work.json')),
  );
  const server = await serveRepository(target, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.equal((await fetch(url.origin + '/api/work')).status, 401);
  const response = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: 0,
      command: {
        action: 'assess-invariant',
        id: policy.id,
        definition: policy.definition,
        viewId: f.view.id,
        expectedHead: f.view.head,
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.satisfied, false);
});
