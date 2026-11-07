// SPDX-License-Identifier: Apache-2.0
// Regression ladder rung 1 (45f49fb7): a sustained jump in a landing's own time to main or
// check minutes over the 7-day median alerts the owner the same day, on data the landing
// already wrote. Replays the B1.5d n3-r3 a1 slowdown (4432 s against a ~1500 s norm).
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import {
  LANDING_SPEED_BASELINE,
  landingSpeedAlertMessage,
  landingSpeedSample,
  observeLandingSpeed,
} from '../dist/landing-speed-alerts.js';

const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const day = 86_400_000,
  noon = Date.parse('2026-11-04T12:00:00.000Z'),
  today = noon - (noon % day);
/** Ten quiet days of 25-minute landings with 3-minute checks. */
function baseline(days = 7, perDay = 3, toMain = 25, check = 3) {
  const samples = [];
  for (let d = days; d >= 1; d--)
    for (let n = 0; n < perDay; n++) samples.push([today - d * day + n * 3_600_000, toMain, check]);
  return { schema: 1, samples, alerted: {} };
}
const land = (state, at, toMain, check = 3) => observeLandingSpeed(state, { at, toMain, check });

test('incident replay n3-r3 a1: three slow landings in a day alert once on time to main, naming the next step', () => {
  let state = baseline();
  // n3-r3 a1: 4432 s (74 min) against the normal ~1500 s (25 min) pace.
  const first = land(state, noon, 74);
  assert.deepEqual(first.alerts, [], 'one slow landing is not sustained');
  const second = land(first.state, noon + 60_000, 74);
  assert.deepEqual(second.alerts, [], 'two of three is not yet a full sustained window');
  const third = land(second.state, noon + 120_000, 74);
  assert.equal(third.alerts.length, 1);
  const [alert] = third.alerts;
  assert.deepEqual(alert, {
    metric: 'toMain',
    baselineMinutes: 25,
    baselineLandings: 21,
    currentMinutes: 74,
    thresholdMinutes: 37.5,
  });
  const message = landingSpeedAlertMessage(alert, 'forge');
  assert.match(message.subject, /^\[Forge\] Landing time to main regressed: forge$/);
  assert.match(message.text, /7-day median 25 min over 21 landings; alert threshold 37.5 min/);
  assert.match(message.text, /\nNext: run `nforge metrics ROOT --text`/);
  // Same day: never again for this metric.
  state = third.state;
  for (let n = 0; n < 5; n++) {
    const next = land(state, noon + (3 + n) * 60_000, 90);
    assert.deepEqual(next.alerts, []);
    state = next.state;
  }
  // Next day the jump still holds: one fresh alert.
  let tomorrow = state;
  const alerts = [];
  for (let n = 0; n < 3; n++) {
    const next = land(tomorrow, noon + day + n * 60_000, 90);
    alerts.push(...next.alerts);
    tomorrow = next.state;
  }
  assert.deepEqual(
    alerts.map(a => a.metric),
    ['toMain'],
  );
});

test('a single outlier, normal noise and a project with no baseline never alert', () => {
  // One outlier among normal landings: the median of the last three stays normal.
  let state = baseline();
  for (const [n, minutes] of [26, 120, 24, 27].entries()) {
    const next = land(state, noon + n * 60_000, minutes);
    assert.deepEqual(next.alerts, [], `landing ${n}`);
    state = next.state;
  }
  // Just under the threshold (25 * 1.5 = 37.5) does not alert.
  state = baseline();
  for (let n = 0; n < 3; n++) {
    const next = land(state, noon + n * 60_000, 37.5);
    assert.deepEqual(next.alerts, []);
    state = next.state;
  }
  // Fewer than minBaselineSamples prior landings: no baseline, no alert.
  state = baseline(3, 3);
  assert(state.samples.length < LANDING_SPEED_BASELINE.minBaselineSamples);
  for (let n = 0; n < 3; n++) {
    const next = land(state, noon + n * 60_000, 500);
    assert.deepEqual(next.alerts, []);
    state = next.state;
  }
});

