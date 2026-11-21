// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const api = await import(moduleUrl('../convex/projectSessions.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const peer = 'user_PEERACCOUNT01';
const now = 1_800_000_000_000;

test('session pages disclose public handles and device codes but device names follow the one owner policy', async () => {
  const f = await saveFixture();
  f.insert('forgeAccounts', { owner: peer, handle: 'peer-builder' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: peer });
  const deviceId = randomUUID();
  f.insert('cliCredentials', {
    owner: peer,
    credentialId: deviceId,
    deviceCode: 'dv-synthetic',
    deviceApprovedAt: 1,
    name: 'Current private label',
    scope: 'cli',
    issuedAt: 1,
    expiresAt: 2,
    tokenHash: 'synthetic',
    revoked: false,
  });
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
      device: { id: deviceId, code: 'dv-synthetic', approvedAt: 1, owner: peer, name: 'Stale private label' },
    },
  });
  const read = actor =>
    f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null }, actor).then(JSON.parse);
  const minePage = await read(peer),
    otherPage = await read('owner');
  const mine = { rows: minePage.rows.filter(r => r.device) },
    other = { rows: otherPage.rows.filter(r => r.device) };
  assert.equal(mine.rows[0].device.name, 'Current private label');
  assert.equal(other.rows[0].device.name, undefined);
  assert.equal(other.rows[0].device.code, 'dv-synthetic');
  assert.equal(other.rows[0].device.owner, undefined);
  assert.equal(other.rows[0].person, 'peer-builder');
  assert.doesNotMatch(JSON.stringify(other), /user_PEERACCOUNT01|private label/i);
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
        at: now - i,
      });
    const result = JSON.parse(
      await f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null, observedAt: now }),
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
    for (let i = 0; i < 25 * scale; i++)
      f.insert('teams', { owner: 'owner', name: `Team ${i}`, operationId: randomUUID() });
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
        at: now - i,
      });
    const result = JSON.parse(
      await f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null, observedAt: now }),
    );
    assert.equal(result.rows.length, 25);
    assert.equal(result.isDone, false);
    assert(result.rows.every(row => /^builder-/.test(row.person)));
    const count = f.counts.at(-1);
    assert(count.documents <= 55);
    assert.equal(count.writeBytes, 0);
    console.log(
      JSON.stringify({
        scale,
        people: 400 * scale,
        teams: 25 * scale,
        devices: 1200 * scale,
        sessions: 300 * scale,
        ...count,
      }),
    );
  }
});

test('every public session-snapshot projection applies device-name policy, including nested saved JSON', async () => {
  const people = await import(moduleUrl('../convex/publicPeople.ts'));
  const f = await saveFixture();
  f.insert('forgeAccounts', { owner: 'peer', handle: 'peer-builder' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'peer' });
  const source = {
    session: {
      sessionId: 'a'.repeat(64),
      device: {
        id: randomUUID(),
        code: 'dv-synthetic',
        approvedAt: 1,
        owner: 'owner',
        name: 'Owner-private label',
      },
    },
  };
  const read = (actor, value) =>
    f.transaction(
      'snapshot projection',
      { _handler: ctx => people.publicPeople(ctx, { projectId: f.projectId }, value) },
      {},
      actor,
    );
  for (const value of [source, JSON.stringify(source)]) {
    const mine = await read('owner', value),
      peer = await read('peer', value);
    assert(JSON.stringify(mine).includes('Owner-private label'));
    assert(!JSON.stringify(peer).includes('Owner-private label'));
    assert(JSON.stringify(peer).includes('dv-synthetic'));
  }
  assert.equal(
    source.session.device.name,
    'Owner-private label',
    'public projection never mutates the retained snapshot',
  );
});

test('saved session identity never carries the account-owned private device label', async () => {
  const { sessionIdentity } = await import(moduleUrl('../convex/projectSessionIdentity.ts'));
  const snapshot = sessionIdentity('a'.repeat(64), { app: 'synthetic', identityFrom: 'declared' }, 1, {
    credentialId: randomUUID(),
    deviceCode: 'dv-synthetic',
    deviceApprovedAt: 1,
    owner: peer,
    name: 'Private label',
  });
  assert.equal(snapshot.device.name, undefined);
  assert.equal(snapshot.device.owner, peer);
  assert.doesNotMatch(JSON.stringify(snapshot), /Private label/);
});

