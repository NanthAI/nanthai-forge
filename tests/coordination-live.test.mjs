import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { dispatchCoordination } from '../dist/coordination-client.js';
import { CoordinationSession } from '../dist/coordination-session.js';
import { COORDINATION_TOUCH_INTERVAL_MS } from '../dist/coordination-types.js';
import { pathsOverlap } from '../dist/coordination-paths.js';
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const reads = await import(moduleUrl('../convex/projectCoordinationReads.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const exchange = await import(moduleUrl('../convex/projectExchange.ts'));
const modules = { projectCoordination: coordination, projectCoordinationReads: reads };

const activity = (sessionId, extra = {}) => ({
  kind: 'activity',
  sessionId,
  sequence: extra.sequence ?? 1,
  name: extra.name ?? 'Agent',
  environment: 'fixture',
  status: 'working',
  summary: 'Working',
  context: extra.context ?? {},
});
function fixture() {
  const f = state([]);
  f.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    revision: 42,
    currentBackup: null,
  });
  f.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'other' });
  const run = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return modules[module][name]._handler(f.ctx, args);
  };
  const as = (caller, input) => {
    f.caller(caller);
    return dispatchCoordination({ query: run, mutation: run }, 'project', input);
  };
  return { ...f, as };
}
const announce = async (f, caller, sessionId, extra) =>
  f.as(caller, { action: 'publish', operationId: randomUUID(), command: activity(sessionId, extra) });

test('input limits refuse oversized new writes and page sizes but stored rows still replay', async () => {
  const f = fixture(),
    a = randomUUID();
  await assert.rejects(announce(f, 'owner', a, { name: 'x'.repeat(121) }), /size limits/);
  await assert.rejects(f.as('owner', { action: 'message', text: 'x'.repeat(4001) }), /size limits/);
  await assert.rejects(
    f.as('owner', { action: 'claim', paths: Array.from({ length: 101 }, (_, i) => `p${i}`) }),
    /size limits/,
  );
  await assert.rejects(f.as('owner', { action: 'feed', pageSize: 101 }), /size limits/);
  f.caller('owner');
  await assert.rejects(
    coordination.feed._handler(f.ctx, {
      projectId: 'project',
      paginationOpts: { cursor: null, numItems: 500 },
    }),
    /page size/,
  );
  // A row stored before limits existed reconciles on replay instead of failing validation.
  const operationId = randomUUID(),
    legacy = { kind: 'message', text: 'y'.repeat(5000), context: {} };
  f.tables.projectCoordinationEvents.set('legacy', {
    _id: 'legacy',
    _creationTime: 1,
    projectId: 'project',
    operationId,
    actor: 'owner',
    at: 1,
    command: legacy,
  });
  const replay = await coordination.publish._handler(f.ctx, {
    projectId: 'project',
    operationId,
    command: legacy,
  });
  assert.equal(replay._id, 'legacy');
});

test('touch updates only last-seen on your own session, is rate limited and adds no feed event', async () => {
  const f = fixture(),
    a = randomUUID();
  await assert.rejects(f.as('owner', { action: 'touch', sessionId: a }), /Announce this session/);
  await announce(f, 'owner', a);
  const events = f.tables.projectCoordinationEvents.size;
  assert.equal((await f.as('owner', { action: 'touch', sessionId: a })).touched, false);
  const row = [...f.tables.projectCoordinationSessions.values()][0];
  row.lastSeen -= 16 * 60_000;
  row.lastActivity = row.lastSeen;
  assert.equal((await f.as('owner', { action: 'sessions' })).page[0].stale, true);
  const touched = await f.as('owner', { action: 'touch', sessionId: a });
  assert.equal(touched.touched, true);
  assert.equal(row.sequence, 1);
  assert.equal(f.tables.projectCoordinationEvents.size, events);
  assert.equal((await f.as('owner', { action: 'sessions' })).page[0].stale, true);
  await f.as('owner', { action: 'touch', sessionId: a, activityKind: 'MCP call' });
  assert.equal((await f.as('owner', { action: 'sessions' })).page[0].stale, false);
  await assert.rejects(f.as('other', { action: 'touch', sessionId: a }), /another principal/);
  await assert.rejects(
    f.as('other', { action: 'touch', sessionId: a, activityKind: 'MCP call' }),
    /another principal/,
  );
  await assert.rejects(f.as('outsider', { action: 'touch', sessionId: a }), /unavailable/);
});

