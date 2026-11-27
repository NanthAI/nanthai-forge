// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b6588425 line 3: one suspend switch and one shared per-account daily limiter on every channel that can
// carry a message (docs/security.d/sections/2150-account-limits-and-suspension.md).
import { workEventRows } from './work-event-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDocumentSize } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
import { setup as planningSetup } from './hosted-planning-fixture.mjs';
import { boardFixture } from './board-fixture.mjs';
import { invitationFixture } from './invitation-fixture.mjs';

const limits = await import(moduleUrl('../convex/accountLimits.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const proposals = await import(moduleUrl('../convex/projectProposals.ts'));
const workCommand = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const publicRead = await import(moduleUrl('../convex/publicRead.ts'));
const { createProject } = await import(moduleUrl('../convex/projectCreation.ts'));
const operator = await import(moduleUrl('../convex/projectBoardOperator.ts'));
const mail = await import(moduleUrl('../convex/projectInviteMail.ts'));
const teamInvitationWrites = await import(moduleUrl('../convex/teamInvitationWrites.ts'));
const hosting = await import(moduleUrl('../convex/projectHosting.ts'));
const bootstrapStore = await import(moduleUrl('../convex/projectBootstrapStore.ts'));
const savesApi = await import(moduleUrl('../convex/projectHostedSaves.ts'));
const { r2Key } = await import(moduleUrl('../convex/r2.ts'));
const { emptyHostedProject } = await import('../dist/hosted-bootstrap.js');
const { ACCOUNT_LIMITS } = limits;

const day = 86_400_000;
// One fixed instant for the whole file, the code under test included: noon UTC, so the reset is 12 h away.
const NOW = Date.UTC(2026, 10, 22, 12);
const RealDate = Date;
globalThis.Date = class FixtureDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(NOW);
  }
  static now() {
    return NOW;
  }
};
const code = expected => error => (error.data?.code ?? error.code) === expected;
const message = error => error.data?.message ?? error.message;
const suspended = code('ACCOUNT_SUSPENDED');
const suspend = (tables, subject) =>
  tables.boardSwitches.set(`switch-${subject}`, {
    _id: `switch-${subject}`,
    _creationTime: 1,
    key: `account:${subject}`,
    off: true,
    at: 1,
  });
const counters = (tables, channel, subject = 'owner') =>
  [...tables.deviceAttempts.values()].filter(
    row => row.owner.startsWith(`limit:${channel}:`) && row.owner.endsWith(`:${subject}`),
  );
const charged = (tables, channel, subject) =>
  counters(tables, channel, subject).reduce((sum, row) => sum + row.count, 0);
/** Every shard of a channel already at its share of the day's limit. */
function fill(tables, channel, { subject = 'owner', established = false } = {}) {
  const spec = ACCOUNT_LIMITS.channels[channel];
  const cap = established ? spec.established : spec.new;
  const now = NOW;
  for (const row of counters(tables, channel, subject)) tables.deviceAttempts.delete(row._id);
  for (let shard = 0; shard < spec.shards; shard++) {
    const owner = `limit:${channel}:${shard}:${subject}`;
    tables.deviceAttempts.set(owner, {
      _id: owner,
      _creationTime: 1,
      owner,
      windowAt: now - (now % day),
      count: Math.floor(cap / spec.shards) + (shard < cap % spec.shards ? 1 : 0),
      established,
    });
  }
}
const resetText = /resets at 00:00 UTC \(\d{4}-\d{2}-\d{2}T00:00:00\.000Z\), in \d+ (h|min)/;

async function startSetup() {
  const s = lanesFixture();
  const head = 'a'.repeat(64);
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: randomUUID(),
      sourceRevision: 0,
      channel: 'main',
      head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  const input = (operationId = randomUUID()) => ({
    projectId,
    operationId,
    authorityEpoch: 1,
    expectedMain: { head, receiptId: 'main-0' },
    intent: { kind: 'new', outcome: 'Synthetic start' },
  });
  const begin = args => s.call('start', start.start, args).then(JSON.parse);
  return { ...s, projectId, input, begin };
}

const importRecord = (index = 0) => {
  const id = randomUUID();
  return {
    kind: 'capture',
    id,
    operationId: id,
    request: `import-request-${index}`,
    at: new Date(NOW).toISOString(),
    count: 1,
    title: `Imported ${index}`,
    detail: 'Synthetic friction',
    area: 'import',
  };
};
const asContributor = s => {
  s.tables.projectContributors.set('contributor', {
    _id: 'contributor',
    projectId: 'project',
    contributor: 'contributor',
  });
  s.caller('contributor');
};

const appendIntent = (s, outcome = 'Synthetic outcome') =>
  s.send({ action: 'intent', outcome, constraints: '', base: s.preview.head });
