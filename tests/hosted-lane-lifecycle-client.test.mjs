// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lifecycleFixture, api as lifeApi, lanes, code } from './hosted-lane-lifecycle-fixture.mjs';
import { api, jobApi } from './hosted-saves-fixture.mjs';
import { transitionHostedLane } from '../dist/hosted-lifecycle-client.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';
async function fixture(t) {
  const f = await lifecycleFixture(),
    base = mkdtempSync(join(tmpdir(), 'forge-lifecycle-client-')),
    root = join(base, 'client');
  t.after(() =>
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }),
  );
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: f.projectId,
        laneId: f.laneId,
        intentId: f.intentId,
        ...f.expected,
        state: 'active',
        base: f.initial.base,
        authority: { mode: 'server', epoch: 1 },
      },
      state: f.state,
      scope: ['a.txt'],
      materialized: ['a.txt'],
    }),
  );
  let loseUpload = false,
    loseLifecycle = false,
    offline = false;
  const calls = [],
    puts = [];
  const exchange = {
    projectId: f.projectId,
    missing: async pins => pins.filter(p => !f.objects.has(p.sha256)).map(p => p.sha256),
    uploadFile: async (pin, dir, path) => {
      const bytes = readFileSync(join(dir, path));
      assert.equal(digest(bytes), pin.sha256);
      f.put(bytes);
      puts.push(pin);
      if (loseUpload) {
        loseUpload = false;
        throw Error('lost upload reply');
      }
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      f.put(bytes);
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    client: {
      mutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        if (offline) throw Error('offline');
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(d => ({
            digest: d,
            size: f.objects.get(d).length,
            location: 'r2',
          }));
        if (name === 'projectHostedSaves:prepare') return f.call('prepare', api.prepare, args);
        if (name === 'projectHostedSaves:stage') return f.call('stage', api.stage, args);
        if (name === 'projectHostedSaveJobs:submit')
          return JSON.stringify(await f.submit({ request: { operationId: args.operationId } }));
        assert.equal(name, 'projectHostedLifecycle:transition');
        const result = await f.lifeCall('lifecycleBegin', lifeApi.transition, args);
        if (loseLifecycle) {
          loseLifecycle = false;
          throw Error('lost lifecycle reply');
        }
        return result;
      },
      query: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        if (name === 'projectHostedLanes:select') return f.call('select', lanes.select, args);
        assert.equal(name, 'projectHostedSaves:progress');
        return f.call('progress', api.progress, args);
      },
    },
  };
  return {
    ...f,
    root,
    exchange,
    calls,
    puts,
    faults: flags => {
      if ('loseUpload' in flags) loseUpload = flags.loseUpload;
      if ('loseLifecycle' in flags) loseLifecycle = flags.loseLifecycle;
      if ('offline' in flags) offline = flags.offline;
    },
  };
}
test('dirty refusal and disconnected abandonment preserve local bytes and baseline', async t => {
  const f = await fixture(t),
    before = readHostedLaneCheckout(f.root);
  writeFileSync(join(f.root, 'a.txt'), 'dirty draft');
  const command = {
    operationId: randomUUID(),
    action: 'abandon',
    reason: 'stop',
  };
  await assert.rejects(transitionHostedLane(f.root, command, f.exchange), code('LANE_DIRTY'));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readHostedLaneCheckout(f.root), before);
  // A different client can close saved work; it cannot observe/discard these bytes.
  await f.begin(f.request());
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'dirty draft');
  assert.deepEqual(readHostedLaneCheckout(f.root), before);
  f.faults({ offline: true });
  await assert.rejects(
    transitionHostedLane(f.root, { operationId: randomUUID(), action: 'reopen' }, f.exchange),
    /offline/,
  );
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'dirty draft');
});
test('save-first lost replies retain child/captured bytes; pending save delays abandonment; reopen retains newer local edits', async t => {
  const f = await fixture(t),
    command = {
      operationId: randomUUID(),
      action: 'abandon',
      reason: 'retained compound',
      saveFirst: true,
    };
  writeFileSync(join(f.root, 'a.txt'), 'first dirty edit');
  f.faults({ loseUpload: true });
  await assert.rejects(transitionHostedLane(f.root, command, f.exchange), /lost upload reply/);
  writeFileSync(join(f.root, 'a.txt'), 'newer dirty edit');
  const pending = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(pending.phase, 'save');
  assert.equal((await f.read(f.laneId)).state, 'active');
  assert.equal(pending.lifecycle.status, 'pending');
  assert.equal(f.calls.filter(c => c.name === 'projectHostedLifecycle:transition').length, 1);
  assert.equal(f.puts.length, 1);
  const out = await f.work({
    request: { operationId: pending.saveOperationId },
  });
  await f.publish(out);
  await f.drain();
  assert.equal((await f.read(f.laneId)).state, 'abandoned', 'server continuation needs no editing client');
  f.faults({ loseLifecycle: true });
  await assert.rejects(transitionHostedLane(f.root, command, f.exchange), /lost lifecycle reply/);
  const retry = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(retry.phase, 'lifecycle');
  assert.equal(retry.result.status, 'applied');
  assert.equal(retry.result.saveOperationId, pending.saveOperationId);
  assert.equal((await f.read(f.laneId)).head, out.head);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'newer dirty edit');
  assert.equal(readHostedLaneCheckout(f.root).selection.state, 'abandoned');
  const savedState = JSON.parse(f.objects.get(out.head));
  assert.equal(savedState.files.find(x => x.path === 'a.txt').blob, digest('first dirty edit'));
  assert(savedState.files.some(x => x.path === 'hidden.txt'));
  const reopen = await transitionHostedLane(
    f.root,
    { operationId: randomUUID(), action: 'reopen' },
    f.exchange,
  );
  assert.equal(reopen.result.status, 'applied');
  assert.equal(readHostedLaneCheckout(f.root).selection.state, 'active');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'newer dirty edit');
  const marker = readHostedLaneCheckout(f.root);
  await transitionHostedLane(f.root, command, f.exchange);
  assert.deepEqual(readHostedLaneCheckout(f.root), marker);
  assert.equal(
    f.calls
      .filter(c => c.name === 'projectHostedLifecycle:transition')
      .map(c => JSON.parse(c.args.request).operationId)
      .filter(id => id === command.operationId).length,
    4,
  );
  await assert.rejects(
    transitionHostedLane(f.root, { ...command, reason: 'changed' }, f.exchange),
    code('WORK_OPERATION_CHANGED'),
  );
});
test('clean save-first requires no worker and does not move source; failed child leaves lifecycle untouched', async t => {
  const f = await fixture(t),
    command = {
      operationId: randomUUID(),
      action: 'abandon',
      reason: 'clean',
      saveFirst: true,
    };
  const done = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(done.phase, 'lifecycle');
  assert.equal(done.result.lane.head, f.baseline.sha256);
  assert.equal(f.tables.projectHostedRecordHeads.size > 0, true);
  assert.equal(f.tables.projectHostedStates.size, 0);
  assert.equal(f.puts.length, 0);
  const g = await fixture(t);
  writeFileSync(join(g.root, 'a.txt'), 'edit');
  const pending = await transitionHostedLane(g.root, { ...command, operationId: randomUUID() }, g.exchange);
  const out = await g.work({
    request: { operationId: pending.saveOperationId },
  });
  await g.changeLane(g.laneId, { lifecycleVersion: 1 });
  await g.publish(out);
  const journal = [...g.tables.projectHostedOperations.values()].find(
    x => x.operationId === pending.saveOperationId,
  );
  assert.equal(JSON.parse(journal.value).terminal.outcome.status, 'failed');
  const original = JSON.parse(
    readFileSync(join(`${g.root}.forge-client`, 'lifecycle', `${pending.operationId}.json`), 'utf8'),
  );
  const { operationId, action, reason, saveFirst } = original.identity;
  await g.drain();
  const failed = await transitionHostedLane(g.root, { operationId, action, reason, saveFirst }, g.exchange);
  assert.equal(failed.phase, 'lifecycle');
  assert.equal(failed.result.status, 'failed');
  assert.equal((await g.read(g.laneId)).state, 'active');
});