test('inbox addresses participants and sessions; acks are per recipient and cannot be read or made by others', async () => {
  const f = fixture(),
    mine = randomUUID(),
    theirs = randomUUID();
  await announce(f, 'owner', mine);
  await announce(f, 'other', theirs);
  const direct = await f.as('other', {
    action: 'message',
    to: 'owner',
    text: 'API changes',
    sessionId: theirs,
  });
  const toSession = await f.as('other', { action: 'message', to: mine, text: 'For your session' });
  const broadcast = await f.as('owner', { action: 'message', text: 'Everyone: freeze docs/' });
  await assert.rejects(f.as('owner', { action: 'message', to: 'stranger', text: 'x' }), /Select a session/);

  let inbox = await f.as('owner', { action: 'inbox' });
  assert.deepEqual(
    inbox.items.map(x => [x.id, x.acked]),
    [
      [direct.operationId, false],
      [toSession.operationId, false],
    ],
  );
  assert.deepEqual(
    (await f.as('other', { action: 'unacked' })).items.map(x => x.id),
    [broadcast.operationId],
  );
  // Another participant sees none of my inbox and cannot select my session or ack my messages.
  assert.equal((await f.as('other', { action: 'inbox' })).items.length, 0);
  await assert.rejects(f.as('other', { action: 'inbox', sessionId: mine }), /your own sessions/);
  await assert.rejects(f.as('other', { action: 'unacked', sessionId: mine }), /your own sessions/);
  await assert.rejects(f.as('other', { action: 'ack', messageId: direct.operationId }), /recipient/);
  await assert.rejects(
    f.as('other', { action: 'ack', messageId: toSession.operationId, sessionId: theirs }),
    /recipient/,
  );
  await assert.rejects(f.as('outsider', { action: 'inbox' }), /unavailable/);
  // The account owner can acknowledge messages to any of their own sessions.
  await f.as('owner', { action: 'ack', messageId: toSession.operationId });
  await f.as('owner', { action: 'ack', messageId: toSession.operationId, sessionId: mine });
  await f.as('owner', { action: 'ack', messageId: direct.operationId });
  inbox = await f.as('owner', { action: 'inbox' });
  assert.deepEqual(
    inbox.items.map(x => x.acked),
    [true, true],
  );
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
  // Broadcast receipts are per participant.
  await f.as('other', { action: 'ack', messageId: broadcast.operationId });
  assert.equal((await f.as('other', { action: 'unacked' })).items.length, 0);
  assert.equal(f.tables.projectCoordinationReceipts.size, 3);
  // Resuming from the inbox cursor returns only newer rows.
  const later = await f.as('other', {
    action: 'handoff',
    to: 'owner',
    summary: 'Finish tests',
    head: 'a'.repeat(64),
  });
  const resumed = await f.as('owner', { action: 'inbox', cursor: inbox.cursor });
  assert.deepEqual(
    resumed.items.map(x => [x.id, x.kind, x.head]),
    [[later.operationId, 'handoff', 'a'.repeat(64)]],
  );
  await f.as('owner', { action: 'ack', messageId: later.operationId, text: 'Taking it' });
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
  assert.equal(f.tables.hostedProjects.get('project').revision, 42);
});

test('claims report overlaps by others, renew, release and expire without locking anything', async () => {
  const f = fixture(),
    a = randomUUID();
  await announce(f, 'owner', a);
  const first = await f.as('owner', { action: 'claim', paths: ['src/api/'], laneId: 'lane-a', sessionId: a });
  assert.deepEqual(first.overlaps, []);
  const second = await f.as('other', {
    action: 'claim',
    paths: ['src/api/user.ts', 'docs/x.md'],
    ttlMinutes: 5,
  });
  assert.deepEqual(
    second.overlaps.map(x => [x.claimId, x.overlapping]),
    [[first.claimId, ['src/api/user.ts']]],
  );
  assert.equal((await f.as('owner', { action: 'overlaps', paths: ['docs'] })).overlaps.length, 1);
  assert.equal((await f.as('owner', { action: 'claims' })).claims.length, 2);
  await assert.rejects(f.as('other', { action: 'release', claimId: first.claimId }), /your own claims/);
  await assert.rejects(
    f.as('other', { action: 'claim', claimId: first.claimId, paths: ['x'] }),
    /your own unreleased claims/,
  );
  await f.as('owner', { action: 'claim', claimId: first.claimId, paths: ['src/web/'] });
  assert.equal((await f.as('other', { action: 'overlaps', paths: ['src/api/user.ts'] })).overlaps.length, 0);
  await f.as('owner', { action: 'release', claimId: first.claimId });
  assert.equal((await f.as('other', { action: 'overlaps', paths: ['src/web/a.ts'] })).overlaps.length, 0);
  f.tables.projectCoordinationClaims.forEach(row => {
    row.expiresAt = Date.now() - 1;
  });
  assert.equal((await f.as('owner', { action: 'claims' })).claims.length, 0);
  const kinds = [...f.tables.projectCoordinationEvents.values()].map(x => x.kind);
  assert.deepEqual(kinds, ['activity', 'claim', 'claim', 'claim', 'release']);
  assert.ok(pathsOverlap('./src/', 'src/a.ts') && !pathsOverlap('src/ab', 'src/a'));
});

test('MCP session keeps sequences increasing, heartbeats until stopped and stops on failure', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const touched = [];
  let fail = false;
  const session = new CoordinationSession(async id => {
    touched.push(id);
    if (fail) throw new Error('expired');
  });
  t.after(() => session.stop());
  assert.equal(session.announced, undefined);
  const one = session.next(),
    two = session.next();
  assert.equal(one.sessionId, two.sessionId);
  assert.ok(two.sequence > one.sequence);
  session.confirm();
  session.start();
  t.mock.timers.tick(2 * COORDINATION_TOUCH_INTERVAL_MS);
  assert.deepEqual(touched, [one.sessionId, one.sessionId]);
  fail = true;
  t.mock.timers.tick(COORDINATION_TOUCH_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(session.heartbeat, false);
  assert.equal(session.heartbeatError, 'expired');
  session.stop();
});