async function planningComment(s, itemId, operationId = randomUUID()) {
  return s.send({ action: 'comment-planning-item', operationId, itemId, text: 'Synthetic comment' });
}

// --- A suspended account is refused on every channel, one test per channel ---

test('suspended account: planning comments and puts are refused and nothing is written', async t => {
  const s = await planningSetup(t);
  const item = s.item();
  await s.send(item);
  suspend(s.tables, 'owner');
  const events = workEventRows(s.tables).length;
  await assert.rejects(planningComment(s, item.itemId), suspended);
  await assert.rejects(s.send(s.item()), suspended);
  assert.equal(workEventRows(s.tables).length, events);
});

test('suspended account: friction capture and triage are refused', async () => {
  const s = recordsFixture();
  const first = await s.request('projectHostedFriction:capture', {
    operationId: randomUUID(),
    title: 'Before',
    detail: 'Synthetic friction',
    area: 'cli',
  });
  suspend(s.tables, 'owner');
  const rows = s.tables.projectHostedFriction.size;
  await assert.rejects(
    s.request('projectHostedFriction:capture', {
      operationId: randomUUID(),
      title: 'Blocked',
      detail: 'Synthetic friction',
      area: 'cli',
    }),
    suspended,
  );
  await assert.rejects(
    s.request('projectHostedFriction:triage', {
      operationId: randomUUID(),
      frictionIds: [first.id],
      status: 'dropped',
      reason: 'Synthetic',
    }),
    suspended,
  );
  assert.equal(s.tables.projectHostedFriction.size, rows);
});

test('suspended account: a new Intent through the Work command is refused', async t => {
  const s = await planningSetup(t);
  suspend(s.tables, 'owner');
  const events = workEventRows(s.tables).length;
  await assert.rejects(appendIntent(s), suspended);
  assert.equal(workEventRows(s.tables).length, events);
});

test('suspended account: a friction import is refused for the owner and a contributor', async () => {
  const s = recordsFixture();
  suspend(s.tables, 'owner');
  await assert.rejects(
    s.request('projectHostedFrictionImport:apply', { friction: [importRecord()] }),
    suspended,
  );
  s.tables.boardSwitches.delete('switch-owner');
  suspend(s.tables, 'contributor');
  asContributor(s);
  await assert.rejects(
    s.request('projectHostedFrictionImport:apply', { friction: [importRecord()] }),
    suspended,
  );
  assert.equal(s.tables.projectHostedFriction.size, 0);
});

test('suspended account: a Lane start (its name and Intent) is refused', async () => {
  const s = await startSetup();
  suspend(s.tables, 'owner');
  const operations = s.tables.projectHostedOperations.size;
  await assert.rejects(s.begin(s.input()), suspended);
  assert.equal(s.tables.projectHostedOperations.size, operations);
});

test('suspended account: a save (its message) is refused before an operation exists', async () => {
  const s = await saveFixture();
  suspend(s.tables, 'owner');
  await assert.rejects(s.prepare([s.change()]), suspended);
  assert.equal(s.tables.projectHostedOperations.size, 0);
});

test('suspended account: a new project is refused; an existing key is not a new project', async () => {
  const s = state([]);
  suspend(s.tables, 'owner');
  await assert.rejects(
    s.transaction(() => createProject(s.ctx, { owner: 'owner', key: randomUUID(), name: 'Blocked' })),
    suspended,
  );
  assert.equal(s.tables.hostedProjects.size, 0);
});

test('suspended account: invitations are refused before any write or mail', async t => {
  const s = invitationFixture(t);
  suspend(s.tables, 'owner');
  const tasks = s.scheduled.length;
  await assert.rejects(s.invite(), suspended);
  assert.equal(s.tables.projectInvites.size, 0);
  assert.equal(s.scheduled.length, tasks);
});

test('suspended account: an invitation resend and a team invitation are refused before any write', async t => {
  const s = invitationFixture(t);
  const row = await s.invite();
  // The first email finished (failed), so only the switch can refuse the resend.
  const sent = [...s.tables.projectAccessOperations.values()].find(op => op.operationId === row.operationId);
  if (sent?.mail) await s.ctx.db.patch(sent._id, { mail: { ...sent.mail, status: 'failed' } });
  const operations = s.tables.projectAccessOperations.size;
  for (const user of s.tables.users.values())
    if (user.accountKey === 'owner') s.tables.users.set(user._id, { ...user, githubId: '1001' });
  suspend(s.tables, 'owner');
  s.caller('owner');
  await assert.rejects(
    mail.resend._handler(s.ctx, {
      projectId: 'project',
      operationId: row.operationId,
      resendId: randomUUID(),
    }),
    suspended,
  );
  assert.equal(s.tables.projectAccessOperations.size, operations, 'no resend record');
  // Team invitations are owner-only and charge the same inviter budget.
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic team',
    operationId: randomUUID(),
  });
  const invites = s.tables.projectInvites.size;
  await assert.rejects(
    teamInvitationWrites.create._handler(s.ctx, {
      teamId: 'team',
      target: 'mate@example.test',
      operationId: randomUUID(),
    }),
    suspended,
  );
  assert.equal(s.tables.projectInvites.size, invites);
});

