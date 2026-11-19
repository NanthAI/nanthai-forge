// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
const work = f => f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name));
// `seed(f, ids)` may reshape rows once every follower is parked, before the head passes.
export async function parkedIncident(t, { seed } = {}) {
  const f = await batchesFixture(t, {
    count: 6,
    fileCount: 2,
    batching: false,
    requestCheck: true,
    memberPaths: [
      'src/shared.ts',
      'src/shared.ts',
      ...Array.from({ length: 4 }, (_, i) => `src/independent-${i}.ts`),
    ],
    baselineFiles: [['src/shared.ts', 'export const a = 0;\n// gap\nexport const b = 0;\n']],
    memberContents: [
      'export const a = 1;\n// gap\nexport const b = 0;\n',
      'export const a = 0;\n// gap\nexport const b = 1;\n',
    ],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const [head, holder, ...followers] = f.entries.map(e => e.state.id);
  // First time each follower is ready (its check passed), on the fixture's simulated clock.
  const readyAt = {};
  const noteReady = () => {
    for (const s of states(f))
      if (followers.includes(s.id) && readyAt[s.id] == null && s.phase === 'ready')
        readyAt[s.id] = Date.now();
  };
  let headRun;
  for (let tick = 0; tick < 250; tick++) {
    const a = rows(f).find(r => r.submissionId === holder);
    if (a) f.patch('projectHostedLandingRequests', a._id, { unsealed: 'not-eligible' });
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      const active = await f.rawChecks.activate(run.id);
      if (owner(f, run) === head) headRun = active;
      else await f.rawChecks.pass(active);
    }
    noteReady();
    if (followers.every(id => rows(f).find(r => r.submissionId === id)?.orderWait === holder)) break;
    const task = work(f);
    if (!task) break;
    await f.execute(task);
  }
  noteReady();
  assert(headRun);
  assert.equal(rows(f).find(r => r.submissionId === holder).orderWait, head);
  for (const id of followers) {
    const row = rows(f).find(r => r.submissionId === id);
    assert.equal(row.orderWait, holder);
    // The old code has no alarm here; the invariant inspector reports L1.
  }
  await seed?.(f, { head, holder, followers });
  await f.rawChecks.pass(headRun);
  let holderRechecked = false,
    waiterReclaimed = false;
  for (let tick = 0; tick < 350; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      if (owner(f, run) === holder) {
        holderRechecked = true;
        continue;
      }
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    noteReady();
    // The holder's re-check run is bound; stop once it is checking that run (the new-run wake).
    if (holderRechecked && rows(f).find(r => r.submissionId === holder).phase === 'checking') {
      const oldest = rows(f).find(r => r.submissionId === followers[0]);
      waiterReclaimed = oldest.orderWait !== holder && Boolean(oldest.alarm);
      break;
    }
    if (followers.every(id => states(f).find(s => s.id === id).phase === 'landed')) break;
    const task = work(f);
    if (!task) break;
    await f.execute(task);
  }
  assert(holderRechecked);
  return { f, followers, holder, head, waiterReclaimed, readyAt };
}

/** Guard 2 (2873b486): the most a passed follower may wait, in simulated minutes, while the holder
 * it is parked behind starts a new check. Before N1 each one waited out that whole re-check. */
export const FOLLOWER_CEILING_MINUTES = 5;
/** Followers over the ceiling, or never landed. */
export const overCeiling = ({ passToLand }) =>
  Object.entries(passToLand)
    .filter(([, minutes]) => minutes == null || minutes > FOLLOWER_CEILING_MINUTES)
    .map(([id, minutes]) => ({ id, minutes }));

/** Runs the parked incident on until every follower lands while the holder's re-check takes
 * `holderCheckMs` of simulated time (every other check passes at once). Returns each follower's
 * minutes from its first passed check to its landing (null: never landed) and the holder's. */
export async function followerPassToLand(t, { holderCheckMs = 30 * 60_000 } = {}) {
  const incident = await parkedIncident(t);
  const { f, followers, holder, readyAt } = incident;
  const landedAt = {};
  let release = null,
    holderRun = null,
    holderLandedAt = null;
  for (let tick = 0; tick < 600; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      const active = await f.rawChecks.activate(run.id);
      if (owner(f, run) === holder && release == null) {
        holderRun = active;
        release = Date.now() + holderCheckMs;
      } else await f.rawChecks.pass(active);
    }
    if (holderRun && Date.now() >= release) {
      await f.rawChecks.pass(holderRun);
      holderRun = null;
    }
    for (const s of states(f)) {
      if (followers.includes(s.id)) {
        if (readyAt[s.id] == null && s.phase === 'ready') readyAt[s.id] = Date.now();
        if (landedAt[s.id] == null && s.phase === 'landed') landedAt[s.id] = Date.now();
      }
      if (s.id === holder && s.phase === 'landed' && holderLandedAt == null) holderLandedAt = Date.now();
    }
    if (followers.every(id => landedAt[id] != null) && holderLandedAt != null) break;
    const task = work(f);
    if (task) await f.execute(task);
    else if (holderRun) f.advanceClock(Math.max(1, release - Date.now()));
    else break;
  }
  const minutes = (from, to) => (from == null || to == null ? null : Math.max(0, to - from) / 60_000);
  return {
    ...incident,
    holderCheckMinutes: holderCheckMs / 60_000,
    passToLand: Object.fromEntries(followers.map(id => [id, minutes(readyAt[id], landedAt[id])])),
    holderLanded: holderLandedAt != null,
  };
}
