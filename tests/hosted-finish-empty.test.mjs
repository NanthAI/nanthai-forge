// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Incident a930de4c (2026-11-07): `land --save` with a Lane id from a folder that was not the Lane's
// checkout landed the server-recorded head (== base), reported LANDED and left five edits unsaved.
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { recordLane } from '../dist/lane-registry.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { finishResubmitContinuation } from '../dist/hosted-agent-finish-result.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { synthetic } from './hosted-revert-fixture.mjs';
import { ConvexError } from 'convex/values';

const priorEnv = Object.fromEntries(
  [...Object.keys(synthetic), 'XDG_STATE_HOME'].map(key => [key, process.env[key]]),
);
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const landingWrites = s =>
  s.calls.filter(call => /projectHostedLanding(?:Desired)?:(?:enqueue|submit)/.test(call.name)).length;

/** The incident's Lane: head == base, opened in its own folder, with unsaved edits, and a second
 * folder (the clone root) with no checkout marker for it. */
async function incident(t, { edits = 5 } = {}) {
  const s = agentFixture(t);
  const state = temporaryDirectory(t, 'forge-empty-land-');
  process.env.XDG_STATE_HOME = state;
  s.lane.head = s.lane.base.head;
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  for (let i = 0; i < edits; i++) writeFileSync(join(s.root, `unsaved-${i}.txt`), `edit ${i}\n`);
  recordLane({ laneId: s.lane.laneId, root: s.root, url: s.address.url, projectId: s.address.projectId });
  const clone = join(state, 'clone');
  mkdirSync(clone);
  return { s, clone, from: root => new HostedAgentTransport(root, s.address, s.exchange) };
}

test('incident replay: land by Lane id with head == base and unsaved edits is refused, naming count and command', async t => {
  const { s, clone, from } = await incident(t);
  const before = s.calls.length;
  await assert.rejects(from(clone).dispatch('finish', { laneId: s.lane.laneId }), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.match(error.message, /5 unsaved paths/);
    assert.match(error.message, /land --save/);
    assert(error.message.includes(s.root), 'names the Lane folder to run it in');
    return true;
  });
  assert.equal(landingWrites(s), 0, 'nothing was submitted');
  assert(
    !s.calls.slice(before).some(call => /Compose|Save|Landing|Checks/.test(call.name)),
    'the unsaved-edit refusal is local: no source, check or landing call',
  );
  // Even an explicit allowEmpty never lands over unsaved edits.
  await assert.rejects(from(clone).dispatch('finish', { laneId: s.lane.laneId, allowEmpty: true }), {
    code: 'UNSAVED_LANE_EDITS',
  });
});

test('land of an empty Lane is refused as nothing to land, unless allowEmpty asks for it', async t => {
  const { s, clone, from } = await incident(t, { edits: 0 });
  // By Lane id from another folder: one Lane read tells head == base.
  await assert.rejects(from(clone).dispatch('finish', { laneId: s.lane.laneId }), {
    code: 'NOTHING_TO_LAND',
  });
  // From the Lane's own folder: the saved head equals the base, no Lane read.
  await assert.rejects(s.transport().dispatch('finish', { laneId: s.lane.laneId }), {
    code: 'NOTHING_TO_LAND',
  });
  assert.equal(landingWrites(s), 0);
  const deliberate = await s
    .transport()
    .dispatch('finish', { laneId: s.lane.laneId, allowEmpty: true, accept: false });
  assert.equal(deliberate.result.phase, 'check');
  assert.equal(deliberate.result.changedPaths, 0);
});