test('suspended account: coordination messages are refused', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    revision: 1,
    currentBackup: null,
  });
  suspend(s.tables, 'owner');
  await assert.rejects(
    coordination.publish._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      command: {
        kind: 'activity',
        sessionId: randomUUID(),
        sequence: 1,
        name: 'Agent',
        environment: 'fixture',
        status: 'working',
        summary: 'Synthetic',
        context: {},
      },
    }),
    suspended,
  );
  assert.equal(s.tables.projectCoordinationEvents.size, 0);
});

test('suspended account: board notes are refused', async () => {
  const f = boardFixture();
  await f.op('setSwitch', { scope: 'account', handle: 'writer-h', off: true, reason: 'abuse report' });
  await assert.rejects(f.post({ to: 'project', text: 'blocked' }, 'writer'), suspended);
  await f.post({ to: 'project', text: 'others still post' });
});

test('suspended account: a proposal is refused before it is registered', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    revision: 1,
    currentBackup: null,
  });
  suspend(s.tables, 'outside');
  s.tables.projectContributors.set('c', {
    _id: 'c',
    _creationTime: 1,
    projectId: 'project',
    contributor: 'outside',
  });
  await assert.rejects(
    proposals.register._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      intentId: randomUUID(),
      baseBackupId: 'backup',
      baseArchiveSha256: 'a'.repeat(64),
      baseState: 'b'.repeat(64),
      head: 'c'.repeat(64),
      viewId: 'view',
      digest: 'd'.repeat(64),
      size: 1,
      preview: { format: 'native', files: 1, bytes: 1 },
      transport: 'objects',
      actor: 'outside',
      request: 'e'.repeat(64),
      nonce: randomUUID(),
    }),
    suspended,
  );
  assert.equal(s.tables.projectProposals.size, 0);
});

test('suspending signs out devices and browser sessions, unlists public projects and hides the profile; lifting relists', async () => {
  const f = boardFixture();
  const owner = 'writer';
  f.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'cred',
    owner,
    name: 'laptop',
    tokenHash: 'hash',
    revoked: false,
    scope: 'cli',
    issuedAt: 1,
    expiresAt: NOW + day,
  });
  for (const [id, visibility] of [
    ['public-p', 'public'],
    ['private-p', 'private'],
  ]) {
    f.tables.hostedProjects.set(id, {
      _id: id,
      _creationTime: 1,
      owner,
      key: id,
      name: id,
      visibility,
      revision: 0,
      currentBackup: null,
    });
    f.tables.projectPublic.set(`pub-${id}`, {
      _id: `pub-${id}`,
      _creationTime: 1,
      projectId: id,
      owner,
      listed: visibility === 'public',
      stars: 0,
    });
  }
  // Browser sessions live in the auth component: record what the switch revokes.
  if (![...f.tables.users.values()].some(user => user.accountKey === owner))
    f.tables.users.set('writer-user', {
      _id: 'writer-user',
      _creationTime: 1,
      accountKey: owner,
      emailVerified: false,
    });
  const revoked = [];
  const runQuery = f.ctx.runQuery,
    runMutation = f.ctx.runMutation;
  // The auth component's references are outside this app's modules: answer them before validation.
  const stub = (key, value) =>
    Object.defineProperty(f.ctx, key, { configurable: true, writable: true, value });
  stub('runQuery', async (ref, args) =>
    args && Object.keys(args).join() === 'userId' ? [{ sessionId: 'session-1' }] : runQuery(ref, args),
  );
  stub('runMutation', async (ref, args) =>
    args?.sessionIds ? void revoked.push(...args.sessionIds) : runMutation(ref, args),
  );
  f.tables.accountHandles.set('handle-writer', {
    _id: 'handle-writer',
    _creationTime: 1,
    handle: 'writer-h',
    owner,
  });
  const profile = () => publicRead.profilePage._handler(f.ctx, { handle: 'writer-h', now: NOW });
  await f.op('setSwitch', { scope: 'account', handle: 'writer-h', off: true, reason: 'abuse report' });
  assert.equal(f.tables.cliCredentials.get('cred').revoked, true);
  assert.deepEqual(revoked, ['session-1'], 'browser sessions end');
  assert.equal(await profile(), null, 'the public profile is hidden');
  assert.deepEqual(
    [...f.tables.projectPublic.values()].map(row => row.listed),
    [false, false],
  );
  assert.equal(
    [...f.tables.boardAudit.values()].filter(
      row => row.action === 'suspend' && row.target === 'account:@writer-h',
    ).length,
    1,
  );
  await f.op('setSwitch', { scope: 'account', handle: 'writer-h', off: false, reason: 'appeal upheld' });
  assert.equal(f.tables.projectPublic.get('pub-public-p').listed, true);
  assert.notEqual(await profile(), null, 'the profile is public again');
  assert.equal(f.tables.projectPublic.get('pub-private-p').listed, false, 'a private project stays unlisted');
  assert.equal(f.tables.cliCredentials.get('cred').revoked, true, 'devices sign in again after a lift');
  void operator;
});

