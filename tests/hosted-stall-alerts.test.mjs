// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired, landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { deliverStallAlert, stallAlert, stallAlertRequests } from '../dist/stall-alerts.js';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';

const stallAlertApi = await import(moduleUrl('../convex/projectHostedLandingStallAlert.ts'));
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

// Fake secrets: distinctive strings that must never reach text, receipts, rows or logs.
const SECRET_URL = 'https://ntfy.sh/forge-secret-topic-7f3a';
const SECRET_TOKEN = 'cf-token-SECRET-91b2';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const env = {
  FORGE_ALERT_WEBHOOK_URL: SECRET_URL,
  FORGE_ALERT_EMAIL_TOKEN: SECRET_TOKEN,
  FORGE_ALERT_EMAIL_ACCOUNT_ID: ACCOUNT,
};
const secrets = [SECRET_URL, 'forge-secret-topic', SECRET_TOKEN, ACCOUNT];
const noSecrets = (value, where) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert(!text.includes(secret), `${where} carries no secret`);
};
const request = f => ({
  operationId: randomUUID(),
  authorityEpoch: 1,
  composeOperationId: f.selection.request.operationId,
  after: null,
  check: f.request().check,
});
const setAlerts = (f, stallAlerts) => {
  const project = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId);
  const policy = project.autonomyPolicy ?? policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, agentDefaults: { ...policy.agentDefaults, stallAlerts } },
  });
};
const alertTasks = f => f.pending().filter(task => task.name.startsWith('projectHostedLandingStallAlert:'));
const submission = async (f, operationId) => {
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.operationId === operationId);
  return row ? JSON.parse(row.value) : null;
};

/** 2026-10-30 18:35-21:05: every check result upload was refused (HTTP 403), so a landing sat in
 * checking with its runner gone and nobody looked for hours. */
async function stalledCheck(t, stallAlerts) {
  const f = await finishFixture(t),
    command = request(f);
  if (stallAlerts) setAlerts(f, stallAlerts);
  await f
    .tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) })
    .then(JSON.parse);
  // Source job done, the goal is admitted and its check is queued.
  for (let n = 0; !f.tables.projectHostedCheckRuns.size; n++) {
    assert(n < 30, 'check run created');
    await f.execute();
  }
  const run = [...f.tables.projectHostedCheckRuns.values()][0];
  // The runner starts; its result upload is then refused, so nothing more is recorded.
  const active = await f.rawChecks.activate(JSON.parse(run.value).id);
  return { f, command, active };
}

test('incident replay 2026-10-30 403 stall: tier 1 at 15 min and tier 2 at 30 min fire once each, with no secrets', async t => {
  const { f, command } = await stalledCheck(t, { email: ['owner@example.com'], webhook: 'ntfy' });
  const calls = f.counts.length;
  await f.drain();
  const state = await submission(f, command.operationId);
  assert.equal(state.phase, 'checking');
  assert.equal(state.observation.state, 'pending');
  const alerts = [...f.tables.projectHostedStallAlerts.values()].sort((a, b) => a.tier - b.tier);
  assert.deepEqual(
    alerts.map(row => row.tier),
    [1, 2],
    'each tier fires exactly once',
  );
  const [first, second] = alerts.map(row => JSON.parse(row.value));
  assert.match(first.text, /^Landing stalled: .* min without progress at checking\./);
  assert.match(first.text, /\nWhy: .+/);
  assert.match(first.text, /\nAlready tried: stall alarm re-woke the landing queue at 15 min/);
  assert.match(
    first.text,
    new RegExp(`Repair: nforge agent ROOT landing '\\{"operationId":"${command.operationId}"\\}'`),
  );
  assert.doesNotMatch(first.text, /Diagnosis/);
  assert.match(second.text, /^Still stalled: /);
  assert.match(second.text, /\nDiagnosis: dead step checking; last progress .*; error .*; waiting: /);
  assert.match(second.subject, /^\[Forge\] Still stalled: /);
  // Delivery requests: one per tier, settings carry recipients and preset but never a secret.
  assert.equal(f.metrics.stallDeliveries.length, 2);
  for (const delivery of f.metrics.stallDeliveries) noSecrets(delivery, 'delivery task');
  noSecrets([...f.tables.projectHostedStallAlerts.values()], 'alert rows');
  noSecrets(state, 'landing receipt');
  const status = await f.tx('landingStatus', landingApi.status, {
    projectId: f.projectId,
    submissionId: state.id,
  });
  noSecrets(status, 'status read');
  // The stuck agent reads the latest alert on its status read; the landing state is never rewritten.
  assert.deepEqual(JSON.parse(status).stallAlert, { tier: 2, text: second.text, at: second.at });
  // Each tier is one mutation; nothing is left scheduled for the alerts.
  assert.equal(alertTasks(f).length, 0);
  const alertCalls = f.counts.slice(calls).filter(c => c.name === 'stallAlert').length;
  assert.equal(alertCalls, 2);
  // Replays are no-ops: the same tier never fires twice for the same stall.
  for (const tier of [1, 2])
    assert.equal(
      await f.tx('stallAlert', stallAlertApi.alert, {
        projectId: f.projectId,
        submissionId: state.id,
        lastProgressAt: state.observation.stall.lastProgressAt,
        tier,
      }),
      null,
    );
  assert.equal(f.tables.projectHostedStallAlerts.size, 2);
  assert.equal(f.metrics.stallDeliveries.length, 2);
  t.diagnostic(
    JSON.stringify({ alertMutations: alertCalls, deliveries: 2, idleScheduled: alertTasks(f).length }),
  );
});