// Issue ac13de6b (report a3d59b6c, 2026-11-05): `land --check-only` on a no-change Lane, then an edit
// and a re-run, returned NOT_FOUND on every re-run. The re-run probed the landing page for the earlier
// operation (a check-only id is never a landing) and the real server's NOT_FOUND arrives inside
// ConvexError data, so the probe's `error.code` test missed it and the read failed the finish.
for (const accept of [false, undefined])
  test(`incident replay: ${accept === false ? 'check-only' : 'land'} after a no-change finish, an edit and a re-run is a clear result, never NOT_FOUND`, async t => {
    const s = agentFixture(t);
    const state = temporaryDirectory(t, 'forge-empty-rerun-');
    process.env.XDG_STATE_HOME = state;
    const edited = s.lane.head;
    s.lane.head = s.lane.base.head;
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    let landingPageReads = 0;
    const run = () => {
      const transport = s.transport();
      const query = transport.query.bind(transport);
      transport.query = async (name, args) => {
        if (name === 'projectHostedFinishObserve:page') {
          landingPageReads++;
          // The deployed server's shape: the code is in ConvexError data (convex/errors.ts report).
          throw new ConvexError({ code: 'NOT_FOUND', message: 'Select one hosted landing operation.' });
        }
        return query(name, args);
      };
      return transport.dispatch('finish', accept === false ? { accept } : {});
    };
    const refusals = [];
    for (let i = 0; i < 2; i++) await assert.rejects(run(), error => refusals.push(error.code) > 0);
    assert.deepEqual(refusals, ['NOTHING_TO_LAND', 'NOTHING_TO_LAND'], 'no change: the same clear refusal');
    // The agent edits a file and saves it: the checkout now holds the Lane's new saved head.
    const changed = edited;
    s.lane.head = changed;
    const markerPath = join(s.root, '.forge', 'hosted-lane.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    const saved = JSON.parse(s.objects.get(changed).toString());
    for (const file of saved.files) writeFileSync(join(s.root, file.path), s.objects.get(file.blob));
    marker.selection.head = changed;
    marker.state = saved;
    marker.materialized = [...new Set([...marker.materialized, ...saved.files.map(file => file.path)])];
    writeFileSync(markerPath, JSON.stringify(marker));
    const before = s.calls.length;
    const rerun = await run();
    assert.equal(rerun.result.phase, accept === false ? 'check' : 'finish', 'new source is new work');
    assert.equal(landingPageReads, 0, 'a refused earlier finish is ended locally: no landing read');
    assert.equal(
      s.calls.slice(before).filter(call => /Observe|CheckRead/.test(call.name)).length,
      0,
      'zero added Convex reads',
    );
    // Re-running the same source again replays that new operation, still a clear result.
    assert.equal((await run()).operationId, rerun.operationId);
  });

test('a Lane with changes lands and the reply states the changed path count at zero added calls', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // The base State manifest is on this machine (the start or last sync downloaded it).
  const objects = join(clientCacheRoot(s.root), 'objects');
  mkdirSync(objects, { recursive: true });
  writeFileSync(join(objects, s.lane.base.head), s.objects.get(s.lane.base.head));
  const before = s.calls.length;
  const landed = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(landed.result.phase, 'finish');
  assert.equal(landed.result.changedPaths, 1, 'the fixture Lane changes one file against its base');
  const names = s.calls.slice(before).map(call => call.name);
  assert.equal(
    names.filter(name => name === 'projectHostedLanes:select').length,
    1,
    'the one Lane read is the existing stack-parent read; the checks add none',
  );
  // A replay of the same operation keeps the count from the journal.
  const replay = await s.transport().dispatch('finish', {
    laneId: s.lane.laneId,
    operationId: landed.operationId,
  });
  assert.equal(replay.result.changedPaths, 1);
});

test('the LANDED line states the number of changed paths', () => {
  const landed = changedPaths => ({
    result: {
      phase: 'finish',
      submission: { phase: 'landed', acceptance: { receiptId: 'r1', head: 'h' } },
      ...(changedPaths === undefined ? {} : { changedPaths }),
    },
  });
  assert.deepEqual(landSummary(landed(5)), ['LANDED receipt r1, 5 changed paths']);
  assert.deepEqual(landSummary(landed(1)), ['LANDED receipt r1, 1 changed path']);
  assert.deepEqual(landSummary(landed(0)), ['LANDED receipt r1, 0 changed paths']);
  assert.deepEqual(landSummary(landed(null)), ['LANDED receipt r1']);
  assert.deepEqual(landSummary(landed(undefined)), ['LANDED receipt r1']);
});

