// SPDX-License-Identifier: Apache-2.0
// Unsaved-work snapshots of a hosted Lane checkout with undo (Issue 7ac4e32f).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lifecycleFixture, code } from './hosted-lane-lifecycle-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { snapshotLaneCheckout } from '../dist/hosted-lane-snapshot.js';
import { launchSnapshotWorker, snapshotWorkerTestHooks } from '../dist/hosted-snapshot-worker.js';
import { turnEndSnapshot } from '../dist/agent-turn-snapshot.js';
import { rememberSnapshotsKept, snapshotsKept } from '../dist/lane-snapshot-hint.js';
import { snapshotDirectory } from '../dist/lane-snapshot-hint.js';
import { executeSnapshots } from '../dist/hosted-lane-snapshot-restore.js';
import { LANE_SNAPSHOT, snapshotTarget } from '../dist/lane-snapshot-contract.js';
import { effectivePolicy } from '../dist/autonomy-policy.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';

const snapshots = await import(moduleUrl('../convex/projectLaneSnapshots.ts'));
const dropApi = await import(moduleUrl('../convex/projectLaneSnapshotDrop.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const handlers = {
  'projectLaneSnapshots:prepare': snapshots.prepare,
  'projectLaneSnapshots:commit': snapshots.commit,
  'projectLaneSnapshots:list': snapshots.list,
  'projectLaneSnapshots:read': snapshots.read,
  'projectLaneSnapshots:restore': snapshots.restore,
  'projectLaneSnapshots:purge': snapshots.purge,
  'projectLaneSnapshotDrop:begin': dropApi.begin,
  'projectLaneSnapshotDrop:deleteRows': dropApi.deleteRows,
  'projectLaneSnapshotDrop:run': dropApi.run,
  'projectObjectDownloads:signDownloads': downloads.signDownloads,
};

async function fixture(t, { policy = true } = {}) {
  const r2 = fakeSourceR2(t);
  const f = await lifecycleFixture();
  const jobs = new Map();
  const schedule = (at, ref, args) => {
    const id = `job-${jobs.size + 1}`;
    jobs.set(id, { id, at, name: getFunctionName(ref), args, state: 'pending' });
    return id;
  };
  const scheduler = {
    runAt: async (at, ref, args) => schedule(at, ref, args),
    runAfter: async (delay, ref, args) => schedule(Date.now() + delay, ref, args),
    cancel: async id => {
      const job = jobs.get(id);
      if (job) job.state = 'canceled';
    },
  };
  f.decorateContext(ctx => {
    ctx.scheduler = scheduler;
  });
  const project = f.tables.hostedProjects.get(f.projectId);
  if (policy)
    f.tables.hostedProjects.set(f.projectId, {
      ...project,
      autonomyPolicy: { ...effectivePolicy(project), autoSnapshot: true },
    });
  // Head files live in R2 like real saved objects, so a restore can put them back.
  for (const [sha256, bytes] of f.objects)
    r2.objects.set(`/synthetic/v1/p/${f.projectId}/o/${sha256}`, bytes);
  const calls = [];
  const invoke = async (name, args, actor = 'owner') => {
    calls.push(name);
    const fn = handlers[name];
    assert(fn, `unexpected call ${name}`);
    const result = await f.transaction(name, fn, args, actor);
    return result;
  };
  const client = (actor = 'owner') => ({
    mutation: (ref, args) => invoke(getFunctionName(ref), args, actor),
    query: (ref, args) => invoke(getFunctionName(ref), args, actor),
  });
  const base = mkdtempSync(join(tmpdir(), 'forge-lane-snapshots-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(base, 'lane');
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
  const rows = () => [...f.tables.projectLaneSnapshots.values()];
  const stored = () =>
    [...r2.objects.keys()].filter(key => key.startsWith(`/synthetic/v1/p/${f.projectId}/s/`));
  const snap = (actor = 'owner') => snapshotLaneCheckout(root, f.projectId, client(actor));
  const run = (command, actor = 'owner') => executeSnapshots(root, f.projectId, client(actor), command);
  /** Run the due drop jobs the way Convex would (actions call back into mutations). */
  const runJobs = async (now = Date.now()) => {
    for (const job of jobs.values())
      if (job.state === 'pending' && job.at <= now) {
        job.state = 'success';
        // An action: no transaction of its own; each runMutation is one.
        await handlers[job.name]._handler(
          { scheduler, runMutation: (ref, args) => invoke(getFunctionName(ref), args, null) },
          job.args,
        );
      }
  };
  return { f, r2, jobs, calls, client, root, rows, stored, snap, run, runJobs };
}
const text = (root, path) => readFileSync(join(root, path), 'utf8');

test('unchanged files cost no call; a changed snapshot is two calls and only changed bytes', async t => {
  const x = await fixture(t);
  assert.deepEqual(await x.snap(), { status: 'unchanged', calls: 0 });
  assert.equal(x.calls.length, 0, 'a fresh checkout equal to its head costs nothing');
  writeFileSync(join(x.root, 'a.txt'), 'edit one');
  const first = await x.snap();
  assert.equal(first.status, 'saved');
  assert.equal(first.calls, 2);
  assert.deepEqual(x.calls, ['projectLaneSnapshots:prepare', 'projectLaneSnapshots:commit']);
  // One page plus the one changed file; the unchanged head file is never sent.
  assert.equal(first.uploads, 2);
  assert.equal(x.stored().length, 2);
  x.calls.length = 0;
  assert.deepEqual(await x.snap(), { status: 'unchanged', calls: 0 });
  assert.equal(x.calls.length, 0, 'an unchanged tree costs no call');
  // No file bytes in Convex: rows carry digests and counts only.
  for (const row of x.rows()) assert(!JSON.stringify(row).includes('edit one'));
  // Snapshots never move the Lane head or touch the save path.
  assert.equal((await x.f.read(x.f.laneId)).head, x.f.expected.head);
  assert.equal(x.f.tables.projectHostedSaves.size, 0);
  // The prepare transaction stays small: at most two inserts and one patch.
  const prepare = x.f.counts.filter(c => c.name === 'projectLaneSnapshots:prepare');
  assert(
    prepare.every(c => c.writes <= 3 && c.documents <= 20),
    JSON.stringify(prepare.map(c => c.writes)),
  );
});

test('undo and redo walk the operation log; nothing is deleted', async t => {
  const x = await fixture(t);
  writeFileSync(join(x.root, 'a.txt'), 'v1');
  assert.equal((await x.snap()).seq, 1);
  writeFileSync(join(x.root, 'a.txt'), 'v2');
  writeFileSync(join(x.root, 'b.txt'), 'new');
  assert.equal((await x.snap()).seq, 2);
  writeFileSync(join(x.root, 'a.txt'), 'v3 unsnapshotted');
  // Undo first snapshots v3 (seq 3), then goes back one step: to seq 2.
  const undo = await x.run({ undo: 1 });
  assert.equal(undo.target, 2);
  assert.equal(text(x.root, 'a.txt'), 'v2');
  assert.equal(text(x.root, 'b.txt'), 'new');
  const again = await x.run({ undo: 1 });
  assert.equal(again.target, 1);
  assert.equal(text(x.root, 'a.txt'), 'v1');
  assert(!existsSync(join(x.root, 'b.txt')), 'a file the earlier snapshot lacked is gone from disk');
  const redo = await x.run({ redo: 1 });
  assert.equal(redo.target, 2);
  assert.equal(text(x.root, 'b.txt'), 'new');
  const redo2 = await x.run({ redo: 1 });
  assert.equal(redo2.target, 3);
  assert.equal(text(x.root, 'a.txt'), 'v3 unsnapshotted');
  // The message names the command that lists the log, so the CLI's generic "run from the Lane root"
  // lookup hint (src/argument-errors.ts), which would mislead here, is not appended.
  await assert.rejects(x.run({ redo: 1 }), error => {
    code('NOT_FOUND')(error);
    assert.match(error.message, /nforge x ROOT snapshots/);
    return true;
  });
  // Restoring to the head puts head bytes back from saved objects.
  writeFileSync(join(x.root, 'a.txt'), 'original');
  rmSync(join(x.root, 'b.txt'));
  const clean = await x.snap();
  assert.equal(clean.status, 'saved');
  writeFileSync(join(x.root, 'a.txt'), 'later');
  await x.snap();
  await x.run({ restore: clean.seq });
  assert.equal(text(x.root, 'a.txt'), 'original');
  const log = await x.run({});
  assert.equal(log.phase, 'list');
  assert(log.entries.length >= 8);
  assert(log.entries.every(entry => entry.kind === 'snapshot' || entry.kind === 'restore'));
  assert.equal(x.f.tables.projectHostedSaves.size, 0, 'moves never save');
  assert.equal((await x.f.read(x.f.laneId)).head, x.f.expected.head, 'moves never move the head');
});

test('kill the machine: a new checkout restores the unsaved files byte for byte', async t => {
  const x = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  writeFileSync(join(x.root, 'a.txt'), bytes);
  writeFileSync(join(x.root, 'notes.md'), 'unsaved notes\n');
  await x.snap();
  const marker = readFileSync(join(x.root, '.forge/hosted-lane.json'));
  rmSync(x.root, { recursive: true, force: true });
  rmSync(`${x.root}.forge-client`, { recursive: true, force: true });
  mkdirSync(join(x.root, '.forge'), { recursive: true });
  writeFileSync(join(x.root, 'a.txt'), 'original');
  writeFileSync(join(x.root, '.forge/hosted-lane.json'), marker);
  const restored = await x.run({ restore: 'latest' });
  assert.equal(restored.phase, 'restore');
  assert.deepEqual(readFileSync(join(x.root, 'a.txt')), bytes);
  assert.equal(text(x.root, 'notes.md'), 'unsaved notes\n');
});

test('secrets and big new files are left out like a save', async t => {
  const x = await fixture(t);
  // Synthetic credential-shaped value, built at run time (never a real key).
  const key = `AKIA${'QX7ZB2MNV4KT9WRD'}`;
  writeFileSync(join(x.root, '.env'), 'SYNTHETIC_TOKEN=not-a-real-value\n');
  writeFileSync(join(x.root, 'config.ini'), `aws_access_key_id = "${key}"\n`);
  writeFileSync(join(x.root, 'big.bin'), Buffer.alloc(LANE_SNAPSHOT.newFileBytes + 1));
  writeFileSync(join(x.root, 'a.txt'), 'edited');
  const saved = await x.snap();
  assert.equal(saved.status, 'saved');
  assert.equal(saved.changes, 1);
  assert(saved.notSaved.count >= 3);
  assert.deepEqual(saved.notSaved.capped, ['big.bin']);
  assert.deepEqual(
    saved.notSaved.held,
    ['config.ini'],
    'content the secret scan flags never reaches storage',
  );
  for (const bytes of x.r2.objects.values()) {
    assert(!bytes.toString().includes('not-a-real-value'));
    assert(!bytes.toString().includes(key));
  }
  // The verdict is kept by digest: an unchanged held file is not read or scanned again.
  writeFileSync(join(x.root, 'a.txt'), 'edited again');
  assert.deepEqual((await x.snap()).notSaved.held, ['config.ini']);
  // Once the credential is removed the file is snapshotted like any other.
  writeFileSync(join(x.root, 'config.ini'), 'region = "eu"\n');
  const clean = await x.snap();
  assert.equal(clean.changes, 2);
  assert.deepEqual(clean.notSaved?.held ?? [], []);
});

test('policy off, closed Lanes and other members are refused; nothing is stored', async t => {
  const off = await fixture(t, { policy: false });
  writeFileSync(join(off.root, 'a.txt'), 'edited');
  // The checkout last saw snapshots on; the refusal makes it forget, so a turn end stops looking.
  rememberSnapshotsKept(off.root, true);
  const refused = await off.snap();
  assert.equal(refused.status, 'skipped');
  assert.equal(refused.code, 'SNAPSHOTS_OFF');
  assert.equal(snapshotsKept(off.root), false);
  assert.equal(off.rows().length, 0);
  assert.equal(off.stored().length, 0);

  const x = await fixture(t);
  writeFileSync(join(x.root, 'a.txt'), 'edited');
  const stranger = await x.snap('stranger');
  assert.equal(stranger.status, 'skipped');
  assert.equal(x.rows().length, 0);
  await assert.rejects(x.run({}, 'stranger'));
  await x.f.changeLane(x.f.laneId, { state: 'abandoned' });
  assert.equal((await x.snap()).code, 'LANE_NOT_ACTIVE');
  assert.equal(x.rows().length, 0);
});

test('a snapshot over the Lane cap is refused once per tree', async t => {
  const x = await fixture(t);
  writeFileSync(join(x.root, 'a.txt'), 'one');
  await x.snap();
  const meta = x.rows().find(row => row.seq === 0);
  x.f.tables.projectLaneSnapshots.set(meta._id, { ...meta, laneBytes: LANE_SNAPSHOT.laneBytes });
  writeFileSync(join(x.root, 'a.txt'), 'two');
  const first = await x.snap();
  assert.equal(first.code, 'QUOTA_EXCEEDED');
  x.calls.length = 0;
  assert.equal((await x.snap()).status, 'unchanged');
  assert.equal(x.calls.length, 0);
});

test('expiry and purge delete objects and rows for real; the next snapshot resends', async t => {
  const x = await fixture(t);
  writeFileSync(join(x.root, 'a.txt'), 'one');
  await x.snap();
  writeFileSync(join(x.root, 'a.txt'), 'two');
  await x.snap();
  assert.equal(x.stored().length, 4);
  const expiry = [...x.jobs.values()].filter(job => job.name === 'projectLaneSnapshotDrop:run');
  assert.equal(expiry.length, 1, 'one expiry job per Lane');
  // Waking early moves the job to the latest expiry instead of dropping.
  await x.runJobs(expiry[0].at);
  assert.equal(x.stored().length, 4);
  // Due: objects first, then rows; the Lane row waits for every signed PUT URL to expire.
  const meta = x.rows().find(row => row.seq === 0);
  const due = meta.expiresAt + 1;
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => due;
  for (const job of x.jobs.values()) if (job.state === 'pending') job.at = due;
  await x.runJobs(due);
  assert.equal(x.stored().length, 0, 'storage falls');
  assert.deepEqual(
    x.rows().map(row => row.seq),
    [0],
  );
  writeFileSync(join(x.root, 'a.txt'), 'three');
  assert.equal((await x.snap()).code, 'WORK_BUSY', 'no snapshot while signed PUT URLs may still land');
  Date.now = () => due + 16 * 60_000;
  for (const job of x.jobs.values()) if (job.state === 'pending') job.at = Date.now();
  await x.runJobs(Date.now());
  assert.equal(x.rows().length, 0, 'the Lane row goes after the sweep');
  Date.now = realNow;
  // The store was dropped: the client resends every changed file, not only new ones.
  writeFileSync(join(x.root, 'a.txt'), 'one');
  const resent = await x.snap();
  assert.equal(resent.status, 'saved');
  assert.equal(resent.calls, 3, 'reset, prepare again, commit');
  assert.equal(x.stored().length, 2);
  // Owner purge: everything goes, at once.
  const purged = await x.run({ purge: true });
  assert.equal(purged.state, 'purging');
  await x.runJobs(Date.now());
  assert.equal(x.stored().length, 0);
});

test('snapshotTarget follows the parent chain and redo walks back undos', () => {
  const at = '2026-11-09T00:00:00.000Z',
    tree = 'a'.repeat(64),
    snap = (seq, parent) => ({
      seq,
      kind: 'snapshot',
      at,
      head: tree,
      tree,
      pages: null,
      changeCount: 0,
      uploadBytes: 0,
      notSaved: 0,
      ...(parent ? { parent } : {}),
    }),
    move = (seq, target, kind, parent) => ({ ...snap(seq, parent), kind: 'restore', target, move: kind });
  const log = [move(5, 2, 'undo', 4), snap(4, 3), snap(3, 2), snap(2, 1), snap(1)];
  assert.equal(snapshotTarget(log, { undo: 1 }), 1);
  assert.equal(snapshotTarget(log, { undo: 2 }), null);
  assert.equal(snapshotTarget(log, { redo: 1 }), 4);
  assert.equal(snapshotTarget(log, { restore: 'latest' }), 4);
  assert.equal(snapshotTarget(log, { restore: 3 }), 3);
  assert.equal(snapshotTarget(log, { restore: 5 }), null, 'only snapshots are targets');
  assert.throws(() => hostedAgentCommandSchemas.snapshots.parse({ undo: 1, redo: 1 }));
});

test('a lock left by a killed process is cleared at once, not after two minutes', async t => {
  const x = await fixture(t);
  writeFileSync(join(x.root, 'a.txt'), 'edit');
  mkdirSync(snapshotDirectory(x.root), { recursive: true });
  // A pid beyond the default range is never alive: the previous process died holding the lock.
  writeFileSync(join(snapshotDirectory(x.root), 'lock'), String(2 ** 22 + 12345));
  const first = await x.snap();
  assert.equal(first.status, 'saved', 'a dead holder does not block the next command for two minutes');
});

test('a command hands its snapshot to one detached worker and never waits for it', async t => {
  const x = await fixture(t);
  rememberSnapshotsKept(x.root, true);
  const launches = [];
  const failing = [];
  snapshotWorkerTestHooks.launch = (command, args, options) => {
    if (failing.length) throw new Error('spawn failed');
    launches.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  t.after(() => delete snapshotWorkerTestHooks.launch);
  process.env.JJSNAP_UNRELATED_SECRET = 'must-not-reach-the-worker';
  t.after(() => delete process.env.JJSNAP_UNRELATED_SECRET);
  const address = { url: 'https://fixture.invalid', projectId: x.f.projectId };
  assert.equal(launchSnapshotWorker(x.root, address), true);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.detached, true, 'it outlives the command that started it');
  assert.equal(launches[0].options.stdio, 'ignore', 'no pipe or handle can keep the CLI alive');
  assert(!('JJSNAP_UNRELATED_SECRET' in launches[0].options.env), 'only an allowlisted environment');
  assert.deepEqual(launches[0].args.slice(1), [x.root, address.url, address.projectId]);
  // A burst of commands snapshots once.
  assert.equal(launchSnapshotWorker(x.root, address), false);
  const stamp = join(snapshotDirectory(x.root), 'worker');
  const old = new Date(Date.now() - 60_000);
  utimesSync(stamp, old, old);
  // A snapshot already running (live holder) is not doubled; a dead holder's lock is no obstacle.
  writeFileSync(join(snapshotDirectory(x.root), 'lock'), String(process.pid));
  assert.equal(launchSnapshotWorker(x.root, address), false);
  writeFileSync(join(snapshotDirectory(x.root), 'lock'), String(2 ** 22 + 12345));
  assert.equal(launchSnapshotWorker(x.root, address), true);
  assert.equal(launches.length, 2);
  // A launch that fails never reaches the command.
  utimesSync(stamp, old, old);
  failing.push(1);
  assert.equal(launchSnapshotWorker(x.root, address), false);
});

test('the turn-end snapshot covers edits after the last command, once, with no call when nothing changed', async t => {
  const x = await fixture(t);
  const sub = join(x.root, 'src');
  mkdirSync(sub);
  let built = 0;
  const factory = async target => {
    built++;
    assert.equal(target.projectId, x.f.projectId);
    return x.client();
  };
  // A checkout whose project never kept snapshots: not even a walk.
  writeFileSync(join(x.root, 'a.txt'), 'edited after the last command');
  assert.equal(await turnEndSnapshot({ cwd: sub }, factory), null);
  assert.equal(built, 0);
  assert.equal(x.calls.length, 0);
  rememberSnapshotsKept(x.root, true);
  assert.equal(snapshotsKept(x.root), true);
  // The agent's cwd is a subdirectory of the Lane: the Lane checkout is found from it.
  const taken = await turnEndSnapshot({ cwd: sub }, factory);
  assert.equal(taken?.status, 'saved');
  assert.deepEqual(x.calls, ['projectLaneSnapshots:prepare', 'projectLaneSnapshots:commit']);
  x.calls.length = 0;
  assert.deepEqual(await turnEndSnapshot({ cwd: sub }, factory), { status: 'unchanged', calls: 0 });
  assert.equal(x.calls.length, 0, 'a turn that changed nothing costs no call');
  // Not inside any Lane checkout, or no cwd: nothing.
  assert.equal(await turnEndSnapshot({ cwd: tmpdir() }, factory), null);
  assert.equal(await turnEndSnapshot({}, factory), null);
  rememberSnapshotsKept(x.root, false);
  assert.equal(snapshotsKept(x.root), false);
});
