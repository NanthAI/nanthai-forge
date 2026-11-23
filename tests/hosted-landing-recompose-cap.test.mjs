// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Recompose cap (queue invariant S5, incident 5e3c3a3c): after three main-race re-checks an entry is
// raised to urgent and holds strict order while it checks, so older passes that would make its check
// stale wait for it instead of moving main under it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedLandingProgressAt } from '../dist/hosted-landing-stall.js';
import {
  MAIN_RACE_CAP,
  MAIN_RACE_CAP_REASON,
  countMainRace,
  reachesMainRaceCap,
} from '../dist/landing-overtake.js';

const stallAlertApi = await import(moduleUrl('../convex/projectHostedLandingStallAlert.ts'));
const priorityApi = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-recompose-cap',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const full = JSON.stringify({ scope: 'full', tests: [] });
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const row = (f, id) => rows(f).find(r => r.submissionId === id);
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(a => JSON.parse(a.value).check?.runId === run.id)
    ?.submissionId;
// Different, line-clean edits of one shared file: a main race on it needs a re-check.
const shared = {
  baselineFiles: [['src/shared.ts', 'a\nb\nc\n']],
  memberPaths: [
    ['src/a.ts', 'src/shared.ts'],
    ['src/b.ts', 'src/shared.ts'],
  ],
  memberContents: ['A\nb\nc\n', 'a\nb\nC\n'],
  fileCount: 2,
};
async function queue(t, options) {
  const base =
    options.admission === false
      ? { batching: false, requestCheck: true }
      : { batchMaxSize: null, admissionCheck: 'full' };
  const f = await batchesFixture(t, { ...base, ...options, count: 0 });
  f.rawChecks.setPlanSelection(full);
  for (let i = 0; i < 2; i++) await f.add(i);
  return f;
}
/** Runs the queue; `hold(f, run)` keeps a queued run unstarted, `until(f)` stops early. */
async function drive(f, { hold = () => false, until = () => false } = {}) {
  f.landed ??= [];
  const note = () => {
    for (const s of states(f)) if (s.phase === 'landed' && !f.landed.includes(s.id)) f.landed.push(s.id);
  };
  for (let tick = 0; tick < 900 && !until(f); tick++, note()) {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit'))
      if (!hold(f, run)) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(t => !/MainAudit:start/.test(t.name));
    if (!task) return;
    await f.execute(task);
  }
}

test('the cap counts main-race re-checks only and is reached once', () => {
  let count;
  for (const attempt of [{ recheckReason: 'path-overlap' }, {}, { recheckReason: 'not-eligible' }])
    count = countMainRace(count, attempt);
  assert.equal(count, 2, 'a check binding or retry fork (no recheckReason) counts nothing');
  count = countMainRace(count, { recheckReason: 'path-overlap' });
  assert.equal(count, MAIN_RACE_CAP);
  assert.equal(reachesMainRaceCap(2, count), true);
  assert.equal(reachesMainRaceCap(count, count + 1), false, 'only the crossing promotes');
});

test('incident 5e3c3a3c: the third main-race re-check raises the entry to urgent and says why', async t => {
  const f = await queue(t, { ...shared, concurrency: 1 });
  const [, newer] = f.entries.map(e => e.state.id);
  // Two earlier main races already happened to this entry (other Candidates); this one is the third.
  f.patch('projectHostedLandingRequests', row(f, newer)._id, {
    mainRaces: 2,
  });
  let listed = false;
  await drive(f, {
    until: f => {
      const now = Boolean([...f.tables.projectHostedLandingQueues.values()][0].raceCapped?.includes(newer));
      // The list and the urgent priority land in one write, so a claim never sees one without the other.
      if (now && !listed) assert.equal(row(f, newer).priority, 'urgent');
      listed ||= now;
      return false;
    },
  });
  assert(listed, 'the queue lists the capped entry while it is live');
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  const capped = row(f, newer);
  assert.equal(capped.mainRaces, MAIN_RACE_CAP);
  assert.equal(capped.priority, 'urgent');
  assert.equal(capped.priorityReason, MAIN_RACE_CAP_REASON);
  assert.equal(capped.priorityVersion, 1, 'a later owner prioritize must read this version');
  const [queueRow] = f.tables.projectHostedLandingQueues.values();
  assert.equal(queueRow.raceCapped, undefined, 'the queue unlists the capped entry when it ends');
});

test('an owner who set the capped entry back to normal is not raised again', async t => {
  const f = await queue(t, { ...shared, concurrency: 1 });
  const [, newer] = f.entries.map(e => e.state.id);
  f.patch('projectHostedLandingRequests', row(f, newer)._id, {
    mainRaces: MAIN_RACE_CAP,
    priority: 'normal',
    priorityVersion: 2,
  });
  await drive(f);
  const undone = row(f, newer);
  assert.equal(undone.mainRaces, MAIN_RACE_CAP + 1);
  assert.equal(undone.priority, 'normal');
  assert.equal(undone.priorityVersion, 2);
});