test('check minutes alert on their own floor; samples older than 7 days and over the cap are dropped', () => {
  // 3-minute checks: x1.5 is 4.5 min, so the +2 min floor (5 min) is the threshold.
  let state = baseline(),
    raised = [];
  for (let n = 0; n < 3; n++) {
    const next = land(state, noon + n * 60_000, 25, 5);
    raised.push(...next.alerts);
    state = next.state;
  }
  assert.deepEqual(raised, [], 'at the floor is not over it');
  for (let n = 3; n < 6; n++) {
    const next = land(state, noon + n * 60_000, 25, 9);
    raised.push(...next.alerts);
    state = next.state;
  }
  assert.deepEqual(
    raised.map(a => [a.metric, a.thresholdMinutes, a.currentMinutes]),
    [['check', 5, 9]],
  );
  const old = baseline(10, 3);
  const trimmed = land(old, noon, 25).state;
  assert(trimmed.samples.every(([at]) => at >= today - 7 * day));
  const crowded = {
    schema: 1,
    samples: Array.from({ length: 450 }, (_, n) => [noon - n * 1000, 1, 1]),
    alerted: {},
  };
  assert.equal(land(crowded, noon + 1, 1).state.samples.length, LANDING_SPEED_BASELINE.maxSamples);
  assert(Buffer.byteLength(JSON.stringify(land(crowded, noon + 1, 1).state)) < 16_000, 'row stays small');
});

test('samples come from the landed state only; missing stamps leave a metric unknown', () => {
  const state = {
    timing: {
      submittedAt: '2026-11-04T10:00:00.000Z',
      checkReservedAt: '2026-11-04T10:05:00.000Z',
      ciEndedAt: '2026-11-04T10:08:30.000Z',
      committedAt: '2026-11-04T10:12:00.000Z',
    },
  };
  assert.deepEqual(landingSpeedSample(state), {
    at: Date.parse('2026-11-04T10:12:00.000Z'),
    toMain: 12,
    check: 3.5,
  });
  assert.deepEqual(landingSpeedSample({ timing: { ...state.timing, ciEndedAt: undefined } }).check, null);
  assert.equal(landingSpeedSample({}), null);
});

/** Seeds today's slow landings and the baseline relative to the landing's own clock. */
async function seededLanding(t, stallAlerts) {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...(policy ?? policyPreset('trusted')), agentDefaults: { stallAlerts } },
  });
  // Committed stamps use the wall clock (new Date()), not the fixture's fake Date.now.
  const wall = new Date().getTime(),
    start = wall - (wall % day);
  const seed = baseline();
  seed.samples = seed.samples.map(([at, toMain, check]) => [at - today + start, toMain, check]);
  // Two slow landings earlier today; whatever this landing takes, the median of three is slow.
  seed.samples.push([wall - 2, 120, 3], [wall - 1, 120, 3]);
  await f.tx('seedLandingSpeed', {
    _handler: ctx =>
      ctx.db.insert('projectLandingSpeed', { projectId: f.projectId, value: JSON.stringify(seed) }),
  });
  const before = f.counts.length;
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = [...f.tables.projectHostedLandingRequests.values()].map(row => JSON.parse(row.value));
  assert.deepEqual(
    landed.map(s => s.phase),
    ['landed'],
  );
  return { f, before };
}

test('a landing that makes the jump sustained alerts the owner through the stall-alert channel, with no new call', async t => {
  const { f, before } = await seededLanding(t, { enabled: true, webhook: 'ntfy' });
  // The fixture's fake clock also jumps past the stall-alert tiers; those have their own tests.
  const deliveries = f.metrics.stallDeliveries.filter(d => /regressed/.test(d.subject));
  assert.equal(deliveries.length, 1, 'one alert, on the existing delivery action');
  assert.match(deliveries[0].subject, /^\[Forge\] Landing time to main regressed: /);
  assert.match(deliveries[0].text, /Next: /);
  assert.equal(JSON.parse(deliveries[0].settings).webhook, 'ntfy');
  const [row] = f.tables.projectLandingSpeed.values();
  const stored = JSON.parse(row.value);
  assert.equal(stored.samples.length, 21 + 3);
  assert.equal(stored.alerted.toMain, new Date().toISOString().slice(0, 10));
  // Rung 1 runs inside the landing's own mutations: no Convex function of its own.
  assert(!f.counts.slice(before).some(c => /landingSpeed/i.test(c.name)), 'no new Convex call');
  assert.equal(f.pending().length, 0, 'idle afterwards: nothing left scheduled');
});

test('alerts off: the sample is still kept, nothing is sent', async t => {
  const { f } = await seededLanding(t, { enabled: false });
  assert.equal(f.metrics.stallDeliveries.length, 0, 'no delivery of any kind');
  const [row] = f.tables.projectLandingSpeed.values();
  assert.equal(JSON.parse(row.value).samples.length, 24);
});