// --- Each limit is enforced, names the limit and says when it resets ---

for (const [channel, label] of [
  ['planning', 'planning comments, puts and notes on own projects'],
  ['contributed', 'Work notes on other projects'],
  ['friction', 'friction records'],
  ['start', 'Lane starts and new Intents'],
  ['save', 'saves'],
  ['project', 'new projects'],
])
  test(`limit: ${label} refuse at the New daily limit and name it and its reset`, async () => {
    const s = state([]);
    fill(s.tables, channel);
    const error = await s
      .transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', channel))
      .then(
        () => null,
        error => error,
      );
    assert(code('RATE_LIMITED')(error), String(error));
    const text = message(error);
    assert(text.includes(`daily limit of ${ACCOUNT_LIMITS.channels[channel].new} ${label}`), text);
    assert(text.includes('accounts under 7 days old without a linked GitHub login'), text);
    assert.match(text, resetText);
    assert.equal(error.data?.retryAt ?? error.retryAt, NOW - (NOW % day) + day);
  });

test('limit: a save at its limit is refused by the save mutation itself', async () => {
  const s = await saveFixture();
  fill(s.tables, 'save');
  await assert.rejects(s.prepare([s.change()]), code('RATE_LIMITED'));
  assert.equal(s.tables.projectHostedOperations.size, 0);
});

test('limit: a Lane start at its limit is refused by the start mutation itself', async () => {
  const s = await startSetup();
  fill(s.tables, 'start');
  await assert.rejects(s.begin(s.input()), code('RATE_LIMITED'));
});

test('limit: a planning comment at its limit is refused by the Work command itself', async t => {
  const s = await planningSetup(t);
  const item = s.item();
  await s.send(item);
  fill(s.tables, 'planning');
  await assert.rejects(planningComment(s, item.itemId), code('RATE_LIMITED'));
});

test('limit: friction capture at its limit is refused by the friction mutation itself', async () => {
  const s = recordsFixture();
  fill(s.tables, 'friction');
  await assert.rejects(
    s.request('projectHostedFriction:capture', {
      operationId: randomUUID(),
      title: 'Over',
      detail: 'Synthetic friction',
      area: 'cli',
    }),
    code('RATE_LIMITED'),
  );
});

test('limit: a new Intent through the Work command counts as a Lane start', async t => {
  const s = await planningSetup(t);
  fill(s.tables, 'start');
  await assert.rejects(appendIntent(s), code('RATE_LIMITED'));
});

test('limit: a contributor import is charged per new record, all or nothing; an owner import is not', async () => {
  const s = recordsFixture();
  await s.request('projectHostedFrictionImport:apply', { friction: [importRecord(0), importRecord(1)] });
  assert.equal(charged(s.tables, 'friction', 'owner'), 0, 'owner history import');
  asContributor(s);
  const spec = ACCOUNT_LIMITS.channels.friction;
  const page = Array.from({ length: spec.new - 1 }, (_, index) => importRecord(index));
  await s.request('projectHostedFrictionImport:apply', { friction: page });
  assert.equal(charged(s.tables, 'friction', 'contributor'), spec.new - 1);
  await s.request('projectHostedFrictionImport:apply', { friction: page });
  assert.equal(charged(s.tables, 'friction', 'contributor'), spec.new - 1, 'a replayed page is free');
  const rows = s.tables.projectHostedFriction.size;
  await assert.rejects(
    s.request('projectHostedFrictionImport:apply', { friction: [importRecord(90), importRecord(91)] }),
    code('RATE_LIMITED'),
  );
  assert.equal(s.tables.projectHostedFriction.size, rows);
  assert.equal(charged(s.tables, 'friction', 'contributor'), spec.new - 1, 'a refused page charges nothing');
});

test('limit: Work notes on other projects have their own counter, so own-project volume never blocks them', async () => {
  const s = state([]);
  s.tables.forgeAccounts.set('acct', {
    _id: 'acct',
    _creationTime: NOW - 30 * day,
    owner: 'owner',
    handle: 'olive',
  });
  fill(s.tables, 'planning', { established: true });
  await assert.rejects(
    s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'planning')),
    code('RATE_LIMITED'),
  );
  await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'contributed'));
  assert.equal(charged(s.tables, 'contributed'), 1);
});

