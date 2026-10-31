// SPDX-License-Identifier: Apache-2.0
// Incident replay (2026-10-30/31, Lanes 259ea29d and a2dced54): a checkpoint's
// source job finished after the client returned, so the checkout marker kept the
// old head. Every later save captured against that head and the server refused
// it WORK_STALE; replaying the refused save repeated the refusal, and abandon
// from the checkout read the already-saved edits as LANE_DIRTY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lifecycleFixture, api as lifeApi, lanes, code } from './hosted-lane-lifecycle-fixture.mjs';
import { api } from './hosted-saves-fixture.mjs';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { transitionHostedLane } from '../dist/hosted-lifecycle-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { buildSavePages } from '../dist/hosted-save.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { digest } from '../dist/hash.js';

async function fixture(t) {
  const f = await lifecycleFixture(),
    base = mkdtempSync(join(tmpdir(), 'forge-work-stale-')),
    root = join(base, 'client');
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(join(root, 'hidden.txt'), 'unmaterialized');
  // The checkout cache holds the baseline bytes it installed.
  mkdirSync(join(`${root}.forge-client`, 'objects'), { recursive: true });
  for (const value of ['original', 'unmaterialized'])
    writeFileSync(join(`${root}.forge-client`, 'objects', digest(value)), value);
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
      scope: null,
      materialized: ['a.txt', 'hidden.txt'],
    }),
  );
  const calls = [];
  let loseNextPrepare = false;
  const exchange = {
    projectId: f.projectId,
    missing: async pins => pins.filter(p => !f.objects.has(p.sha256)).map(p => p.sha256),
    uploadFile: async (pin, dir, path) => {
      const bytes = readFileSync(join(dir, path));
      assert.equal(digest(bytes), pin.sha256);
      f.put(bytes);
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      f.put(bytes);
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    downloadBatch: async pins => pins.map(pin => f.objects.get(pin.sha256)),
    downloadToFile: async () => assert.fail('small objects use the batch path'),
    prepareDownloads: async () => {},
    client: {
      mutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(d => ({ digest: d, size: f.objects.get(d).length, location: 'r2' }));
        if (name === 'projectObjectDownloads:lanePage')
          return args.digests.map(d => ({ digest: d, size: f.objects.get(d).length }));
        if (name === 'projectHostedSaves:prepare') {
          if (loseNextPrepare) {
            loseNextPrepare = false;
            throw Error('lost before the request reached the server');
          }
          return f.call('prepare', api.prepare, args);
        }
        if (name === 'projectHostedSaves:stage') return f.call('stage', api.stage, args);
        if (name === 'projectHostedSaveJobs:submit')
          return JSON.stringify(await f.submit({ request: { operationId: args.operationId } }));
        assert.equal(name, 'projectHostedLifecycle:transition');
        return f.lifeCall('lifecycleBegin', lifeApi.transition, args);
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
  /** The server-side source job finishes after the client already returned. */
  const complete = async operationId => f.publish(await f.work({ request: { operationId } }));
  /** Another writer (a sync, another checkout) moves the Lane on the server only. */
  const writer = async files => {
    const lane = await f.read(f.laneId),
      state = JSON.parse(f.objects.get(lane.head).toString());
    const changes = Object.entries(files).map(([path, bytes]) => {
      const old = state.files.find(file => file.path === path),
        pin = f.put(bytes);
      return {
        path,
        before: old ? { blob: old.blob, mode: old.mode } : null,
        after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
      };
    });
    const x = await f.prepare(changes, {
      expected: {
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      },
    });
    assert.equal(buildSavePages(changes).pages.length, x.pages.length);
    await f.stage(x);
    await f.submit(x);
    return complete(x.request.operationId);
  };
  const pending = () => readdirSync(`${root}.forge-client`).filter(name => name.startsWith('save-baseline-'));
  const savedFile = async path => {
    const lane = await f.read(f.laneId),
      state = JSON.parse(f.objects.get(lane.head).toString());
    return state.files.find(file => file.path === path)?.blob;
  };
  return {
    ...f,
    root,
    exchange,
    calls,
    complete,
    writer,
    pending,
    savedFile,
    loseNextPrepare: () => {
      loseNextPrepare = true;
    },
  };
}
const since = (s, at, pattern) => s.calls.slice(at).filter(call => pattern.test(call.name));

test('incident replay: a fresh save after an unseen async checkpoint settles it and saves, with one progress read', async t => {
  const s = await fixture(t),
    first = randomUUID(),
    second = randomUUID();
  writeFileSync(join(s.root, 'a.txt'), 'first edit');
  const submitted = await saveHostedLane(s.root, { operationId: first, message: 'first' }, s.exchange);
  assert.equal(submitted.outcome, undefined, 'the checkpoint returned before its source job finished');
  await s.complete(first);
  const old = readHostedLaneCheckout(s.root);
  assert.equal(old.selection.head, s.expected.head, 'the incident state: marker still on the old head');
  assert.equal(s.pending().length, 1);

  writeFileSync(join(s.root, 'a.txt'), 'second edit');
  const at = s.calls.length;
  const next = await saveHostedLane(s.root, { operationId: second, message: 'second' }, s.exchange);
  assert.equal(next.outcome, undefined);
  const progress = since(s, at, /Saves:progress/).map(call => call.args.operationId);
  assert.deepEqual(
    progress,
    [first, second],
    'one read settles the earlier save; one is the normal staging read',
  );
  assert.equal(since(s, at, /Lanes:select/).length, 0, 'no repair needed once settled');
  assert.equal(readHostedLaneCheckout(s.root).selection.version, 1, 'marker advanced to the saved head');

  await s.complete(second);
  const replayed = await saveHostedLane(s.root, { operationId: second, message: 'second' }, s.exchange);
  assert.equal(replayed.outcome.status, 'completed');
  assert.equal(await s.savedFile('a.txt'), digest('second edit'));
  assert.equal(readHostedLaneCheckout(s.root).selection.head, (await s.read(s.laneId)).head);
  assert.equal(s.pending().length, 0);

  // Normal path budget: nothing pending, so no settle read and no Lane read.
  writeFileSync(join(s.root, 'a.txt'), 'third edit');
  const third = randomUUID(),
    normal = s.calls.length;
  await saveHostedLane(s.root, { operationId: third, message: 'third' }, s.exchange);
  assert.deepEqual(
    since(s, normal, /Saves:progress|Lanes:select/).map(call => call.args.operationId ?? call.name),
    [third],
  );
});

test('incident replay: replaying a save refused WORK_STALE rebases onto the moved Lane and keeps local edits', async t => {
  const s = await fixture(t),
    op = randomUUID();
  writeFileSync(join(s.root, 'a.txt'), 'mine');
  s.loseNextPrepare();
  await assert.rejects(saveHostedLane(s.root, { operationId: op, message: 'mine' }, s.exchange), /lost/);
  // While the reply was unknown the Lane moved: a sync changed another file and added one.
  await s.writer({ 'hidden.txt': 'from main', 'c.txt': 'new on main' });
  const at = s.calls.length;
  // The repair command printed for the old failure: replay the same operation.
  const saved = await saveHostedLane(s.root, { operationId: op, message: 'mine' }, s.exchange);
  assert.equal(saved.outcome, undefined);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'mine', 'local edit preserved');
  assert.equal(readFileSync(join(s.root, 'hidden.txt'), 'utf8'), 'from main', 'server change installed');
  assert.equal(readFileSync(join(s.root, 'c.txt'), 'utf8'), 'new on main');
  // Repair budget: one Lane read and one batched download page per object window.
  assert.equal(since(s, at, /Lanes:select/).length, 1);
  assert(since(s, at, /lanePage/).length <= 2);
  const prepares = since(s, at, /Saves:prepare/).map(call => JSON.parse(call.args.request));
  assert.equal(prepares.length, 2, 'the stale request once, then the rebased one');
  assert.equal(prepares[1].expected.version, 1);
  assert.deepEqual(
    prepares.map(request => request.operationId),
    [op, op],
  );

  await s.complete(op);
  const done = await saveHostedLane(s.root, { operationId: op, message: 'mine' }, s.exchange);
  assert.equal(done.outcome.status, 'completed');
  assert.equal(await s.savedFile('a.txt'), digest('mine'));
  assert.equal(await s.savedFile('hidden.txt'), digest('from main'));
  assert.equal(await s.savedFile('c.txt'), digest('new on main'));
  assert.equal(readHostedLaneCheckout(s.root).selection.head, (await s.read(s.laneId)).head);
});

test('live 2026-10-31 shape: replaying a refused save left by an older client beside an unseen async save repairs it', async t => {
  const s = await fixture(t),
    first = randomUUID(),
    refused = randomUUID();
  writeFileSync(join(s.root, 'a.txt'), 'first edit');
  await saveHostedLane(s.root, { operationId: first, message: 'first' }, s.exchange);
  await s.complete(first);
  // Older clients captured the next save against the old marker and kept it after the refusal.
  writeFileSync(join(s.root, 'd.txt'), 'new file');
  await captureHostedSave(s.root, join(`${s.root}.forge-client`, 'saves', refused));
  const saved = await saveHostedLane(s.root, { operationId: refused, message: 'next' }, s.exchange);
  assert.equal(saved.outcome, undefined);
  assert.equal(s.pending().length, 1, 'the old baseline file is not left behind');
  await s.complete(refused);
  assert.equal(
    (await saveHostedLane(s.root, { operationId: refused, message: 'next' }, s.exchange)).outcome.status,
    'completed',
  );
  assert.equal(await s.savedFile('a.txt'), digest('first edit'));
  assert.equal(await s.savedFile('d.txt'), digest('new file'));
  assert.equal(s.pending().length, 0);
});

test('a rebase that would overwrite a local edit changes nothing and names one repair; keepPatch abandons safely', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'mine\nsecond line\n');
  await s.writer({ 'a.txt': 'theirs' });
  const before = readHostedLaneCheckout(s.root);
  const error = await saveHostedLane(
    s.root,
    { operationId: randomUUID(), message: 'mine' },
    s.exchange,
  ).catch(error => error);
  assert(code('SAVE_REBASE_CONFLICT')(error), error.message);
  assert.match(error.message, /a\.txt/);
  assert.match(error.message, /"keepPatch":true/);
  assert.deepEqual(readHostedLaneCheckout(s.root), before);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'mine\nsecond line\n');

  // Without a choice the abandon refuses and names both safe paths.
  const refused = await transitionHostedLane(
    s.root,
    { operationId: randomUUID(), action: 'abandon', reason: 'stuck' },
    s.exchange,
  ).catch(error => error);
  assert(code('LANE_DIRTY')(refused));
  assert.match(refused.message, /keepPatch:true/);

  const abandon = { operationId: randomUUID(), action: 'abandon', reason: 'stuck', keepPatch: true };
  const result = await transitionHostedLane(s.root, abandon, s.exchange);
  assert.equal(result.result.status, 'applied');
  assert.equal((await s.read(s.laneId)).state, 'abandoned');
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'mine\nsecond line\n', 'checkout untouched');
  // The kept patch re-applies on the old baseline in a fresh directory.
  const fresh = mkdtempSync(join(tmpdir(), 'forge-kept-patch-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  writeFileSync(join(fresh, 'a.txt'), 'original');
  execFileSync('git', ['apply', result.kept.patch], { cwd: fresh });
  assert.equal(readFileSync(join(fresh, 'a.txt'), 'utf8'), 'mine\nsecond line\n');
  const replay = await transitionHostedLane(s.root, abandon, s.exchange);
  assert.equal(replay.kept.patch, result.kept.patch);
});