test('own device labels are deduplicated and bounded at current and doubled organisation scale', async () => {
  for (const scale of [1, 2]) {
    const f = await saveFixture();
    for (let i = 0; i < 1200 * scale; i++) {
      const id = randomUUID();
      f.insert('cliCredentials', {
        owner: 'owner',
        credentialId: id,
        deviceCode: `dv-${i}`,
        deviceApprovedAt: 1,
        name: 'Private current label',
        scope: 'cli',
        issuedAt: 1,
        expiresAt: 2,
        tokenHash: 'synthetic',
        revoked: false,
      });
      if (i < 300 * scale)
        f.insert('projectHostedPresence', {
          projectId: f.projectId,
          laneId: randomUUID(),
          intentId: randomUUID(),
          actor: 'owner',
          agent: `session-${i}`,
          goal: 'Synthetic work',
          paths: [],
          pathCount: 0,
          at: now - i,
          session: {
            sessionId: String(i).padStart(64, '0'),
            startedAt: 1,
            device: { id, code: `dv-${i}`, approvedAt: 1, owner: 'owner' },
          },
        });
    }
    const page = JSON.parse(
      await f.transaction('sessions', api.read, { projectId: f.projectId, cursor: null, observedAt: now }),
    );
    assert.equal(page.rows.length, 25);
    assert(page.rows.every(row => row.device.name === 'Private current label'));
    const count = f.counts.at(-1);
    assert.equal(count.readDocumentsByTable.cliCredentials, 25);
    assert(count.documents <= 55);
    assert.equal(count.writes, 0);
    console.log(
      JSON.stringify({
        ownDeviceLabels: true,
        scale,
        ranges: count.ranges,
        documents: count.documents,
        readBytes: count.readBytes,
      }),
    );
  }
});

test('name, person, app and device filters apply on later pages, and quiet observations belong in Activity', async () => {
  const f = await saveFixture();
  f.insert('forgeAccounts', { owner: peer, handle: 'peer-builder' });
  f.insert('accountHandles', { owner: peer, handle: 'peer-builder' });
  const device = { id: randomUUID(), code: 'dv-target', approvedAt: 1, owner: peer };
  for (let i = 0; i < 60; i++) {
    const matched = (i >= 25 && i < 34) || i === 59;
    f.insert('projectHostedPresence', {
      projectId: f.projectId,
      laneId: randomUUID(),
      intentId: randomUUID(),
      actor: matched ? peer : 'owner',
      agent: matched ? `target-${i}` : 'other',
      goal: 'Synthetic work',
      paths: [],
      pathCount: 0,
      at: i === 59 ? now - 30 * 60_000 : now - i,
      session: { sessionId: randomUUID().replaceAll('-', '').repeat(2), startedAt: 1, app: 'codex', device },
    });
  }
  const read = (cursor, activity = false, filters = { find: 'TARGET' }) =>
    f
      .transaction('filtered sessions', api.read, {
        projectId: f.projectId,
        cursor,
        observedAt: now,
        filters,
        activity,
      })
      .then(JSON.parse);
  const first = await read(null);
  assert.deepEqual(first.rows, []);
  assert.equal(first.isDone, false);
  const second = await read(first.continueCursor);
  assert.deepEqual(
    second.rows.map(row => row.name).sort(),
    Array.from({ length: 9 }, (_, i) => `target-${25 + i}`),
  );
  const third = await read(second.continueCursor);
  assert.deepEqual(third.rows, []);
  assert.equal(third.isDone, true);
  const history = await read(null, true);
  assert.deepEqual(
    history.rows.map(row => row.name),
    ['target-59'],
  );
  const scoped = await read(null, false, {
    find: 'target',
    person: 'peer-builder',
    app: 'codex',
    device: 'dv-target',
    deviceId: device.id,
  });
  assert.deepEqual(
    scoped.rows.map(row => row.name),
    second.rows.map(row => row.name),
  );
  assert.equal(scoped.isDone, true);
  assert.deepEqual((await read(null, false, { device: 'dv-target', deviceId: randomUUID() })).rows, []);
  for (const count of f.counts.filter(count => count.name === 'filtered sessions')) {
    assert((count.readDocumentsByTable.projectHostedPresence ?? 0) <= 25);
    assert((count.readBytesByTable.projectHostedPresence ?? 0) <= 64 * 1024);
    assert.equal(count.writes, 0);
  }
});

test('a split required by the presence scan budget returns a continuation even when the page is empty', async () => {
  const f = await saveFixture();
  const original = api.read._handler;
  const budgetSplit = {
    page: [],
    continueCursor: 'end-of-requested-range',
    isDone: true,
    pageStatus: 'SplitRequired',
    splitCursor: 'end-of-scanned-range',
  };
  const reply = await f.transaction(
    'split presence',
    {
      _handler: (ctx, args) =>
        original(
          {
            ...ctx,
            db: new Proxy(ctx.db, {
              get(db, key) {
                if (key !== 'query') return Reflect.get(db, key);
                return table => {
                  const query = db.query(table);
                  if (table === 'projectHostedPresence')
                    query.paginate = async options => {
                      assert.equal(options.maximumRowsRead, 100);
                      assert.equal(options.maximumBytesRead, 64 * 1024);
                      return budgetSplit;
                    };
                  return query;
                };
              },
            }),
          },
          args,
        ),
    },
    { projectId: f.projectId, cursor: null, observedAt: now },
  );
  assert.equal(JSON.parse(reply).continueCursor, budgetSplit.splitCursor);
  assert.equal(JSON.parse(reply).isDone, false);
});