test('progress stops tier 2: its pending alert is a one-read no-op', async t => {
  const { f, command, active } = await stalledCheck(t, { email: ['owner@example.com'] });
  // Run until the tier-1 alert is the next task, then make progress.
  for (let n = 0; f.pending()[0]?.name !== 'projectHostedLandingStallAlert:alert'; n++) {
    assert(n < 30);
    await f.execute();
  }
  const state = await submission(f, command.operationId);
  const task = f.pending()[0];
  assert.equal(task.args[0].lastProgressAt, state.observation.stall.lastProgressAt);
  // Some later progress moves the stall clock: the pending alert finds a different stall.
  await f.execute(task);
  assert.equal(f.tables.projectHostedStallAlerts.size, 1);
  assert.equal(
    await f.tx('stallAlert', stallAlertApi.alert, {
      ...task.args[0],
      lastProgressAt: new Date(0).toISOString(),
    }),
    null,
    'a stale stall identity sends nothing',
  );
  await f.rawChecks.pass(active);
  await f.drain();
  const landed = await submission(f, command.operationId);
  assert.equal(landed.phase, 'landed');
  assert.equal(f.tables.projectHostedStallAlerts.size, 1, 'tier 2 found progress and sent nothing');
  assert.equal(f.metrics.stallDeliveries.length, 1);
  assert.equal(f.pending().length, 0, 'idle afterwards');
});

test('stallAlerts off schedules nothing beyond the existing alarm', async t => {
  const { f } = await stalledCheck(t, { enabled: false });
  await f.drain();
  assert.equal(f.tables.projectHostedStallAlerts?.size ?? 0, 0);
  assert.equal(f.metrics.stallDeliveries.length, 0);
  assert(!f.counts.some(c => c.name === 'stallAlert'), 'zero alert calls');
});

const state = (overrides = {}) => ({
  id: 'submission-1',
  operationId: 'op-1',
  actor: 'agent-a',
  phase: 'checking',
  at: '2026-10-30T18:35:00.000Z',
  sequence: 4,
  version: 3,
  timing: { submittedAt: '2026-10-30T18:30:00.000Z', ciEndedAt: '2026-10-30T18:40:00.000Z' },
  error: { code: 'CHECK_RESULT_REFUSED', message: 'result upload refused: HTTP 403' },
  observation: {
    state: 'pending',
    stall: {
      step: 'checking',
      lastProgressAt: '2026-10-30T18:40:00.000Z',
      missingOwner: 'check runner',
      message: 'No landing progress for 15 minutes at checking.',
    },
  },
  ...overrides,
});

