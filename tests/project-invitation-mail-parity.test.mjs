// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Invitation email enablement gates (Item c6629fda): P1-02 and F-04, a suppressed send (recipient block or removal)
// shows the inviter the same outcome and settles at the same time as a real send; P1-03, inviter and resend limits
// refuse, while the recipient and deployment caps keep the invitation pending with its mail not sent and a blocked
// pair never charges the recipient counter. Review findings F1–F6 of the parity Lane are named per test.
// Synthetic addresses and a stubbed sender only: no email leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { invitationFixture, mail, access, policy, values } from './invitation-fixture.mjs';

const day = 86400000;
const address = 'guest@example.test';
const senderEnv = ['FORGE_ALERT_EMAIL_TOKEN', 'FORGE_ALERT_EMAIL_ACCOUNT_ID'];
const recipientKey = `invitation:recipient-day:${policy.invitationEmailHash(address)}`;
const pairKey = `invitation:suppressed-pair-day:owner:${policy.invitationEmailHash(address)}`;
const counter = (s, owner) => values(s, 'deviceAttempts').find(row => row.owner === owner)?.count;
const operation = (s, operationId) =>
  values(s, 'projectAccessOperations').find(row => row.operationId === operationId);
const snapshot = s =>
  JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));

// One clock, one timeout recorder and one saved environment per test, however many cases the test runs.
// `fixture.now` is the one fixed instant the code under test reads through Date.now.
const fixtureStart = Date.UTC(2026, 10, 10, 12),
  fixture = { now: fixtureStart, budgets: [] },
  clocks = new WeakSet(),
  restored = new WeakSet();
function clock(t) {
  if (!clocks.has(t)) {
    clocks.add(t);
    t.mock.method(Date, 'now', () => fixture.now);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', ms => (fixture.budgets.push(ms), timeout(ms)));
  }
  fixture.now = fixtureStart;
  fixture.budgets = [];
  return fixture;
}
function sender(t, configured) {
  if (!restored.has(t)) {
    restored.add(t);
    const saved = senderEnv.map(name => process.env[name]),
      fetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = fetch;
      senderEnv.forEach((name, i) =>
        saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
      );
    });
  }
  if (configured) {
    process.env.FORGE_ALERT_EMAIL_TOKEN = 'synthetic-token';
    process.env.FORGE_ALERT_EMAIL_ACCOUNT_ID = 'a'.repeat(32);
  } else senderEnv.forEach(name => delete process.env[name]);
}
function seed(s, owner, count) {
  const windowAt = fixture.now - (fixture.now % day),
    row = values(s, 'deviceAttempts').find(value => value.owner === owner);
  if (row) Object.assign(row, { windowAt, count });
  else s.tables.deviceAttempts.set(owner, { _id: owner, _creationTime: 1, owner, windowAt, count });
}
const bind = (s, id, accountKey) =>
  s.tables.users.set(id, {
    _id: id,
    _creationTime: 1,
    accountKey,
    email: address,
    emailVerified: true,
    emailConfirmedAt: fixture.now,
  });
const block = (s, fields) =>
  s.tables.invitationBlocks.set('block', {
    _id: 'block',
    _creationTime: 1,
    recipient: 'guest',
    inviter: 'owner',
    blocked: true,
    version: 1,
    ...fields,
  });

/** Recipient states the inviter must not be able to tell apart, set up from identical counters. */
async function recipientCase(s, kind) {
  // By address (the recipient's digest), or by account only, including an address two accounts share (F5).
  if (kind === 'blocked') block(s, { emailHash: policy.invitationEmailHash(address) });
  if (kind === 'account-blocked' || kind === 'ambiguous-blocked') block(s, {});
  // 'blocked' is by address alone: no account holds the address.
  if (kind !== 'real' && kind !== 'blocked') bind(s, 'recipient', 'guest');
  if (kind.startsWith('ambiguous')) bind(s, 'second', 'other');
  if (kind.endsWith('removed'))
    s.tables.projectContributors.set('member', {
      _id: 'member',
      _creationTime: 1,
      projectId: 'project',
      contributor: 'guest',
    });
  const row = await s.invite();
  if (kind.endsWith('removed')) {
    s.caller('owner');
    await access.setRole._handler(s.ctx, {
      projectId: 'project',
      person: 'guest',
      role: 'none',
      operationId: randomUUID(),
    });
  }
  return row;
}
const suppressedKinds = ['blocked', 'account-blocked', 'ambiguous-blocked', 'removed', 'ambiguous-removed'];

