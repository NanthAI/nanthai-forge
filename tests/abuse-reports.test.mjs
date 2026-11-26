// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b6588425 line 2: report abuse of a project, a message, a comment or an account; the report reaches the operator
// review queue with an alert; review by suspend, purge or dismiss writes an audit row each
// (docs/security.d/sections/2160-abuse-reports.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { boardFixture } from './board-fixture.mjs';
import { projectRow } from './hosted-fixture.mjs';

const reports = await import(moduleUrl('../convex/abuseReports.ts'));
const { ACCOUNT_LIMITS } = await import(moduleUrl('../convex/accountLimits.ts'));
const { hostedRecordCommands } = await import(moduleUrl('../src/hosted-record-input.ts'));
const { policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const rows = (f, table) => [...f.tables[table].values()];

function fixture() {
  const f = boardFixture();
  for (const name of [
    'abuseReports',
    'users',
    'projectCoordinationEvents',
    'projectCoordinationReceipts',
    'cliCredentials',
    'teams',
    'teamMembers',
    'projectTeams',
  ])
    f.tables[name] ??= new Map();
  f.tables.hostedProjects.get('project').name = 'Demo';
  // The reader has a role on the private project but no Forge account row yet: a New account.
  const report = (input, actor = 'owner', { operationId = randomUUID(), projectId = 'project' } = {}) =>
    f.invoke(
      reports.report,
      'abuseReports:report',
      { ...(projectId ? { projectId } : {}), request: JSON.stringify({ ...input, operationId }) },
      actor,
    );
  const review = args =>
    f.invoke(reports.review, 'abuseReports:review', { operationId: randomUUID(), ...args }, null);
  const queue = (args = {}) => f.invoke(reports.queue, 'abuseReports:queue', args, null);
  const alerts = () =>
    f.scheduled.filter(task => getFunctionName(task.fn) === 'projectBoardLimits:deliver').map(t => t.args);
  /** A planning comment by `author` on a new Item, in the records Work store. */
  const comment = (author, text = 'Spam spam spam') => {
    const itemId = randomUUID(),
      commentId = randomUUID();
    f.tables.projectHostedRecordHeads.set(`issue-${itemId}`, {
      _id: `issue-${itemId}`,
      projectId: 'project',
      kind: 'issue',
      key: itemId,
      status: 'open',
      version: 1,
      recordId: 'missing-version',
      value: JSON.stringify({ id: itemId, title: 'Spam Item', status: 'open' }),
    });
    f.tables.projectHostedRecordHeads.set(`comment-${commentId}`, {
      _id: `comment-${commentId}`,
      projectId: 'project',
      kind: 'comment',
      key: commentId,
      parent: itemId,
      status: 'comment',
      version: 1,
      recordId: 'missing-version',
      value: JSON.stringify({ id: commentId, itemId, text, author }),
    });
    return { itemId, commentId };
  };
  /** A coordination event row, as the coordination write stores it. */
  const event = (command, fields = {}) => {
    const operationId = fields.operationId ?? randomUUID();
    const _id = `event-${operationId}`;
    f.tables.projectCoordinationEvents.set(_id, {
      _id,
      _creationTime: 1,
      projectId: 'project',
      operationId,
      actor: 'writer',
      at: 1,
      kind: command.kind,
      command,
      ...fields,
    });
    return { _id, operationId };
  };
  /** Sign the next calls in through a device with these settings (absent: the browser). */
  const device = (actor, settings) => {
    f.tables.cliCredentials.set('device', {
      _id: 'device',
      _creationTime: 1,
      owner: actor,
      credentialId: 'synthetic-report-device',
      name: 'test',
      scope: 'cli',
      tokenHash: 'synthetic',
      issuedAt: Date.UTC(2026, 0, 1),
      // Far past any test clock: the credential stays current.
      expiresAt: Date.UTC(2100, 0, 1),
      revoked: false,
      settings,
    });
    const identity = f.ctx.auth.getUserIdentity;
    f.ctx.auth.getUserIdentity = async () => {
      const user = await identity();
      return user && { ...user, forgeCredential: 'synthetic-report-device' };
    };
    return () => (f.ctx.auth.getUserIdentity = identity);
  };
  return { ...f, report, review, queue, alerts, comment, event, device };
}

test('a project, a message, a comment and an account each reach the review queue, with one alert per quiet spell', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Buy followers at example.invalid' }, 'writer');
  const { itemId, commentId } = f.comment('writer');
  const sent = [
    await f.report({ target: 'project', reason: 'Hosts a phishing kit' }, 'reader'),
    await f.report({ target: 'message', messageId: note.id, reason: 'Spam on the board' }),
    await f.report({ target: 'comment', planningItemId: itemId, commentId, reason: 'Spam comment' }),
    await f.report({ target: 'account', handle: '@owner-h', reason: 'Runs spam agents' }, 'writer', {
      projectId: null,
    }),
  ];
  for (const reply of sent) assert.equal(reply.status, 'received');
  const stored = rows(f, 'abuseReports');
  assert.deepEqual(
    stored.map(row => [row.kind, row.subject, row.status]),
    [
      ['project', 'owner', 'open'],
      ['message', 'writer', 'open'],
      ['comment', 'writer', 'open'],
      ['account', 'owner', 'open'],
    ],
  );
  assert.equal(stored[1].excerpt, 'Buy followers at example.invalid', 'the operator sees what was reported');
  // One push for the burst: it names no one and carries no report text; the alert email is asked for.
  const alerts = f.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].email, true);
  assert.match(alerts[0].text, /A project was reported .*abuseReports:queue/);
  assert.doesNotMatch(alerts[0].text, /phishing|owner-h|writer/);
  // The queue is newest first and names accounts by handle.
  const open = await f.queue();
  assert.deepEqual(
    open.page.map(row => [row.kind, row.reported, row.reporter]),
    [
      ['account', '@owner-h', '@writer-h'],
      ['comment', '@writer-h', '@owner-h'],
      ['message', '@writer-h', '@owner-h'],
      ['project', '@owner-h', 'reader'],
    ],
  );
  assert.equal(open.isDone, true);
});

