// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0f76b07e: after a sync conflict turns a Lane folder into its resolution Lane in place,
// commands that still name the original Lane follow the resolution Lane instead of refusing
// (HOSTED_CHECKOUT_REQUIRED, RESOLUTION_REQUIRED, LANDING_NOT_LIVE) or burning an operation id.
// Frictions 1088a357, 3f60d17a, 9bc3775b, 19b765fe, b2d84b25, b5e8e2d5. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { followResolutionLane, laneCheckoutRoot, laneSuccessor } from '../dist/hosted-lane-location.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { forgetLane, readLaneEntry, recordLane } from '../dist/lane-registry.js';
import { inPlaceResolution, rememberConflictPaths } from '../dist/hosted-conflict-precheck.js';
import { withCheckoutWritePass } from '../dist/checkout-materialization.js';

const quiet = async run => {
  const notes = [],
    write = process.stderr.write;
  process.stderr.write = line => (notes.push(String(line)), true);
  try {
    return { value: await run(), notes: notes.join('') };
  } finally {
    process.stderr.write = write;
  }
};

/** A Lane whose sync conflicted, its folder now the resolution Lane, markers edited away. */
async function editedResolution(t) {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport().dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  assert.equal(readHostedLaneCheckout(s.root).selection.laneId, conflict.laneId);
  writeFileSync(join(s.root, 'a.txt'), 'chosen\nb\nc\n');
  return { s, f, origin: f.lane.laneId, resolution: conflict.laneId };
}

const landed = async (f, submissionId) => {
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submissionId)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
};

for (const named of ['origin', 'none'])
  test(`1088a357: land --save with a fresh operationId (laneId ${named}) runs the retained resolve and lands under that id`, async t => {
    const { s, f, origin, resolution } = await editedResolution(t);
    const operationId = randomUUID();
    const command = {
      ...(named === 'origin' ? { laneId: origin } : {}),
      operationId,
      message: 'fix: keep both',
      notVerified: [],
    };
    const { value: submitted, notes } = await quiet(() =>
      submitHostedLand(s.root, command, s.address, s.transport()),
    );
    assert.match(notes, /saved your edited conflict files as the resolution of Lane/);
    assert.equal(submitted.operationId, operationId, 'the caller chose this landing id');
    await landed(f, submitted.result.submission.id);
    assert.equal((await f.readLane(resolution)).state, 'completed');
    assert.equal((await f.readLane(origin)).state, 'completed');
  });

test('3f60d17a: a refused finish naming the origin gives its operationId back for the corrected land', async t => {
  const { s, f, origin, resolution } = await editedResolution(t);
  const operationId = randomUUID();
  await assert.rejects(s.transport().dispatch('finish', { laneId: origin, operationId }), {
    code: 'RESOLUTION_REQUIRED',
  });
  // The same id, now naming the resolution Lane, is new work, not WORK_OPERATION_CHANGED.
  const { value: submitted } = await quiet(() =>
    submitHostedLand(
      s.root,
      { laneId: resolution, operationId, message: 'fix', notVerified: [] },
      s.address,
      s.transport(),
    ),
  );
  assert.equal(submitted.operationId, operationId);
  await landed(f, submitted.result.submission.id);
});

test('b2d84b25: save naming the origin from its in-place resolution folder saves the resolution Lane', async t => {
  const { s, origin, resolution } = await editedResolution(t);
  const { value: saved, notes } = await quiet(() => s.transport().dispatch('save', { laneId: origin }));
  assert.match(notes, new RegExp(`continues as resolution Lane ${resolution}`));
  assert.equal(saved.result.outcome.status, 'completed');
  assert.equal(saved.result.outcome.result.laneId, resolution);
});

test('9bc3775b: preflight, resolve and status naming the origin follow its in-place resolution Lane', async t => {
  const { s, origin, resolution } = await editedResolution(t);
  const { value: planned, notes } = await quiet(() =>
    s.transport().dispatch('preflight', { laneId: origin, run: false }),
  );
  assert.match(notes, new RegExp(`preflight runs on ${resolution}`));
  assert.ok(planned.result);
  const status = await s.transport().dispatch('status', { laneId: origin });
  assert.equal(status.result.continuesAs?.laneId, resolution);
  const { value: resolved } = await quiet(() => s.transport().dispatch('resolve', { laneId: origin }));
  assert.equal(resolved.result.next.action, 'finish');
  assert.equal(resolved.result.next.laneId ?? resolution, resolution);
});