test('Now Reply reaches the original agent session inbox through CLI/MCP dispatch', async () => {
  const f = fixture(),
    agent = randomUUID();
  await announce(f, 'other', agent);
  const question = await f.as('other', {
    action: 'message',
    sessionId: agent,
    to: 'owner',
    text: 'Which file?',
  });
  await f.as('owner', {
    action: 'publish',
    operationId: randomUUID(),
    command: { kind: 'message', recipient: agent, text: 'Use src/index.ts', context: {} },
  });
  await f.as('owner', {
    action: 'publish',
    operationId: randomUUID(),
    command: { kind: 'ack', messageId: question.operationId, text: 'Replied.' },
  });
  const inbox = await f.as('other', { action: 'inbox', sessionId: agent });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].text, 'Use src/index.ts');
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
  assert.ok(
    [...f.tables.projectCoordinationEvents.values()].some(item => item.operationId === question.operationId),
  );
});

test('people can acknowledge their old sessions, other accounts cannot, and replay is idempotent', async () => {
  const f = fixture(),
    oldSession = randomUUID(),
    browserSession = randomUUID();
  await announce(f, 'owner', oldSession);
  await announce(f, 'owner', browserSession);
  const message = await f.as('other', { action: 'message', to: oldSession, text: 'Please review' });
  assert.ok(
    (await f.as('owner', { action: 'unacked', sessionId: browserSession })).items.some(
      item => item.id === message.operationId,
    ),
  );
  await assert.rejects(f.as('other', { action: 'ack', messageId: message.operationId }), /recipient session/);
  const input = {
    action: 'publish',
    operationId: randomUUID(),
    command: { kind: 'ack', messageId: message.operationId, sessionId: browserSession, text: 'Seen' },
  };
  const first = await f.as('owner', input),
    count = f.tables.projectCoordinationEvents.size;
  assert.equal((await f.as('owner', input)).operationId, first.operationId);
  assert.equal(f.tables.projectCoordinationEvents.size, count);
  assert.equal(f.tables.projectCoordinationReceipts.size, 1);
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
});

test('device agents keep exact-session acknowledgement and Needs-you visibility', async () => {
  const f = fixture(),
    oldSession = randomUUID(),
    actingSession = randomUUID();
  let subject = 'owner',
    device = false;
  f.ctx.auth.getUserIdentity = async () => ({ subject, ...(device ? { forgeCredential: 'device' } : {}) });
  f.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    credentialId: 'device',
    owner: 'owner',
    scope: 'coordination',
    expiresAt: Date.now() + 60000,
  });
  await announce(f, 'owner', oldSession);
  await announce(f, 'owner', actingSession);
  subject = 'other';
  const message = await f.as('other', { action: 'message', to: oldSession, text: 'For old session' });
  subject = 'owner';
  device = true;
  await assert.rejects(
    f.as('owner', { action: 'ack', messageId: message.operationId, sessionId: actingSession }),
    /recipient session/,
  );
  assert.equal((await f.as('owner', { action: 'unacked', sessionId: actingSession })).items.length, 0);
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
  assert.equal((await f.as('owner', { action: 'unacked', sessionId: oldSession })).items.length, 1);
  await f.as('owner', { action: 'ack', messageId: message.operationId, sessionId: oldSession });
  assert.equal(f.tables.projectCoordinationReceipts.size, 1);
});

test('legacy recipients resolve session ownership for people, never foreign sessions', async () => {
  const f = fixture(),
    oldSession = randomUUID();
  await announce(f, 'owner', oldSession);
  const message = await f.as('other', { action: 'message', to: oldSession, text: 'Legacy question' });
  const stored = [...f.tables.projectCoordinationEvents.values()].find(
    row => row.operationId === message.operationId,
  );
  delete stored.kind;
  delete stored.recipientActor;
  delete stored.recipientSession;
  await assert.rejects(f.as('other', { action: 'ack', messageId: message.operationId }), /recipient session/);
  await f.as('owner', { action: 'ack', messageId: message.operationId });
  assert.equal(f.tables.projectCoordinationReceipts.size, 1);
});

test('Needs you excludes a directed session the account cannot acknowledge', async () => {
  const f = fixture(),
    foreignSession = randomUUID();
  await announce(f, 'other', foreignSession);
  const message = await f.as('other', { action: 'message', to: 'owner', text: 'Directed question' });
  const row = [...f.tables.projectCoordinationEvents.values()].find(
    row => row.operationId === message.operationId,
  );
  row.recipientSession = foreignSession;
  assert.equal((await f.as('owner', { action: 'unacked' })).items.length, 0);
  await assert.rejects(f.as('owner', { action: 'ack', messageId: message.operationId }), /recipient session/);
});