test('a report retried with its operation id is the same report and is charged once', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Spam' }, 'writer');
  const operationId = randomUUID();
  const input = { target: 'message', messageId: note.id, reason: 'Spam' };
  const first = await f.report(input, 'owner', { operationId });
  const again = await f.report(input, 'owner', { operationId });
  assert.equal(again.reportId, first.reportId);
  assert.equal(f.tables.abuseReports.size, 1);
  const charged = rows(f, 'deviceAttempts')
    .filter(row => row.owner.startsWith('limit:report:'))
    .reduce((sum, row) => sum + row.count, 0);
  assert.equal(charged, 1);
  await assert.rejects(
    f.report({ ...input, reason: 'Something else' }, 'owner', { operationId }),
    code('WORK_OPERATION_CHANGED'),
  );
  const other = await f.post({ to: 'project', text: 'Not spam' }, 'writer');
  await assert.rejects(
    f.report({ ...input, messageId: other.id }, 'owner', { operationId }),
    code('WORK_OPERATION_CHANGED'),
    'a replay naming another target is not the same report',
  );
});

test('reports use the shared account limiter: a New account sends 10 a day, then RATE_LIMITED', async () => {
  const f = fixture();
  assert.deepEqual(
    [ACCOUNT_LIMITS.channels.report.new, ACCOUNT_LIMITS.channels.report.established],
    [10, 30],
  );
  for (let n = 0; n < 10; n++) await f.report({ target: 'project', reason: `Report ${n}` }, 'reader');
  await assert.rejects(f.report({ target: 'project', reason: 'Report 11' }, 'reader'), error => {
    assert.equal(error.data?.code ?? error.code, 'RATE_LIMITED');
    assert.match(error.data?.message ?? error.message, /daily limit of 10 abuse reports/);
    return true;
  });
  assert.equal(f.tables.abuseReports.size, 10);
});