test('failed source worker wakes the retained parent without applying lifecycle or deleting its delta', async t => {
  const f = await fixture(t),
    command = {
      operationId: randomUUID(),
      action: 'abandon',
      reason: 'worker failure',
      saveFirst: true,
    };
  writeFileSync(join(f.root, 'a.txt'), 'retained failed draft');
  const pending = await transitionHostedLane(f.root, command, f.exchange);
  const row = [...f.tables.projectHostedSaves.values()].find(r => r.operationId === pending.saveOperationId);
  const { records } = await import('./hosted-lane-lifecycle-fixture.mjs');
  const job = await f.run('loadJobRecord', (ctx, input) => records.readHostedRecord(ctx, input), {
    ...f.auth,
    kind: 'job',
    key: row.jobId,
  });
  const before = JSON.parse(job.value);
  await f.run('failJob', (ctx, input) => records.writeHostedRecord(ctx, input), {
    ...f.auth,
    expectedVersion: before.version,
    record: {
      ...before,
      version: before.version + 1,
      status: 'failed',
      control: {
        ...before.control,
        failureCode: 'SOURCE_WORKER_UNAVAILABLE',
      },
    },
  });
  await f.call('resultDownload', jobApi.resultDownload, {
    projectId: f.projectId,
    jobId: row.jobId,
  });
  await f.drain();
  const replay = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(replay.phase, 'lifecycle');
  assert.equal(replay.result.status, 'failed');
  assert.equal((await f.read(f.laneId)).state, 'active');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'retained failed draft');
  assert.equal(JSON.parse(f.tables.projectHostedSaves.get(row._id).value).status, 'failed');
  assert.equal((await f.history('lane', f.laneId)).page.length, 0);
});