/** What the inviter sees of their own invitation on People and access. */
async function peopleRow(s, operationId) {
  s.caller('owner');
  const invite = values(s, 'projectInvites').find(row => row.operationId === operationId);
  const { invited } = await access.people._handler(s.ctx, { projectId: 'project' });
  // Ids are random per run; every other field the inviter sees is compared.
  const {
    id,
    at,
    expiresAt,
    operationId: _,
    mail: shown,
    ...rest
  } = invited.find(row => row.id === invite._id);
  return { ...rest, mail: { ...shown, at: shown.at - fixtureStart } };
}

/** Runs the queued send with a provider stub; returns provider calls and what the inviter can observe. */
async function deliverQueued(s, task, { latency = 700, response = 200, detailsDelay = 0 } = {}) {
  const requests = [];
  globalThis.fetch = async () => {
    requests.push(1);
    fixture.now += Math.min(latency, fixture.budgets.at(-1));
    if (response === 'throw') throw new TypeError('synthetic network failure');
    return new Response('', { status: response });
  };
  const settles = [];
  const started = fixture.now;
  await mail.deliver._handler(
    {
      runQuery: async (_, args) => {
        fixture.now += detailsDelay;
        return mail.details._handler(s.ctx, args);
      },
      scheduler: { runAfter: async (delay, _, args) => settles.push({ at: fixture.now + delay, args }) },
    },
    task.args,
  );
  assert.equal(settles.length, 1, 'one settlement');
  fixture.now = settles[0].at;
  await mail.settle._handler(s.ctx, settles[0].args);
  return { requests: requests.length, settledAfter: fixture.now - started };
}

async function observe(t, kind, setup = {}) {
  clock(t);
  const s = invitationFixture(t);
  sender(t, setup.configured ?? true);
  const row = await recipientCase(s, kind);
  const sent = await deliverQueued(s, s.scheduled.at(-1), setup);
  return { ...sent, visible: await peopleRow(s, row.operationId) };
}

test('P1-02/F-04 (F2, F4, F5): every suppressed recipient matches a real send in outcome and settle time', async t => {
  for (const setup of [
    { latency: 700 },
    { latency: 4_000 },
    { latency: policy.invitationSendRequestTimeout },
    { response: 502 },
    { response: 401 },
    { response: 'throw' },
    // A slow details read shrinks the provider budget; the settlement time stays fixed.
    { detailsDelay: 3_000, latency: policy.invitationSendRequestTimeout },
    { detailsDelay: 9_500 },
    { configured: false },
  ]) {
    const real = await observe(t, 'real', setup);
    const reachesSender = (setup.configured ?? true) && (setup.detailsDelay ?? 0) < 9_000;
    assert.equal(
      real.requests,
      reachesSender ? 1 : 0,
      `the real send reaches the stub (${JSON.stringify(setup)})`,
    );
    assert.equal(real.settledAfter, policy.invitationSettleDelay);
    assert.equal(real.visible.mail.status, (setup.configured ?? true) ? 'sent' : 'off');
    for (const kind of suppressedKinds) {
      const hidden = await observe(t, kind, setup);
      assert.equal(hidden.requests, 0, `${kind}: no request reaches the sender`);
      assert.equal(hidden.settledAfter, real.settledAfter, `${kind}: same settle time`);
      assert.deepEqual(
        hidden.visible,
        real.visible,
        `${kind} matches a real send (${JSON.stringify(setup)})`,
      );
    }
  }
  // The provider never runs past the settle deadline.
  assert.ok(policy.invitationSendRequestTimeout < policy.invitationSettleDelay);
});

test('P1-02 (F6): suppressed resends make no provider request and match a real resend on People', async t => {
  const seen = [];
  for (const kind of ['real', ...suppressedKinds]) {
    clock(t);
    const s = invitationFixture(t);
    sender(t, true);
    const row = await recipientCase(s, kind);
    await mail.settle._handler(s.ctx, { projectId: 'project', operationId: row.operationId, status: 'sent' });
    s.caller('owner');
    const resendId = randomUUID();
    await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId });
    const sent = await deliverQueued(s, s.scheduled.at(-1), { latency: 300 });
    assert.equal(sent.requests, kind === 'real' ? 1 : 0, `${kind}: provider requests`);
    seen.push({ settledAfter: sent.settledAfter, visible: await peopleRow(s, row.operationId) });
  }
  for (const value of seen.slice(1)) assert.deepEqual(value, seen[0]);
  assert.equal(seen[0].visible.mail.sends, 2);
  assert.equal(seen[0].settledAfter, policy.invitationSettleDelay);
});