test('a report never confirms what the reporter cannot read, and a suspended account cannot report', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Team only' }, 'writer');
  const unreadable = (target, actor, label) =>
    assert.rejects(f.report(target, actor), code('NOT_FOUND'), label);
  // A stranger on a private project.
  await assert.rejects(f.report({ target: 'project', reason: 'x' }, 'outsider'), code('PROJECT_UNAVAILABLE'));
  // A private project's reader follows coordination but not the team board; a team conversation is the team's only.
  await unreadable({ target: 'message', messageId: note.id, reason: 'x' }, 'reader', 'a team note');
  await unreadable({ target: 'message', messageId: randomUUID(), reason: 'x' }, 'reader', 'a missing note');
  const talk = f.event(
    { kind: 'message', text: 'team talk', context: {} },
    { conversation: true, planningItemId: randomUUID() },
  );
  await unreadable(
    { target: 'message', messageId: talk.operationId, reason: 'x' },
    'reader',
    'a conversation',
  );
  const plain = f.event({ kind: 'message', text: 'status', context: {} });
  assert.equal(
    (await f.report({ target: 'message', messageId: plain.operationId, reason: 'x' }, 'reader')).status,
    'received',
    'a private reader reads coordination, so may report it',
  );
  // A signed-in visitor of a public project reads neither the board nor coordination.
  f.tables.hostedProjects.get('project').visibility = 'public';
  await unreadable({ target: 'message', messageId: note.id, reason: 'x' }, 'outsider', 'a board note');
  await unreadable(
    { target: 'message', messageId: plain.operationId, reason: 'x' },
    'outsider',
    'coordination',
  );
  await unreadable({ target: 'message', messageId: randomUUID(), reason: 'x' }, 'outsider', 'a missing id');
  // A hidden Item's comment answers exactly like a missing comment.
  const { itemId, commentId } = f.comment('writer');
  const head = f.tables.projectHostedRecordHeads.get(`issue-${itemId}`);
  head.value = JSON.stringify({ ...JSON.parse(head.value), hidden: true });
  const hidden = { target: 'comment', planningItemId: itemId, commentId, reason: 'x' };
  await unreadable(hidden, 'outsider', 'a hidden Item');
  await unreadable({ ...hidden, commentId: randomUUID() }, 'outsider', 'a missing comment');
  await assert.rejects(f.report({ target: 'project', reason: 'x' }), code('BAD_ARGUMENT'), 'own project');
  await assert.rejects(
    f.report({ target: 'account', handle: 'nobody-here', reason: 'x' }, 'writer'),
    code('NOT_FOUND'),
  );
  await f.op('setSwitch', { scope: 'account', handle: 'writer-h', off: true, reason: 'drill' });
  await assert.rejects(
    f.report({ target: 'account', handle: 'owner-h', reason: 'x' }, 'writer'),
    code('ACCOUNT_SUSPENDED'),
  );
  assert.equal(f.tables.abuseReports.size, 1);
});

test('a contributor reports their own threads only: the reply to their note, never another team note', async () => {
  const f = fixture();
  const project = projectRow({ ...f.tables.hostedProjects.get('project'), key: 'project-key' });
  project.visibility = 'public';
  project.autonomyPolicy = {
    ...policyPreset('trusted'),
    agentDefaults: { boardAudience: 'team-and-contributors' },
  };
  f.tables.hostedProjects.set('project', project);
  const mine = await f.post({ to: 'project', text: 'question for the team' }, 'reader');
  const reply = await f.post({ replyTo: mine.id, text: 'rude answer' }, 'writer');
  const team = await f.post({ to: 'project', text: 'team only' }, 'writer');
  assert.equal(
    (await f.report({ target: 'message', messageId: reply.id, reason: 'Rude' }, 'reader')).status,
    'received',
  );
  await assert.rejects(
    f.report({ target: 'message', messageId: team.id, reason: 'x' }, 'reader'),
    code('NOT_FOUND'),
  );
});

test('a device reports with the scope the same write needs: account-write for an account, project write for content', async () => {
  const f = fixture();
  const selected = { projects: { kind: 'project', projectId: 'project' }, source: 'write' };
  let signOut = f.device('writer', selected);
  // The CLI sends the selected project with every call; an account report still needs the account-write scope.
  await assert.rejects(
    f.report({ target: 'account', handle: 'owner-h', reason: 'x' }, 'writer'),
    code('AUTH_SCOPE_DENIED'),
  );
  assert.equal((await f.report({ target: 'project', reason: 'x' }, 'writer')).status, 'received');
  signOut();
  signOut = f.device('writer', { projects: { kind: 'all' }, source: 'read' });
  await assert.rejects(f.report({ target: 'project', reason: 'y' }, 'writer'), code('AUTH_SCOPE_DENIED'));
  await assert.rejects(
    f.report({ target: 'account', handle: 'owner-h', reason: 'x' }, 'writer', { projectId: null }),
    code('AUTH_SCOPE_DENIED'),
  );
  signOut();
  f.device('writer', { projects: { kind: 'all' }, source: 'write' });
  assert.equal(
    (await f.report({ target: 'account', handle: 'owner-h', reason: 'x' }, 'writer', { projectId: null }))
      .status,
    'received',
  );
  assert.equal(f.tables.abuseReports.size, 2);
});