// Issue 593fc2d7 (Lane 0200969a, 2026-11-19): the Lane moved on the server after the folder was
// read (same head, newer sourceVersion), so `land --save` met WORK_STALE before anything was
// submitted. After the folder caught up, every shorthand `land --save` reused that refused
// operation and its pinned selection, and failed WORK_STALE again; only adding a laneId (a new
// shorthand key) landed. A pre-submit WORK_STALE ends the operation: the re-run is new work.
test('593fc2d7: land --save after a pre-submit WORK_STALE and a refreshed folder is new work, never the same WORK_STALE', async t => {
  const s = agentFixture(t);
  process.env.XDG_STATE_HOME = temporaryDirectory(t, 'forge-stale-land-');
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const objects = join(clientCacheRoot(s.root), 'objects');
  mkdirSync(objects, { recursive: true });
  writeFileSync(join(objects, s.lane.base.head), s.objects.get(s.lane.base.head));
  // The server Lane moves on (a sync or resolution elsewhere): same head, newer source version.
  s.lane.version++;
  s.lane.sourceVersion++;
  const run = () => {
    const transport = s.transport();
    const query = transport.query.bind(transport);
    transport.query = async (name, args) => {
      if (name === 'projectHostedComposeSelection:page')
        for (const item of args.inputs)
          if (
            item.expected &&
            (item.expected.version !== s.lane.version || item.expected.sourceVersion !== s.lane.sourceVersion)
          )
            throw new ConvexError({ code: 'WORK_STALE', message: 'The selected Lane pins changed.' });
      return query(name, args);
    };
    return transport.dispatch('finish', {});
  };
  await assert.rejects(run(), error => error.code === 'WORK_STALE');
  // The folder catches up with the server Lane (what open, sync or a resolution records).
  const markerPath = join(s.root, '.forge', 'hosted-lane.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  marker.selection.version = s.lane.version;
  marker.selection.sourceVersion = s.lane.sourceVersion;
  writeFileSync(markerPath, JSON.stringify(marker));
  const landed = await run();
  assert.equal(landed.result.phase, 'finish', 'the re-run composes on the current pins and lands');
  // Re-running the same source again replays that new operation.
  assert.equal((await run()).operationId, landed.operationId);
});

for (const code of ['LANDING_CANCELLED', 'REVIEW_DECLINED'])
  test(`48720573: wait after ${code} resubmits unchanged source and replay stays terminal`, async t => {
    const s = agentFixture(t);
    process.env.XDG_STATE_HOME = temporaryDirectory(t, 'forge-stop-resubmit-');
    const exitCode = process.exitCode;
    t.after(() => {
      process.exitCode = exitCode;
    });
    let stderr = '';
    t.mock.method(process.stderr, 'write', text => {
      stderr += String(text);
      return true;
    });
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const objects = join(clientCacheRoot(s.root), 'objects');
    mkdirSync(objects, { recursive: true });
    writeFileSync(join(objects, s.lane.base.head), s.objects.get(s.lane.base.head));
    const land = command => submitHostedLand(s.root, command, s.address, s.transport(), 0, true);
    const message = 'Fix landing guidance';
    // Begin with retry already set so following the same command must distinguish terminal from live.
    const selection = { message, retry: true, reason: 'other' };
    const first = await land(selection);
    const operationId = first.operationId;
    const state = s.operations.get(operationId);
    const stopped = {
      ...state,
      version: state.version + 1,
      phase: 'terminal-failed',
      observation: { state: 'terminal-failed', pendingReason: null, cause: 'rejected' },
      error: { code, message: 'The submission ended.' },
    };
    s.operations.set(operationId, { ...stopped, observation: state.observation });

    stderr = '';
    const replayed = await land({ ...selection, operationId });
    assert.equal(replayed.operationId, operationId);
    assert.equal(replayed.result.terminal, true);
    assert.equal(replayed.result.submission.error.code, code);
    assert.equal(replayed.result.submission.observation.state, 'terminal-failed');
    assert.equal(replayed.result.landingState.state, code === 'LANDING_CANCELLED' ? 'cancelled' : 'rejected');
    assert.equal(replayed.result.inProgress, undefined);
    assert.equal(replayed.result.waitCommand, undefined);
    assert.doesNotMatch(stderr, /work is unfinished|submitting, then it continues/);

    s.operations.set(operationId, stopped);
    stderr = '';
    const waited = await hostedAgentCli(
      s.root,
      'wait',
      { operationIds: [operationId], until: 'acceptance' },
      s.address,
      s.transport(),
    );
    assert.equal(process.exitCode, 2);
    assert.equal(waited.result.status, 'terminal');
    assert.equal(waited.result.submission.error.code, code);
    const printed = / land --save '(.*)'$/m.exec(stderr);
    assert(printed, 'the terminal wait prints a runnable resubmission command');
    const next = JSON.parse(printed[1]);
    assert.deepEqual(next, { after: null, dependencies: [], ...selection });
    assert.deepEqual(waited.result.next, { action: 'finish', ...next });

    const otherRoot = temporaryDirectory(t, 'forge-stop-remote-');
    const elsewhere = await hostedAgentCli(
      otherRoot,
      'wait',
      { operationIds: [operationId], until: 'acceptance' },
      s.address,
      new HostedAgentTransport(otherRoot, s.address, s.exchange),
    );
    assert.equal(elsewhere.result.status, 'terminal');
    assert.equal(elsewhere.result.command, undefined);
    assert.match(
      elsewhere.result.recovery.instruction,
      /Keep the inputs and dependencies, remove operationId/,
    );

    const later = await land(next);
    assert.notEqual(later.operationId, operationId);
    assert.notEqual(later.result.submission.id, first.result.submission.id);
    assert.equal((await land(next)).operationId, later.operationId, 'a live retry reconciles');
  });

// Review of Lane 66778884: the submit-again command after a withdrawn landing must be new work. The
// plain shorthand replays the same operation for unchanged source, so the command keeps retry.
test('593fc2d7: the submit-again command of a withdrawn landing starts a new operation for the same source', async t => {
  const s = agentFixture(t);
  process.env.XDG_STATE_HOME = temporaryDirectory(t, 'forge-resubmit-');
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const objects = join(clientCacheRoot(s.root), 'objects');
  mkdirSync(objects, { recursive: true });
  writeFileSync(join(objects, s.lane.base.head), s.objects.get(s.lane.base.head));
  const first = await s.transport().dispatch('finish', {});
  assert.equal(
    (await s.transport().dispatch('finish', {})).operationId,
    first.operationId,
    'shorthand replays',
  );
  const { action, ...again } = finishResubmitContinuation(s.root, { operationId: first.operationId }).next;
  assert.equal(action, 'finish');
  const resubmitted = await s.transport().dispatch(action, again);
  assert.notEqual(resubmitted.operationId, first.operationId, 'the suggested command is new work');
  // Run again while that new landing is in flight: it replays it, never a second submission.
  assert.equal((await s.transport().dispatch(action, again)).operationId, resubmitted.operationId);
});