test('limit: active projects cap a New account at 10 and an Established one at 100', async () => {
  const s = state([]);
  for (let index = 0; index < ACCOUNT_LIMITS.activeProjects.new; index++)
    s.tables.hostedProjects.set(`p${index}`, {
      _id: `p${index}`,
      _creationTime: 1,
      owner: 'owner',
      key: `k${index}`,
      name: 'P',
      revision: 0,
      currentBackup: null,
      visibility: 'private',
    });
  const make = () =>
    s.transaction(() => createProject(s.ctx, { owner: 'owner', key: randomUUID(), name: 'One more' }));
  await assert.rejects(
    make(),
    error => code('QUOTA_EXCEEDED')(error) && /10 active projects/.test(message(error)),
  );
  s.tables.forgeAccounts.set('acct', {
    _id: 'acct',
    _creationTime: NOW - 8 * day,
    owner: 'owner',
    handle: 'olive',
  });
  await make();
  assert.equal(charged(s.tables, 'project'), 1);
});

test('limit: coordination messages share the board account envelope', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    revision: 1,
    currentBackup: null,
  });
  s.tables.boardAccounts.set('acc', {
    _id: 'acc',
    _creationTime: 1,
    author: 'owner',
    dayStart: NOW - (NOW % day),
    posts: 100,
    bytes: 0,
    projects: [],
    newProjects: 0,
    alerted: ['cap'],
  });
  // Status updates only meet the suspend switch: they never use the note budget.
  await coordination.publish._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    command: {
      kind: 'activity',
      sessionId: randomUUID(),
      sequence: 1,
      name: 'Agent',
      environment: 'fixture',
      status: 'working',
      summary: 'Synthetic',
      context: {},
    },
  });
  const error = await coordination.publish
    ._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      command: {
        kind: 'message',
        text: 'Synthetic message',
      },
    })
    .then(
      () => null,
      error => error,
    );
  assert(code('RATE_LIMITED')(error));
  assert.match(message(error), /daily limit of 100 board notes and coordination messages/);
  assert.match(message(error), resetText);
});

// --- Tiers ---

test('tier: 7 days old or a linked GitHub login is Established; a conflict-marked login is not', async () => {
  const s = state([]);
  const established = subject => limits.establishedAccount(s.ctx, subject, NOW);
  s.tables.forgeAccounts.set('old', {
    _id: 'old',
    _creationTime: NOW - 7 * day,
    owner: 'old',
    handle: 'old',
  });
  s.tables.forgeAccounts.set('young', {
    _id: 'young',
    _creationTime: NOW - day,
    owner: 'young',
    handle: 'young',
  });
  s.tables.users.set('u-linked', {
    _id: 'u-linked',
    _creationTime: 1,
    accountKey: 'young',
    githubId: '1001',
  });
  s.tables.users.set('u-conflict', {
    _id: 'u-conflict',
    _creationTime: 1,
    accountKey: 'conflict',
    githubId: '1002',
    githubConflict: true,
  });
  assert.equal(await established('old'), true);
  assert.equal(await established('young'), true, 'a linked GitHub login');
  assert.equal(await established('conflict'), false);
  assert.equal(await established('nobody'), false);
});

test('tier: an Established account passes the New share, reads its tier once and keeps it for the day', async () => {
  const s = state([]);
  s.tables.forgeAccounts.set('acct', {
    _id: 'acct',
    _creationTime: NOW - 30 * day,
    owner: 'owner',
    handle: 'olive',
  });
  fill(s.tables, 'save');
  await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'save'));
  assert.equal(counters(s.tables, 'save').filter(row => row.established === true).length, 1);
  fill(s.tables, 'save', { established: true });
  await assert.rejects(
    s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'save')),
    error => /daily limit of 3,000 saves\./.test(message(error)),
  );
  fill(s.tables, 'planning', { established: true });
  await assert.rejects(
    s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'planning')),
    error => /daily limit of 5,000 planning/.test(message(error)),
  );
});

test('tier: a new UTC day starts every counter at zero, keeps an Established tier and forgets a New one', async () => {
  const s = state([]);
  const spec = ACCOUNT_LIMITS.channels.project;
  const yesterday = NOW - (NOW % day) - day;
  const seed = (key, established) =>
    s.tables.deviceAttempts.set(key, {
      _id: key,
      _creationTime: 1,
      owner: key,
      windowAt: yesterday,
      count: 50,
      established,
    });
  seed('limit:project:0:owner', false);
  await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'project'));
  const row = s.tables.deviceAttempts.get('limit:project:0:owner');
  assert.equal(row.count, 1);
  assert.equal(row.windowAt, NOW - (NOW % day));
  assert.equal(row.established, undefined, 'a New tier is read again today when it matters');
  for (let index = 1; index < spec.new; index++)
    await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'project'));
  await assert.rejects(
    s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'project')),
    code('RATE_LIMITED'),
  );
  // An Established tier carries over: no tier read, the Established limit applies today.
  seed('limit:project:0:veteran', true);
  for (let index = 0; index < spec.new + 1; index++)
    await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'veteran', 'project'));
  assert.equal(charged(s.tables, 'project', 'veteran'), spec.new + 1);
  assert.equal(s.tables.deviceAttempts.get('limit:project:0:veteran').established, true);
});

