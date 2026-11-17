// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const api = await import(moduleUrl('../convex/projectSessions.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const peer = 'user_PEERACCOUNT01';

test('session pages disclose public handles and device codes but device names follow the one owner policy', async () => {
  const f = await saveFixture();
  f.insert('forgeAccounts', { owner: peer, handle: 'peer-builder' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: peer });
  f.insert('projectHostedPresence', {
    projectId: f.projectId,
    laneId: randomUUID(),
    intentId: randomUUID(),
    actor: peer,
    agent: 'amber-fox',
    goal: 'Synthetic work',
    paths: [],
    pathCount: 0,
    at: Date.now(),
    session: {
      sessionId: 'a'.repeat(64),
      startedAt: 1,
      app: 'synthetic-app',
      identityFrom: 'declared',
      device: { id: randomUUID(), code: 'dv-synthetic', approvedAt: 1, owner: peer, name: 'Private label' },
    },
  });
  const read = actor =>
    f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null }, actor).then(JSON.parse);
  const minePage = await read(peer),
    otherPage = await read('owner');
  const mine = { rows: minePage.rows.filter(r => r.device) },
    other = { rows: otherPage.rows.filter(r => r.device) };
  assert.equal(mine.rows[0].device.name, 'Private label');
  assert.equal(other.rows[0].device.name, undefined);
  assert.equal(other.rows[0].device.code, 'dv-synthetic');
  assert.equal(other.rows[0].device.owner, undefined);
  assert.equal(other.rows[0].person, 'peer-builder');
  assert.doesNotMatch(JSON.stringify(other), /user_PEERACCOUNT01|Private label/);
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  await assert.rejects(read('public-guest'), code('PROJECT_UNAVAILABLE'));
  f.patch(
    'projectContributors',
    [...f.tables.projectContributors.values()].find(r => r.contributor === peer)._id,
    { contributor: 'removed' },
  );
  await assert.rejects(read(peer), code('PROJECT_UNAVAILABLE'));
});

test('presence stays a bounded page at current and doubled session scale and missing provenance stays unknown', async () => {
  for (const total of [300, 600]) {
    const f = await saveFixture();
    for (let i = 0; i < total; i++)
      f.insert('projectHostedPresence', {
        projectId: f.projectId,
        laneId: randomUUID(),
        intentId: randomUUID(),
        actor: 'owner',
        agent: `session-${i}`,
        goal: 'Synthetic work',
        paths: [],
        pathCount: 0,
        at: i,
      });
    const result = JSON.parse(
      await f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null }),
    );
    assert(result.rows.length <= 25);
    assert.equal(result.isDone, false);
    assert(
      result.rows.every(
        r => r.device === null && r.sessionId === null && r.app === null && r.startedAt === null,
      ),
    );
    const count = f.counts.at(-1);
    assert(count.documents <= 30);
    console.log(
      JSON.stringify({
        sessions: total,
        ranges: count.ranges,
        documents: count.documents,
        readBytes: count.readBytes,
        writeBytes: count.writeBytes,
      }),
    );
  }
});

test('public source replies omit holder provenance while current project writers retain it', async () => {
  const people = await import(moduleUrl('../convex/publicPeople.ts'));
  const f = await saveFixture();
  const result = {
    lane: {
      holder: { actor: 'owner', agent: 'amber-fox', sessionId: 'a'.repeat(64), since: 1, lastSeen: 2 },
    },
  };
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  const map = actor =>
    f.transaction(
      'provenance',
      { _handler: ctx => people.publicPeople(ctx, { projectId: f.projectId }, result) },
      {},
      actor,
    );
  const guest = await map('public-guest');
  assert.equal(guest.lane.holder, undefined);
  assert.equal((await map('owner')).lane.holder.agent, 'amber-fox');
});

test('session projection at current and doubled organisation scale reads one bounded page including distinct people', async () => {
  for (const scale of [1, 2]) {
    const f = await saveFixture();
    for (let i = 0; i < 400 * scale; i++)
      f.insert('forgeAccounts', { owner: `person-${i}`, handle: `builder-${i}` });
    for (let i = 0; i < 1200 * scale; i++)
      f.insert('cliCredentials', {
        owner: `person-${i % (400 * scale)}`,
        credentialId: randomUUID(),
        name: 'Synthetic device',
        scope: 'cli',
        issuedAt: 1,
        expiresAt: 2,
        tokenHash: 'synthetic',
        revoked: false,
      });
    for (let i = 0; i < 300 * scale; i++)
      f.insert('projectHostedPresence', {
        projectId: f.projectId,
        laneId: randomUUID(),
        intentId: randomUUID(),
        actor: `person-${i % (400 * scale)}`,
        agent: `session-${i}`,
        goal: 'Synthetic work',
        paths: [],
        pathCount: 0,
        at: i,
      });
    const result = JSON.parse(
      await f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null }),
    );
    assert.equal(result.rows.length, 25);
    assert.equal(result.isDone, false);
    assert(result.rows.every(row => /^builder-/.test(row.person)));
    const count = f.counts.at(-1);
    assert(count.documents <= 55);
    assert.equal(count.writeBytes, 0);
    console.log(
      JSON.stringify({ scale, people: 400 * scale, devices: 1200 * scale, sessions: 300 * scale, ...count }),
    );
  }
});