test('a steady stream of reports still alerts once every window', async t => {
  const f = fixture();
  let now = Date.UTC(2026, 10, 23, 12);
  t.mock.method(Date, 'now', () => now);
  for (let minute = 0; minute <= 12; minute += 3) {
    now += 3 * 60_000;
    await f.report({ target: 'project', reason: `Report ${minute}` }, 'reader');
  }
  // Five reports three minutes apart: the first alerts, the one ten or more minutes after it alerts again.
  assert.equal(f.alerts().length, 2);
});

test('review suspend stops the reported account everywhere and writes an audit row', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Spam' }, 'writer');
  const { reportId } = await f.report({ target: 'message', messageId: note.id, reason: 'Spam' });
  const done = await f.review({ reportId, action: 'suspend', reason: 'Confirmed spam' });
  assert.equal(done.status, 'suspended');
  assert.equal(f.tables.abuseReports.get(reportId).status, 'suspended');
  const audit = rows(f, 'boardAudit');
  assert.deepEqual(
    audit.map(row => [row.action, row.target, JSON.parse(row.detail).reportId]),
    [['suspend', 'account:writer', reportId]],
  );
  await assert.rejects(f.post({ to: 'project', text: 'more spam' }, 'writer'), code('ACCOUNT_SUSPENDED'));
});