test('19b765fe: withdraw naming the origin withdraws the landing of its resolution Lane; a lost reply retries unchanged', async t => {
  const { s, f, origin, resolution } = await editedResolution(t);
  const { value: submitted } = await quiet(() =>
    submitHostedLand(s.root, { laneId: origin, message: 'fix', notVerified: [] }, s.address, s.transport()),
  );
  await f.drain();
  const command = { laneId: origin, reason: 'wrong fix', operationId: randomUUID() };
  const { value: withdrawn, notes } = await quiet(() => s.transport().dispatch('withdraw', command));
  assert.match(notes, new RegExp(`withdraw runs on ${resolution}`));
  assert.equal(withdrawn.result.withdrawn, true);
  assert.equal(withdrawn.result.submissionId, submitted.result.submission.id);
  assert.equal(withdrawn.result.landing.error.message, 'wrong fix');
  // The reply was lost: the same command again, old id and all, replays the followed operation.
  const { value: retried } = await quiet(() => s.transport().dispatch('withdraw', command));
  assert.equal(retried.operationId, command.operationId);
  assert.equal(retried.result.submissionId, submitted.result.submission.id);
});

test('3f60d17a: a released id another request took is not replayed for the original auto-addressed request', async t => {
  const { s, origin, resolution } = await editedResolution(t);
  const journal = (command, operationId) =>
    new HostedAgentJournal(s.root, s.address, 'actor', 'finish', command, operationId);
  const first = journal({ laneId: origin });
  first.release('finish-work-started');
  journal({ laneId: resolution }, first.operationId); // the corrected land under the same id
  const again = journal({ laneId: origin });
  assert.notEqual(again.operationId, first.operationId, 'a new id, not WORK_OPERATION_CHANGED');
  // An operation whose hosted work began never gives its id back.
  const started = journal({ laneId: randomUUID() });
  await started.retain('finish-work-started', () => true);
  started.release('finish-work-started');
  assert.throws(() => journal({ laneId: resolution }, started.operationId), {
    code: 'WORK_OPERATION_CHANGED',
  });
});

test('b5e8e2d5: from the project folder, the first Lane of a two-hop chain finds the live resolution Lane', async t => {
  const previous = process.env.XDG_STATE_HOME,
    state = mkdtempSync(join(tmpdir(), 'forge-registry-'));
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = state;
  const { s, f, origin, resolution } = await editedResolution(t);
  assert.equal(readLaneEntry(resolution)?.resolutionOf, origin);
  // What a second in-place resolution leaves: the middle Lane's entry is gone once the next one took
  // its folder. Here the live resolution plays the last hop, so A -> middle -> live.
  const middle = randomUUID();
  recordLane({ laneId: middle, root: s.root, ...s.address, resolutionOf: origin });
  forgetLane(middle);
  recordLane({ laneId: resolution, resolutionOf: middle });
  const folder = join(s.root, '..', 'project-folder');
  mkdirSync(folder, { recursive: true });
  const live = readLaneEntry(resolution).root;
  assert.equal(realpathSync(live), realpathSync(s.root));
  assert.deepEqual(laneSuccessor({ root: folder, address: s.address }, origin), {
    laneId: resolution,
    root: live,
  });
  for (const action of ['save', 'preflight', 'finish', 'withdraw'])
    assert.equal(laneCheckoutRoot(folder, action, origin, s.address), live, action);
  // withdraw from the project folder runs in that folder (the CLI moves there) and follows.
  const { value: submitted } = await quiet(() =>
    submitHostedLand(
      s.root,
      { laneId: resolution, message: 'fix', notVerified: [] },
      s.address,
      s.transport(),
    ),
  );
  await f.drain();
  const { value: withdrawn } = await quiet(() =>
    s.transport().dispatch('withdraw', { laneId: middle, reason: 'chain' }),
  );
  assert.equal(withdrawn.result.submissionId, submitted.result.submission.id);
});