test('alert text: what, why, tried, repair; tier 2 diagnoses a finished runner with no result', () => {
  const now = Date.parse('2026-10-30T19:10:00.000Z');
  const one = stallAlert(state(), 1, { project: 'forge', now });
  assert.match(one.text, /forge, submission submission-1 by agent-a, 30 min without progress at checking/);
  assert.match(one.text, /If check runner is down, fix that first/);
  const two = stallAlert(state({ supersedes: 'submission-0', retryReason: 'failed' }), 2, {
    project: 'forge',
    queuedBehind: 3,
    now,
  });
  assert.match(two.text, /resubmission of submission-0 \(failed\)/);
  assert.match(two.text, /runner finished at 2026-10-30T18:40:00.000Z but no result was recorded/);
  assert.match(two.text, /error CHECK_RESULT_REFUSED: result upload refused: HTTP 403/);
  assert.match(two.text, /waiting: agent-a and 3 queued behind/);
});

test('providers: email per recipient and each webhook preset; secrets stay in URL and headers, out of bodies and logs', async () => {
  const alert = { subject: '[Forge] Landing stalled: forge checking', text: 'Landing stalled: forge' };
  const settings = (overrides = {}) =>
    effectiveAgentDefaults({ stallAlerts: { email: ['a@example.com', 'b@example.com'], ...overrides } })
      .stallAlerts;
  const requests = stallAlertRequests(alert, settings({ webhook: 'slack' }), env);
  assert.deepEqual(
    requests.map(r => r.channel),
    ['email', 'email', 'webhook'],
  );
  const email = requests[0];
  assert.equal(email.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`);
  assert.equal(email.init.headers.authorization, `Bearer ${SECRET_TOKEN}`);
  assert.deepEqual(JSON.parse(email.init.body), {
    from: 'support@nanthai.tech',
    to: 'a@example.com',
    subject: alert.subject,
    text: alert.text,
  });
  for (const request of requests) noSecrets(request.init.body, `${request.channel} body`);
  assert.equal(requests[2].url, SECRET_URL);
  const bodies = {};
  for (const preset of ['ntfy', 'slack', 'discord', 'telegram', 'generic']) {
    const [webhook] = stallAlertRequests(alert, settings({ webhook: preset, email: [] }), env);
    bodies[preset] = webhook.init.body;
  }
  assert.equal(bodies.ntfy, alert.text);
  assert.match(JSON.parse(bodies.slack).text, /^\*\[Forge\]/);
  assert.match(JSON.parse(bodies.discord).content, /^\*\*\[Forge\]/);
  assert.match(JSON.parse(bodies.telegram).text, /^\[Forge\]/);
  assert.deepEqual(JSON.parse(bodies.generic), alert);
  // Missing or unsafe configuration sends nothing.
  assert.deepEqual(stallAlertRequests(alert, settings({ webhook: 'ntfy' }), {}), []);
  assert.deepEqual(
    stallAlertRequests(alert, settings({ webhook: 'ntfy', email: [] }), {
      FORGE_ALERT_WEBHOOK_URL: 'http://plain.example/topic',
    }),
    [],
  );
  assert.deepEqual(stallAlertRequests(alert, settings({ webhook: 'off' }), env).length, 2);
  // Delivery reports channel and status only, also when the provider fails.
  const sent = [];
  const results = await deliverStallAlert(alert, settings({ webhook: 'ntfy' }), env, async (url, init) => {
    sent.push(url);
    if (url === SECRET_URL) throw new Error(`connect failed ${SECRET_URL}`);
    return new Response(null, { status: 202 });
  });
  assert.deepEqual(results, [
    { channel: 'email', status: 202 },
    { channel: 'email', status: 202 },
    { channel: 'webhook', status: 'failed' },
  ]);
  noSecrets(results, 'delivery log');
  assert.equal(sent.length, 3);
});

test('stall alerts ride the 15-minute alarm: thresholds stay at or after it', () => {
  const defaults = effectiveAgentDefaults(undefined).stallAlerts;
  assert(defaults.notifyAfterMinutes * 60_000 >= LANDING_STALL_MS);
  assert(defaults.repeatAfterMinutes > defaults.notifyAfterMinutes);
});