/** Queue invariant S6 shape: `id` checks as a group whose predecessor is `on`, so its check needs
 * `on` on main first. The batch row is synthetic; its one member is the entry's own attempt. */
function stackOn(f, id, on) {
  const r = row(f, id);
  const value = JSON.parse(r.value);
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    a => JSON.parse(a.value).id === value.attemptId,
  );
  const batchId = randomUUID();
  // The fixture's own instants: the entry's state time and row creation time.
  const at = value.at;
  f.tables.projectHostedLandingBatches.set(`row-stacked-${batchId}`, {
    _id: `row-stacked-${batchId}`,
    _creationTime: r._creationTime,
    projectId: f.projectId,
    batchId,
    composeOperationId: randomUUID(),
    value: JSON.stringify({
      id: batchId,
      at,
      composeOperationId: randomUUID(),
      checkOperationId: randomUUID(),
      phase: 'checking',
      predecessor: { submissionId: on, head: 'synthetic-head', receiptId: randomUUID() },
      members: [JSON.parse(attempt.value)],
      uploadIndex: 0,
    }),
  });
  f.patch('projectHostedLandingRequests', r._id, { value: JSON.stringify({ ...value, batchId }) });
}

/** Both entries check at once; the newer one is capped (urgent, three races) while its run is held. */
async function cappedWhileChecking(t, options, { demoted = false, stacked = false } = {}) {
  const f = await queue(t, { concurrency: 2, admission: false, ...options });
  const [older, newer] = f.entries.map(e => e.state.id);
  let capped = false;
  await drive(f, {
    // The older run passes only once the newer one is capped, so its claim meets the capped check.
    hold: (f, run) => owner(f, run) === newer || (!capped && owner(f, run) === older),
    until: f => {
      const r = row(f, newer);
      if (!capped && r?.phase === 'checking') {
        f.patch('projectHostedLandingRequests', r._id, {
          priority: demoted ? 'normal' : 'urgent',
          priorityReason: MAIN_RACE_CAP_REASON,
          priorityVersion: 1,
          mainRaces: MAIN_RACE_CAP,
        });
        const [queueRow] = f.tables.projectHostedLandingQueues.values();
        f.patch('projectHostedLandingQueues', queueRow._id, { raceCapped: [newer] });
        if (stacked) stackOn(f, newer, older);
        capped = true;
      }
      return capped && (row(f, older).orderWait === newer || row(f, older).phase === 'landed');
    },
  });
  assert(capped, 'the newer entry reached its check');
  return { f, older, newer };
}

test('an older passed entry whose landing would make the capped check stale waits for it', async t => {
  const { f, older, newer } = await cappedWhileChecking(t, shared);
  const waiting = row(f, older);
  assert.equal(waiting.orderWait, newer, 'the older pass waits for the capped entry');
  assert.equal(waiting.orderWaits?.at(-1)?.held, 'recompose-cap');
  assert.equal(
    waiting.alarm ?? null,
    null,
    'the waiter raises no alarm of its own: the capped check owns progress',
  );
  // Idle while the capped run is held: nothing is scheduled but the stall clock.
  assert.deepEqual(
    f.pending().filter(t => !/MainAudit:start|LandingStall/.test(t.name)),
    [],
    'no work runs while both wait on the capped check',
  );
  await drive(f);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.landed, [newer, older], 'the capped entry lands first');
  assert.equal(row(f, newer).mainRaces, MAIN_RACE_CAP, 'the capped entry did not race main again');
});

test('an older passed entry that is unrelated and carries its proof is not held', async t => {
  const { f, older } = await cappedWhileChecking(t, { memberPaths: ['src/a.ts', 'src/b.ts'], fileCount: 2 });
  assert.equal(row(f, older).phase, 'landed', 'the unrelated pass lands while the capped entry checks');
  assert.equal(row(f, older).orderWait ?? null, null);
});

test('queue invariant S6: an older pass never parks on a capped group whose check stacks on it', async t => {
  const { f, older } = await cappedWhileChecking(t, shared, { stacked: true });
  assert.equal(row(f, older).orderWait ?? null, null, 'the capped group needs it on main first');
  assert.equal(row(f, older).phase, 'landed');
});

test('a capped entry its owner set back to normal no longer holds older passes', async t => {
  const { f, older } = await cappedWhileChecking(t, shared, { demoted: true });
  assert.equal(row(f, older).phase, 'landed');
  assert.equal(row(f, older).orderWait ?? null, null);
});

test("the owner's prioritize normal takes a capped entry off the queue's list", async t => {
  const { f, newer } = await cappedWhileChecking(t, shared);
  const queueRow = () => [...f.tables.projectHostedLandingQueues.values()][0];
  assert.deepEqual(queueRow().raceCapped, [newer]);
  await f.transaction(
    'priorityChange',
    priorityApi.prioritize,
    {
      projectId: f.projectId,
      submissionId: newer,
      operationId: randomUUID(),
      priority: 'normal',
      authorityEpoch: 1,
      expectedVersion: 1,
    },
    'owner',
  );
  assert.equal(row(f, newer).priority, 'normal');
  assert.equal(queueRow().raceCapped, undefined, 'claims read nothing for it any more');
});