test('a review retried with its operation id returns the first result and writes nothing more', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Spam' }, 'writer');
  const { reportId } = await f.report({ target: 'message', messageId: note.id, reason: 'Spam' });
  const operationId = randomUUID();
  const first = await f.review({ reportId, action: 'purge', reason: 'Spam', operationId });
  assert.deepEqual(await f.review({ reportId, action: 'purge', reason: 'Spam', operationId }), first);
  assert.equal(f.tables.boardAudit.size, 1);
  await assert.rejects(
    f.review({ reportId, action: 'dismiss', reason: 'Spam', operationId }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('review purge removes the reported message or every board note of the account, with an audit row', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Spam one' }, 'writer');
  await f.post({ to: 'project', text: 'Spam two' }, 'writer');
  await f.post({ to: 'project', text: 'Owner note' });
  const one = await f.report({ target: 'message', messageId: note.id, reason: 'Spam' });
  assert.deepEqual(await f.review({ reportId: one.reportId, action: 'purge', reason: 'Spam' }), {
    reportId: one.reportId,
    status: 'purged',
    removed: 1,
  });
  assert.deepEqual(
    rows(f, 'projectBoardMessages').map(row => row.body),
    ['Spam two', 'Owner note'],
  );
  const account = await f.report({ target: 'account', handle: 'writer-h', reason: 'Spammer' });
  assert.equal(
    (await f.review({ reportId: account.reportId, action: 'purge', reason: 'Spammer' })).removed,
    1,
  );
  assert.deepEqual(
    rows(f, 'projectBoardMessages').map(row => row.author),
    ['owner'],
  );
  assert.deepEqual(
    rows(f, 'boardAudit').map(row => [row.action, JSON.parse(row.detail).reportId]),
    [
      ['purge', one.reportId],
      ['purge', account.reportId],
    ],
  );
});

test('review purge of a coordination message replaces every copy of its text and keeps the answer’s own reason', async () => {
  const f = fixture();
  const asked = f.event(
    { kind: 'message', text: 'Click example.invalid', choices: ['Visit example.invalid', 'no'], context: {} },
    { conversation: true, planningItemId: randomUUID() },
  );
  const ackId = randomUUID();
  f.event(
    { kind: 'ack', messageId: asked.operationId, choice: 'Visit example.invalid', text: 'ok' },
    { operationId: ackId, actor: 'owner', resumePrompt: 'The recorded answer is "Visit example.invalid".' },
  );
  f.tables.projectCoordinationReceipts.set('receipt', {
    _id: 'receipt',
    _creationTime: 2,
    projectId: 'project',
    messageId: asked.operationId,
    actor: 'owner',
    ackId,
    choice: 'Visit example.invalid',
    at: 2,
  });
  // A conversation is the team's: the owner reports it.
  const { reportId } = await f.report({
    target: 'message',
    messageId: asked.operationId,
    reason: 'Phishing',
  });
  assert.equal(f.tables.abuseReports.get(reportId).eventId, asked._id);
  const handBack = f.event({
    kind: 'handoff',
    to: 'owner',
    summary: 'Run example.invalid',
    head: 'h',
    handBack: { left: 'Paste your token at example.invalid' },
  });
  const handed = await f.report({ target: 'message', messageId: handBack.operationId, reason: 'Phishing' });
  await f.review({ reportId, action: 'purge', reason: 'Phishing' });
  await f.review({ reportId: handed.reportId, action: 'purge', reason: 'Phishing' });
  const text = JSON.stringify([
    ...f.tables.projectCoordinationEvents.values(),
    ...rows(f, 'projectCoordinationReceipts'),
  ]);
  assert.doesNotMatch(text, /example\.invalid/);
  assert.deepEqual(f.tables.projectCoordinationEvents.get(asked._id).command, {
    kind: 'message',
    text: reports.PURGED_TEXT,
    context: {},
  });
  assert.equal(
    f.tables.projectCoordinationEvents.get(`event-${ackId}`).command.text,
    'ok',
    'the answer stays',
  );
});

test('review purge of a board note removes that note even when a coordination message shares its id', async () => {
  const f = fixture();
  const note = await f.post({ to: 'project', text: 'Spam' }, 'writer');
  const shared = f.event(
    { kind: 'message', text: 'Unrelated status', context: {} },
    { operationId: note.id },
  );
  const { reportId } = await f.report({ target: 'message', messageId: note.id, reason: 'Spam' });
  await f.review({ reportId, action: 'purge', reason: 'Spam' });
  assert.equal(f.tables.projectBoardMessages.size, 0);
  assert.equal(f.tables.projectCoordinationEvents.get(shared._id).command.text, 'Unrelated status');
  // Already gone: a second purge removes nothing and still writes its audit row.
  const again = await f.report({ target: 'message', messageId: shared.operationId, reason: 'x' });
  f.tables.projectCoordinationEvents.delete(shared._id);
  assert.equal((await f.review({ reportId: again.reportId, action: 'purge', reason: 'gone' })).removed, 0);
});

test('review dismiss writes an audit row; a comment purge that cannot run is refused with nothing written', async () => {
  const f = fixture();
  const { itemId, commentId } = f.comment('writer');
  const { reportId } = await f.report({
    target: 'comment',
    planningItemId: itemId,
    commentId,
    reason: 'Rude',
  });
  // This fixture keeps no Work index, so the comment purge (tests/comment-purge.test.mjs) refuses before writing.
  await assert.rejects(
    f.review({ reportId, action: 'purge', reason: 'Rude' }),
    code('PROJECT_WORK_INDEX_MISSING'),
  );
  assert.equal(f.tables.boardAudit.size, 0);
  assert.equal(f.tables.abuseReports.get(reportId).status, 'open');
  assert.equal((await f.review({ reportId, action: 'dismiss', reason: 'Not abuse' })).status, 'dismissed');
  assert.deepEqual(
    rows(f, 'boardAudit').map(row => [row.action, row.target]),
    [['dismiss', `report:${reportId}`]],
  );
  assert.deepEqual((await f.queue()).page, [], 'a reviewed report leaves the open queue');
  assert.deepEqual((await f.queue({ status: 'dismissed' })).page[0].actions, ['suspend', 'purge', 'dismiss']);
  assert.equal((await f.queue({ status: 'dismissed' })).page.length, 1);
  await assert.rejects(f.review({ reportId, action: 'dismiss', reason: ' ' }), code('BAD_ARGUMENT'));
});

test('the CLI report-abuse input names the field each target needs', () => {
  const schema = hostedRecordCommands['report-abuse'];
  assert.equal(schema.safeParse({ target: 'project', reason: 'Spam' }).success, true);
  for (const [input, field] of [
    [{ target: 'message', reason: 'x' }, 'messageId'],
    [{ target: 'comment', planningItemId: randomUUID(), reason: 'x' }, 'commentId'],
    [{ target: 'account', reason: 'x' }, 'handle'],
  ]) {
    const parsed = schema.safeParse(input);
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error.issues.map(issue => issue.path[0]),
      [field],
    );
  }
  assert.equal(schema.safeParse({ target: 'project', reason: '   ' }).success, false, 'a reason is required');
});