test('tier: a full shard hands over to the next, so the limit is the whole day total', async () => {
  const s = state([]);
  const spec = ACCOUNT_LIMITS.channels.friction;
  for (let index = 0; index < spec.new; index++)
    await s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'friction'));
  assert.equal(charged(s.tables, 'friction'), spec.new);
  await assert.rejects(
    s.transaction(() => limits.chargeAccountChannel(s.ctx, 'owner', 'friction')),
    code('RATE_LIMITED'),
  );
});

// --- Replays are free; server jobs are exempt ---

test('replay: the same save, start, friction and comment operation is charged once', async t => {
  const saves = await saveFixture();
  const first = await saves.prepare([saves.change()]);
  await saves.call('prepare', (await import(moduleUrl('../convex/projectHostedSaves.ts'))).prepare, {
    projectId: saves.projectId,
    request: JSON.stringify(first.request),
  });
  assert.equal(charged(saves.tables, 'save'), 1);

  const starts = await startSetup();
  const input = starts.input();
  await starts.begin(input);
  await starts.begin(input);
  assert.equal(charged(starts.tables, 'start'), 1);

  const friction = recordsFixture();
  const request = { operationId: randomUUID(), title: 'Once', detail: 'Synthetic friction', area: 'cli' };
  await friction.request('projectHostedFriction:capture', request);
  await friction.request('projectHostedFriction:capture', request);
  assert.equal(charged(friction.tables, 'friction'), 1);

  const planning = await planningSetup(t);
  const item = planning.item();
  await planning.send(item);
  const operationId = randomUUID();
  await planningComment(planning, item.itemId, operationId);
  await planningComment(planning, item.itemId, operationId);
  assert.equal(charged(planning.tables, 'planning'), 2, 'the put and one comment');
});

test('a server-flagged Work command (the owner-planning route of speed-budget Issues and member starts) is not charged', async t => {
  const s = await planningSetup(t);
  const item = s.item();
  await s.transaction(() =>
    workCommand.commandFromAction._handler(s.ctx, {
      projectId: s.projectId,
      operationId: item.operationId,
      command: JSON.stringify(item),
      owner: 'owner',
      server: true,
    }),
  );
  assert.equal(charged(s.tables, 'planning'), 0);
});

// --- Dogfood scale ---