test('9bc3775b: a peer wait on the origin waits on its resolution Lane; a retained replay keeps its request', async t => {
  const { s, origin, resolution } = await editedResolution(t);
  const session = () => ({ root: s.root, address: s.address });
  const { value: followed } = await quiet(() => followResolutionLane(session, 'wait', { peer: origin }));
  assert.equal(followed.peer, resolution);
  // Another Lane id, or a command already running as its own Lane, is unchanged.
  const other = { laneId: randomUUID() };
  assert.equal(followResolutionLane(session, 'save', other), other);
  const own = { laneId: resolution };
  assert.equal(followResolutionLane(session, 'save', own), own);
  // A landing command is not rewritten here: land follows the resolution itself.
  const land = { laneId: origin };
  assert.equal(followResolutionLane(session, 'finish', land), land);
});

test('b5e8e2d5: a folder resolved in place twice still matches the first Lane of the chain', async t => {
  const { s, origin, resolution } = await editedResolution(t);
  // A second conflict in the same folder made a resolution of the resolution: its record names the
  // first resolution as origin and keeps the first Lane in the chain.
  const second = randomUUID();
  rememberConflictPaths(s.root, second, ['a.txt'], undefined, false, resolution);
  assert.equal(inPlaceResolution(s.root, resolution)?.laneId, second);
  assert.equal(inPlaceResolution(s.root, origin), undefined, 'a direct match stays direct');
  assert.equal(inPlaceResolution(s.root, origin, true)?.laneId, second);
});

test(
  'b2d84b25: resolve installs its header-only State without queueing behind another checkout write pass',
  { timeout: 10_000 },
  async t => {
    const { s, resolution } = await editedResolution(t);
    // Another checkout on this device holds the single write pass for as long as it likes.
    let release;
    const held = new Promise(resolve => (release = resolve));
    // A regression fails on the test timeout instead of hanging the run.
    t.signal.addEventListener('abort', () => release());
    let entered;
    const entry = new Promise(resolve => (entered = resolve));
    const holder = withCheckoutWritePass(s.root, async () => {
      entered();
      await held;
    });
    await entry;
    try {
      const { value: resolved } = await quiet(() =>
        s.transport().dispatch('resolve', { laneId: resolution }),
      );
      assert.equal(resolved.result.next.action, 'finish', 'resolve finished while the pass was held');
    } finally {
      release();
      await holder;
    }
  },
);

/** A landing conflict made the folder its resolution Lane; the edit and a new file are resolved. */
async function resolvedLandingConflict(t) {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const conflicted = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  const resolution = readHostedLaneCheckout(s.root).selection.laneId;
  assert.notEqual(resolution, f.lane.laneId);
  writeFileSync(join(s.root, 'a.txt'), 'chosen\nb\nc\n');
  writeFileSync(join(s.root, 'extra.txt'), 'newer saved work\n');
  const resolved = await s.transport().dispatch('resolve', { laneId: resolution });
  assert.equal(resolved.result.next.action, 'finish');
  assert.equal(conflicted.result.phase, 'conflict');
  return { s, f, origin: f.lane.laneId, resolution };
}

test('7351b8d7: a finish naming the origin after its resolve completed lands the resolution, not the old save', async t => {
  const { s, f, origin, resolution } = await resolvedLandingConflict(t);
  // A new landing of the origin (direct or MCP finish, fresh operationId); no id would replay the
  // original conflicted operation and return its receipt.
  const submitted = await s.transport().dispatch('finish', { laneId: origin, operationId: randomUUID() });
  assert.equal(submitted.result.phase, 'finish', 'no second conflict');
  await landed(f, submitted.result.submission.id);
  assert.equal(f.text(f.currentMain().head, 'extra.txt'), 'newer saved work\n');
  assert.equal((await f.readLane(resolution)).state, 'completed');
  assert.equal((await f.readLane(origin)).state, 'completed');
});

test('7351b8d7: a conflict of an older save of the origin never rebases the resolved folder over newer saves', async t => {
  const { s, f, origin, resolution } = await resolvedLandingConflict(t);
  const lane = await f.readLane(origin);
  // Landing the origin's pre-resolution head by exact pins conflicts again; its recovery runs here.
  const stale = await s.transport().dispatch('finish', {
    inputs: [
      {
        laneId: origin,
        expected: {
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
        },
      },
    ],
  });
  assert.equal(stale.result.phase, 'conflict');
  assert.equal(readHostedLaneCheckout(s.root).selection.laneId, resolution, 'the folder keeps its Lane');
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  assert.equal(readFileSync(join(s.root, 'extra.txt'), 'utf8'), 'newer saved work\n');
});