// Queue invariants S12/L8 (incident 5e3c3a3c): a stall alerts once, at its root. A follower queued
// behind a stalled predecessor sends no alert of its own; the root's tier 2 counts the queue behind it.
async function stalledPair(t) {
  const f = await queue(t, { ...shared, concurrency: 1, admission: false });
  const { autonomyPolicy: policy } = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      agentDefaults: { ...policy.agentDefaults, stallAlerts: { enabled: true, webhook: 'ntfy' } },
    },
  });
  const [head, follower] = f.entries.map(e => e.state.id);
  // The head's controller is gone at Ready; the follower is queued behind it, and both stall alarms
  // have fired (projectHostedLandingStall.ts writes these observations).
  const stall = (id, step, missingOwner) => {
    const r = row(f, id);
    const value = JSON.parse(r.value);
    const lastProgressAt = hostedLandingProgressAt(value);
    value.observation = {
      ...value.observation,
      state: 'pending',
      stall: {
        code: 'LANDING_STALLED',
        step,
        missingOwner,
        lastProgressAt,
        alarmAt: new Date(Date.parse(lastProgressAt) + 15 * 60_000).toISOString(),
        message: `No landing progress for 15 minutes at ${step}; missing progress from ${missingOwner}.`,
      },
    };
    f.patch('projectHostedLandingRequests', r._id, { value: JSON.stringify(value) });
    return { projectId: f.projectId, submissionId: id, lastProgressAt };
  };
  const alert = (identity, tier) => f.transaction('stallAlert', stallAlertApi.alert, { ...identity, tier });
  const sent = () =>
    [...f.tables.projectHostedStallAlerts.values()].map(r => [
      r.submissionId,
      r.tier,
      JSON.parse(r.value).text,
    ]);
  return { f, head, follower, stall, alert, sent };
}
const alertTasks = f => f.pending().filter(task => task.name === 'projectHostedLandingStallAlert:alert');

test('incident 5e3c3a3c: a stalled head alerts once with its queue; the follower behind it stays quiet', async t => {
  const { f, head, follower, stall, alert, sent } = await stalledPair(t);
  const root = stall(head, 'ready', 'landing / finish controller');
  const behind = stall(follower, 'queued', `predecessor ${head} (ready) / landing controller`);
  const before = alertTasks(f).length;
  assert.equal(await alert(behind, 1), null, 'the follower sends nothing');
  assert.deepEqual(sent(), []);
  assert.equal(alertTasks(f).length, before + 1, 'its tier 2 looks again later, in case it is stuck alone');
  await alert(root, 1);
  assert.deepEqual(
    sent().map(([id, tier]) => [id, tier]),
    [[head, 1]],
  );
  assert.doesNotMatch(sent()[0][2], /queued behind/, 'tier 1 reads nothing extra');
  // Still behind the stalled root at tier 2: still quiet, and nothing more is scheduled for it.
  const scheduled = alertTasks(f).length;
  assert.equal(await alert(behind, 2), null);
  assert.equal(alertTasks(f).length, scheduled);
  assert.deepEqual(
    sent().map(([id]) => id),
    [head],
  );
  await alert(root, 2);
  assert.match(sent()[1][2], /^Still stalled: /);
  assert.match(sent()[1][2], /waiting: this submission and 1 queued behind\./);
});

test('a follower whose tier 1 waited on a stalled predecessor opens with a new-stall page at tier 2', async t => {
  const { f, head, follower, stall, alert, sent } = await stalledPair(t);
  const root = stall(head, 'ready', 'landing / finish controller');
  const behind = stall(follower, 'queued', `predecessor ${head} (ready) / landing controller`);
  assert.equal(await alert(behind, 1), null);
  // The root recovers (its stall clears); the follower is still stuck at the same progress time.
  const r = row(f, head);
  const value = JSON.parse(r.value);
  delete value.observation.stall;
  f.patch('projectHostedLandingRequests', r._id, { value: JSON.stringify(value) });
  void root;
  await alert(behind, 2);
  const [[id, tier, text]] = sent();
  assert.deepEqual([id, tier], [follower, 2]);
  assert.match(text, /^Landing stalled: /, 'no earlier page went out for this stall');
});

test('a follower whose predecessor is not stalled still alerts for its own stall', async t => {
  const { head, follower, stall, alert, sent } = await stalledPair(t);
  const behind = stall(follower, 'queued', `predecessor ${head} (queued) / landing controller`);
  await alert(behind, 1);
  assert.deepEqual(
    sent().map(([id, tier]) => [id, tier]),
    [[follower, 1]],
  );
});