test('dogfood burst: 10 agents on one account saving and commenting at once are never refused; counter clashes retry in Convex and none fails', async t => {
  // Seeded shard choice keeps the measured retry count stable.
  let seed = 7;
  t.mock.method(Math, 'random', () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const s = lanesFixture();
  s.insert('forgeAccounts', { owner: 'owner', handle: 'olive' });
  const account = [...s.tables.forgeAccounts.values()][0];
  account._creationTime = NOW - 30 * day;
  const charge = channel =>
    s.call(`charge-${channel}`, { _handler: ctx => limits.chargeAccountChannel(ctx, 'owner', channel) }, {});
  // Ten agents, each a save and a comment in flight at the same moment, three rounds.
  for (let round = 0; round < 3; round++)
    await Promise.all(Array.from({ length: 10 }, () => [charge('save'), charge('planning')]).flat());
  const attempts = name => s.counts.filter(count => count.name === name).length;
  assert.equal(charged(s.tables, 'save'), 30);
  assert.equal(charged(s.tables, 'planning'), 30);
  const retries = attempts('charge-save') - 30 + attempts('charge-planning') - 30;
  // Per write: one switch read, one counter read and one counter write; the tier is not read below the New share.
  const one = s.counts.find(count => count.name === 'charge-save');
  assert.deepEqual(
    one.readDocumentsByTable,
    { boardSwitches: 1, deviceAttempts: 1 },
    'the switch and the counter row',
  );
  assert.equal(one.writes, 1, 'one counter write');
  assert.equal(one.ranges, 2, 'the switch and the counter: two point lookups');
  const row = counters(s.tables, 'save')[0];
  assert(getDocumentSize(row) < 200, `counter row bytes ${getDocumentSize(row)}`);
  // Worst case: all 60 writes start at the same instant on 16 random shards. A shared counter row
  // makes a few retry once inside Convex (no client call, nothing refused or lost); real agents are
  // seconds apart. Unseeded runs measured 11-23 of 60; one row per account (no shards) runs out of retries and writes fail.
  console.log(`burst counter retries: ${retries} of 60`);
  assert(retries <= 24, `counter write conflicts: ${retries}`);
  assert(
    s.counts.every(count => count.retries < 3),
    'no write retried more than twice',
  );
});

function countWrites(db) {
  let writes = 0;
  for (const name of ['insert', 'patch', 'replace', 'delete']) {
    const fn = db[name];
    db[name] = async (...args) => {
      writes++;
      return fn(...args);
    };
  }
  return () => writes;
}

// --- Friction 8e03404e: refused requests never charge or write any account-limit shard ---

test('friction 8e03404e: refused projectWork append writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = await planningSetup(t);
  s.tables.deviceAttempts.clear();
  const writes = countWrites(s.ctx.db);
  await s.send(s.item());
  const seeded = await appendIntent(s, 'Seed shard 0');
  const currentRevision = seeded.revision;
  const before = writes();
  // Shard 0 exists for both planning and start; higher shards do not. Refused appends must touch neither.
  for (const nextPick of [0.9, 0]) {
    pick = nextPick;
    await assert.rejects(
      s.transaction(() =>
        work.append._handler(s.ctx, {
          projectId: s.projectId,
          owner: 'owner',
          operationId: randomUUID(),
          request: '{}',
          previousRevision: currentRevision + 10,
          command: JSON.stringify({
            action: 'intent',
            outcome: 'Stale intent',
            constraints: '',
            base: 'a'.repeat(64),
          }),
        }),
      ),
      code('WORK_STALE'),
    );
    const staleItem = s.item();
    await assert.rejects(
      s.transaction(() =>
        work.append._handler(s.ctx, {
          projectId: s.projectId,
          owner: 'owner',
          operationId: staleItem.operationId,
          request: '{}',
          previousRevision: currentRevision + 10,
          command: JSON.stringify(staleItem),
        }),
      ),
      code('WORK_STALE'),
    );
    const staleProjectionItem = s.item();
    await assert.rejects(
      s.transaction(() =>
        work.append._handler(s.ctx, {
          projectId: s.projectId,
          owner: 'owner',
          operationId: staleProjectionItem.operationId,
          request: '{}',
          previousRevision: currentRevision,
          command: JSON.stringify(staleProjectionItem),
          projection: {
            generationId: 'projectWorkGenerations-stale',
            metadata: '{}',
            entries: [],
            at: new Date(NOW).toISOString(),
          },
        }),
      ),
      code('WORK_STALE'),
    );
  }
  assert.equal(writes(), before, 'refused projectWork appends perform no database writes');
  assert.equal(charged(s.tables, 'planning'), 1);
  assert.equal(charged(s.tables, 'start'), 1);
});

test('friction 8e03404e: refused hosted start writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = await startSetup();
  await s.begin(s.input());
  // Shard 0 exists; shard 3 does not. Refused starts must touch neither shard nor insert an operation.
  for (const nextPick of [0.9, 0]) {
    pick = nextPick;
    await assert.rejects(
      s.begin({ ...s.input(), expectedMain: { head: 'b'.repeat(64), receiptId: 'stale-receipt' } }),
      code('CHANNEL_CHANGED'),
    );
    assert.equal(s.counts.at(-1).writes, 0, 'CHANNEL_CHANGED writes nothing');
    await assert.rejects(s.begin({ ...s.input(), initialHead: 'b'.repeat(64) }), code('SOURCE_UNAVAILABLE'));
    assert.equal(s.counts.at(-1).writes, 0, 'SOURCE_UNAVAILABLE writes nothing');
    await assert.rejects(s.begin({ ...s.input(), stackOn: randomUUID() }), code('NOT_FOUND'));
    assert.equal(s.counts.at(-1).writes, 0, 'missing stackOn writes nothing');
  }
  assert.equal(charged(s.tables, 'start'), 1);
});

test('friction 8e03404e: refused hosted save prepare writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = await saveFixture();
  await s.prepare([s.change()]);
  // Shard 0 exists; shard 14 does not. Refused save prepares must touch neither shard nor insert an operation.
  for (const nextPick of [0.9, 0]) {
    pick = nextPick;
    await assert.rejects(
      s.prepare([s.change()], { expected: { ...s.expected, version: 99 } }),
      code('WORK_STALE'),
    );
    assert.equal(s.counts.at(-1).writes, 0, 'WORK_STALE save prepare writes nothing');
    await assert.rejects(
      s.prepare([], { laneId: randomUUID(), pages: null, pageCount: 0, changeCount: 0 }),
      code('NOT_FOUND'),
    );
    assert.equal(s.counts.at(-1).writes, 0, 'NOT_FOUND lane save prepare writes nothing');
    await assert.rejects(
      s.call('prepare', savesApi.prepare, {
        projectId: s.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          laneId: s.laneId,
          authorityEpoch: 1,
          expected: s.expected,
          message: 'too many uploads',
          pages: null,
          pageCount: 0,
          changeCount: 0,
        }),
        uploads: Array.from({ length: 100 }, (_, i) => ({
          digest: i.toString(16).padStart(64, '0'),
          size: 1,
        })),
      }),
      code('BAD_ARGUMENT'),
    );
    assert.equal(s.counts.at(-1).writes, 0, 'BAD_ARGUMENT uploads > 99 writes nothing');
  }
  assert.equal(charged(s.tables, 'save'), 1);
});