test('abandon from a checkout whose last save finished unseen settles it instead of LANE_DIRTY', async t => {
  const s = await fixture(t),
    op = randomUUID();
  writeFileSync(join(s.root, 'a.txt'), 'saved but unseen');
  await saveHostedLane(s.root, { operationId: op, message: 'saved' }, s.exchange);
  await s.complete(op);
  const result = await transitionHostedLane(
    s.root,
    { operationId: randomUUID(), action: 'abandon', reason: 'done' },
    s.exchange,
  );
  assert.equal(result.result.status, 'applied');
  assert.equal((await s.read(s.laneId)).state, 'abandoned');
  assert.equal(await s.savedFile('a.txt'), digest('saved but unseen'));
  assert(!existsSync(join(s.root, 'kept')));
});

test('a new save while the earlier one still publishes resumes it and asks for one retry', async t => {
  const s = await fixture(t),
    first = randomUUID(),
    second = randomUUID();
  writeFileSync(join(s.root, 'a.txt'), 'first');
  await saveHostedLane(s.root, { operationId: first, message: 'first' }, s.exchange);
  writeFileSync(join(s.root, 'a.txt'), 'second');
  const error = await saveHostedLane(s.root, { operationId: second, message: 'second' }, s.exchange).catch(
    error => error,
  );
  assert(code('SAVE_PENDING')(error), error.message);
  assert(!existsSync(join(`${s.root}.forge-client`, 'saves', second, 'capture.json')), 'nothing captured');
  await s.complete(first);
  const saved = await saveHostedLane(s.root, { operationId: second, message: 'second' }, s.exchange);
  assert.equal(saved.outcome, undefined);
  await s.complete(second);
  await saveHostedLane(s.root, { operationId: second, message: 'second' }, s.exchange);
  assert.equal(await s.savedFile('a.txt'), digest('second'));
});