test('P1-03 (F1): from identical counters a blocked inviter meets the recipient cap at the same send', async t => {
  const sequences = {};
  for (const kind of ['real', 'blocked', 'account-blocked', 'ambiguous-blocked']) {
    clock(t);
    const s = invitationFixture(t);
    sender(t, true);
    if (kind !== 'real') await recipientCase(s, kind).then(() => s.tables.deviceAttempts.clear());
    const shown = [];
    for (let i = 0; i < 4; i++) {
      const operationId = randomUUID();
      await s.invite(address, { operationId });
      const { status, code } = (await peopleRow(s, operationId)).mail;
      shown.push([status, code]);
    }
    sequences[kind] = shown;
    if (kind === 'real') assert.equal(counter(s, recipientKey), 3);
    else {
      assert.equal(counter(s, recipientKey), undefined, `${kind}: never charged to the recipient`);
      assert.equal(counter(s, pairKey), 3, `${kind}: charged to its own pair counter`);
    }
  }
  assert.deepEqual(sequences.real.at(-1), ['failed', policy.invitationMailLimit]);
  for (const kind of Object.keys(sequences)) assert.deepEqual(sequences[kind], sequences.real, kind);
});

test('P1-03 (F3): delivery honours the queue-time suppression and a later block, so the cap cannot be bypassed', async t => {
  for (const change of ['unblocked after queue', 'blocked after queue']) {
    clock(t);
    const s = invitationFixture(t);
    sender(t, true);
    if (change === 'unblocked after queue') block(s, { emailHash: policy.invitationEmailHash(address) });
    await s.invite();
    const task = s.scheduled.at(-1);
    assert.equal(task.args.queuedSuppressed, change === 'unblocked after queue' ? true : undefined);
    if (change === 'unblocked after queue') s.tables.invitationBlocks.get('block').blocked = false;
    else block(s, { emailHash: policy.invitationEmailHash(address) });
    const sent = await deliverQueued(s, task);
    assert.equal(sent.requests, 0, `${change}: no email without its recipient charge`);
    assert.equal(counter(s, recipientKey), change === 'unblocked after queue' ? undefined : 1);
  }
});

for (const [name, key, cap] of [
  ['deployment', 'invitation:deployment-day', 500],
  ['recipient', recipientKey, 3],
])
  test(`P1-03: at the ${name} cap the invitation stays pending with mail not sent; retries change nothing`, async t => {
    clock(t);
    const s = invitationFixture(t);
    seed(s, key, cap);
    const operationId = randomUUID();
    await s.invite(address, { operationId });
    const row = values(s, 'projectInvites').find(value => value.operationId === operationId);
    assert.equal(policy.invitationStatus(row), 'pending');
    assert.deepEqual(
      (({ status, sends, code }) => ({ status, sends, code }))(operation(s, operationId).mail),
      { status: 'failed', sends: 0, code: policy.invitationMailLimit },
    );
    assert.equal(s.scheduled.length, 0, 'no send is queued');
    assert.equal(counter(s, key), cap, 'the reached cap is not charged');
    for (const other of ['invitation:deployment-day', recipientKey, pairKey].filter(value => value !== key))
      assert.equal(counter(s, other), undefined, 'a held send charges no email cap');
    assert.equal(counter(s, 'invitation:inviter-hour:owner'), 1, 'the inviter allowance is charged');
    const before = snapshot(s);
    await s.invite(address, { operationId });
    assert.equal(snapshot(s), before, 'an exact retry writes nothing');
    assert.equal(s.scheduled.length, 0);
    // After the UTC day ends, an explicit resend sends.
    values(s, 'deviceAttempts').find(value => value.owner === key).windowAt -= day;
    s.caller('owner');
    await mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId: randomUUID() });
    assert.equal(operation(s, operationId).mail.status, 'sending');
    assert.equal(s.scheduled.length, 1);
  });

test('P1-03: a resend at an email cap keeps the invitation and sends nothing; its retry is free', async t => {
  clock(t);
  const s = invitationFixture(t),
    row = await s.invite();
  await mail.settle._handler(s.ctx, { projectId: 'project', operationId: row.operationId, status: 'sent' });
  seed(s, 'invitation:deployment-day', 500);
  const tasks = s.scheduled.length,
    resendId = randomUUID();
  await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId });
  const held = operation(s, row.operationId).mail;
  assert.deepEqual([held.status, held.sends, held.code], ['failed', 1, policy.invitationMailLimit]);
  assert.equal(s.scheduled.length, tasks);
  assert.equal(policy.invitationStatus(values(s, 'projectInvites').find(v => v._id === row._id)), 'pending');
  const before = snapshot(s);
  await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId });
  assert.equal(snapshot(s), before);
});

test('P1-03: a blocked pair at a recipient cap others filled is held like anyone else', async t => {
  clock(t);
  const s = invitationFixture(t);
  block(s, { emailHash: policy.invitationEmailHash(address) });
  seed(s, recipientKey, 3);
  const operationId = randomUUID();
  await s.invite(address, { operationId });
  assert.equal(operation(s, operationId).mail.code, policy.invitationMailLimit);
  assert.equal(counter(s, recipientKey), 3);
  assert.equal(counter(s, pairKey), undefined);
});
