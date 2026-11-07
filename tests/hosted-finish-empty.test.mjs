// SPDX-License-Identifier: Apache-2.0
// Incident a930de4c (2026-11-07): `land --save` with a Lane id from a folder that was not the Lane's
// checkout landed the server-recorded head (== base), reported LANDED and left five edits unsaved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { recordLane } from '../dist/lane-registry.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { landSummary } from '../dist/hosted-land-summary.js';
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
  const state = mkdtempSync(join(tmpdir(), 'forge-empty-land-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
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
    const state = mkdtempSync(join(tmpdir(), 'forge-empty-rerun-'));
    t.after(() => rmSync(state, { recursive: true, force: true }));
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