test('friction 8e03404e: refused friction import writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = recordsFixture();
  asContributor(s);
  await s.request('projectHostedFrictionImport:apply', { friction: [importRecord(0)] });
  const before = s.counts().writes;
  // Shard 0 exists; shard 1 does not. A conflicting duplicate inside one import page must touch neither.
  for (const nextPick of [0.9, 0]) {
    pick = nextPick;
    const first = importRecord(1);
    const conflict = { ...first, title: 'Conflicting duplicate' };
    await assert.rejects(
      s.request('projectHostedFrictionImport:apply', { friction: [first, conflict] }),
      code('WORK_OPERATION_CHANGED'),
    );
  }
  assert.equal(s.counts().writes, before, 'refused friction import performs no database writes');
  assert.equal(charged(s.tables, 'friction', 'contributor'), 1);
});

test('friction 8e03404e: refused projectHosting create writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = state([]);
  const credentialId = randomUUID();
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    owner: 'owner',
    credentialId,
    name: 'laptop',
    tokenHash: 'hash',
    scope: 'cli',
    revoked: false,
    issuedAt: 1,
    expiresAt: NOW + day,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  const writes = countWrites(s.ctx.db);
  const savedWeb = process.env.FORGE_WEB_URL;
  const savedSite = process.env.SITE_URL;
  const create = () =>
    s.transaction(() =>
      hosting.create._handler(s.ctx, {
        operationId: randomUUID(),
        name: 'Synthetic hosted',
        visibility: 'private',
      }),
    );
  try {
    delete process.env.FORGE_WEB_URL;
    delete process.env.SITE_URL;
    // Absent shard (insert path).
    await assert.rejects(create(), code('HOST_CONFIGURATION'));
    assert.equal(writes(), 0, 'HOST_CONFIGURATION before shard exists writes nothing');
    // Seed shard 0 (patch path).
    process.env.FORGE_WEB_URL = 'https://forge.test';
    await create();
    delete process.env.FORGE_WEB_URL;
    const before = writes();
    for (const nextPick of [0.9, 0]) {
      pick = nextPick;
      await assert.rejects(create(), code('HOST_CONFIGURATION'));
    }
    assert.equal(writes(), before, 'HOST_CONFIGURATION after shard exists writes nothing');
    assert.equal(charged(s.tables, 'project'), 1);
  } finally {
    if (savedWeb === undefined) delete process.env.FORGE_WEB_URL;
    else process.env.FORGE_WEB_URL = savedWeb;
    if (savedSite === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = savedSite;
  }
});

test('friction 8e03404e: refused projectBootstrapStore publish writes nothing on any account-limit shard', async t => {
  let pick = 0;
  t.mock.method(Math, 'random', () => pick);
  const s = state([]);
  const writes = countWrites(s.ctx.db);
  const badPublish = () => {
    const operationId = randomUUID();
    const at = new Date(NOW).toISOString();
    const bogusId = 'hostedProjects-bogus';
    const bootstrap = emptyHostedProject(operationId, at);
    return s.transaction(() =>
      bootstrapStore.publish._handler(s.ctx, {
        operationId,
        name: 'Synthetic bootstrap',
        at,
        projectId: bogusId,
        objects: bootstrap.objects.map(object => ({
          r2Key: r2Key(bogusId, object.sha256),
          nonce: operationId,
        })),
      }),
    );
  };
  // Absent shard (insert path).
  await assert.rejects(badPublish(), code('INVALID_WORK_BACKUP'));
  assert.equal(writes(), 0, 'INVALID_WORK_BACKUP before shard exists writes nothing');
  // Seed shard 0 via prepare (patch path).
  await s.transaction(() =>
    bootstrapStore.prepare._handler(s.ctx, { operationId: randomUUID(), name: 'Seed project' }),
  );
  const before = writes();
  for (const nextPick of [0.9, 0]) {
    pick = nextPick;
    await assert.rejects(badPublish(), code('INVALID_WORK_BACKUP'));
  }
  assert.equal(writes(), before, 'INVALID_WORK_BACKUP after shard exists writes nothing');
  assert.equal(charged(s.tables, 'project'), 1);
});