test('reopening an accepted Lane from a stale checkout marker reconciles pins, saves more work and replays idempotently', async t => {
  const f = await fixture(t),
    stale = readHostedLaneCheckout(f.root).selection;
  // Acceptance completed the Lane on the server (state, lifecycleVersion, version) behind this root's marker.
  const accepted = await f.changeLane(f.laneId, {
    state: 'completed',
    lifecycleVersion: 1,
  });
  const command = { operationId: randomUUID(), action: 'reopen' };
  const reopened = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(reopened.result.status, 'applied');
  assert.equal((await f.read(f.laneId)).state, 'active');
  const count = name => f.calls.filter(c => c.name === name).length;
  assert.equal(count('projectHostedLanes:select'), 1, 'one bounded read, only after the stale refusal');
  assert.equal(count('projectHostedLifecycle:transition'), 2);
  // The marker follows the server's metadata; its source baseline is untouched.
  const marker = readHostedLaneCheckout(f.root).selection;
  assert.equal(marker.state, 'active');
  assert.equal(marker.head, stale.head);
  assert.equal(marker.sourceVersion, stale.sourceVersion);
  assert.equal(marker.lifecycleVersion, accepted.lifecycleVersion + 1);
  assert.equal(marker.version, accepted.version + 1);
  // Replaying the same reopen request is a no-op: same result, no extra read, marker unchanged.
  const replay = await transitionHostedLane(f.root, command, f.exchange);
  assert.equal(replay.result.status, 'applied');
  assert.equal(count('projectHostedLanes:select'), 1);
  assert.deepEqual(readHostedLaneCheckout(f.root).selection, marker);
  // More work saves from the reopened checkout against the reconciled pins and moves the head.
  writeFileSync(join(f.root, 'a.txt'), 'work after reopen');
  const saveId = randomUUID();
  const pending = await saveHostedLane(f.root, { operationId: saveId, message: 'after reopen' }, f.exchange);
  assert.notEqual(pending.outcome?.status, 'failed');
  const out = await f.work({ request: { operationId: saveId } });
  await f.publish(out);
  const after = await f.read(f.laneId);
  assert.equal(after.head, out.head);
  assert.equal(after.state, 'active');
  assert.notEqual(after.head, accepted.head);
});
test('a reopen with a newer server source keeps that source and local bytes; a healthy reopen adds no read', async t => {
  const g = await fixture(t);
  await g.changeLane(g.laneId, { state: 'completed', lifecycleVersion: 1 });
  const before = readHostedLaneCheckout(g.root).selection;
  writeFileSync(join(g.root, 'a.txt'), 'unsaved local');
  await g.changeLane(g.laneId, {
    head: g.baseline.sha256,
    sourceVersion: before.sourceVersion + 1,
  });
  const out = await transitionHostedLane(g.root, { operationId: randomUUID(), action: 'reopen' }, g.exchange);
  assert.equal(out.result.status, 'applied');
  assert.equal(readFileSync(join(g.root, 'a.txt'), 'utf8'), 'unsaved local');
  const kept = readHostedLaneCheckout(g.root).selection;
  assert.equal(
    kept.sourceVersion,
    before.sourceVersion,
    'newer server source never overwrites the marker baseline',
  );
  assert.equal(kept.lifecycleVersion, before.lifecycleVersion);
  const h = await fixture(t);
  await transitionHostedLane(
    h.root,
    { operationId: randomUUID(), action: 'abandon', reason: 'x' },
    h.exchange,
  );
  const calls = h.calls.length;
  await transitionHostedLane(h.root, { operationId: randomUUID(), action: 'reopen' }, h.exchange);
  assert.equal(h.calls.length - calls, 1, 'healthy reopen: exactly one transition call, no select');
});
test('pinning a Lane moves its version behind the checkout marker; reopen from the same root still succeeds and refreshes it', async t => {
  const f = await fixture(t);
  await transitionHostedLane(
    f.root,
    { operationId: randomUUID(), action: 'abandon', reason: 'pin then reopen' },
    f.exchange,
  );
  const pinned = await f.changeLane(f.laneId, { pinned: true });
  assert(pinned.version > readHostedLaneCheckout(f.root).selection.version, 'marker is behind the pin');
  const out = await transitionHostedLane(f.root, { operationId: randomUUID(), action: 'reopen' }, f.exchange);
  assert.equal(out.result.status, 'applied');
  const marker = readHostedLaneCheckout(f.root).selection;
  assert.equal(marker.state, 'active');
  assert.equal(marker.version, pinned.version + 1);
  assert.equal((await f.read(f.laneId)).pinned, true);
});
