// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me › FYI on the server (Item 48049998, decision b15fff49): projectNeedsFyi:read lists landings, settings
// changes (owner only) and messages to the reader that ask nothing; a message clears when it is acknowledged or its
// Lane closes (lands or is abandoned), and one with choices goes to Needs you through projectNeedsMe:read instead.
// Dismiss and Clear all persist per account on the existing read-state row, only on a click, and an idle view
// re-runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const fyi = await import(moduleUrl('../convex/projectNeedsFyi.ts'));
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const toRead = await import(moduleUrl('../convex/projectLandingReads.ts'));
const setup = await import(moduleUrl('../convex/projectSetup.ts'));
const { policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));

const DAY = Date.UTC(2026, 10, 17, 9);

function fixture() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const accept = (sequence, message, extra = {}) => {
    const id = randomUUID();
    s.insert('projectHostedAcceptances', {
      projectId,
      receiptId: id,
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence,
      value: JSON.stringify({
        id,
        at: new Date(DAY + sequence * 60_000).toISOString(),
        message,
        actor: { id: 'owner', kind: 'agent' },
        automatic: true,
        check: null,
        ...extra,
      }),
    });
    return id;
  };
  const lane = laneId =>
    s.insert('projectHostedPresence', {
      projectId,
      laneId,
      intentId: randomUUID(),
      actor: 'owner',
      agent: 'quiet-otter',
      goal: 'Stream parser',
      paths: [],
      pathCount: 0,
      at: DAY,
    });
  const message = (laneId, text, extra = {}, recipientSession) => {
    const operationId = randomUUID();
    s.insert('projectCoordinationEvents', {
      projectId,
      operationId,
      actor: 'agent-principal',
      at: DAY + 5 * 60_000,
      command: { kind: 'message', recipient: 'owner', text, context: { laneId }, ...extra },
      kind: 'message',
      recipientActor: 'owner',
      ...(recipientSession ? { recipientSession } : {}),
      laneId,
    });
    return operationId;
  };
  const read = (actor = 'owner') =>
    s.call('observerBudgetPage', fyi.read, { projectId }, actor).then(JSON.parse);
  const dismiss = (args, actor = 'owner') =>
    s.call('fyiDismiss', fyi.dismiss, { projectId, ...args }, actor).then(JSON.parse);
  return { s, projectId, accept, lane, message, read, dismiss };
}

test('FYI lists landings newest first and messages that ask nothing; a question goes to Needs you', async () => {
  const f = fixture();
  f.accept(1, 'Adapter: abort on timeout\n\nbody');
  f.accept(2, 'Types: narrow ReadResult', { firstCheck: { landedOn: 'recheck', reason: 'main-moved' } });
  f.lane('lane-a');
  const note = f.message('lane-a', 'Heads up: I changed the CI matrix.');
  const ask = f.message('lane-a', 'Which lands first?', { choices: ['Mine', 'Theirs'] });
  const view = await f.read();
  assert.deepEqual(
    view.landings.map(row => [row.title, row.redone]),
    [
      ['Types: narrow ReadResult', true],
      ['Adapter: abort on timeout', false],
    ],
  );
  assert.equal(
    view.landings[0].thrown,
    null,
    'a redone check without a landing row is not reported, never 0',
  );
  assert.deepEqual(
    view.messages.map(row => row.id),
    [note],
    'only the message that asks nothing is FYI',
  );
  const held = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'owner');
  assert.deepEqual(
    held.asks.map(row => [row.id, row.choices]),
    [[ask, ['Mine', 'Theirs']]],
    'the question waits on the reader',
  );
});

test('846c635b: History filters by bound Intent once per distinct Intent and pages on receipt sequence', async () => {
  const f = fixture();
  const item = randomUUID(),
    target = randomUUID(),
    unrelated = randomUUID();
  for (const [key, planningItemId] of [
    [target, item],
    [unrelated, randomUUID()],
  ])
    f.s.insert('projectHostedRecordHeads', {
      projectId: f.projectId,
      kind: 'intent',
      key,
      planningItemId,
      status: 'completed',
      parent: '',
      version: 1,
      recordId: 'synthetic-intent',
    });
  const receiptIds = new Map();
  for (let sequence = 1; sequence <= 65; sequence++) {
    const receiptId = f.accept(sequence, 'Recorded landing');
    receiptIds.set(sequence, receiptId);
    const receipt = [...f.s.tables.projectHostedAcceptances.values()].find(
      row => row.receiptId === receiptId,
    );
    f.s.insert('projectHostedFinishes', {
      projectId: f.projectId,
      submissionId: receipt.submissionId,
      composeOperationId: null,
      parentSubmissionId: null,
      waiting: false,
      wake: null,
      value: JSON.stringify({ source: { intentId: sequence % 2 ? target : unrelated } }),
    });
  }
  const page = async before =>
    JSON.parse(
      await f.s.call(
        'itemHistory',
        toRead.list,
        { projectId: f.projectId, item, view: 'recent', before },
        'owner',
      ),
    );
  const first = await page();
  assert.equal(first.rows.length, 30);
  assert.equal(first.next, 7);
  assert.equal(f.s.counts.at(-1).readRangesByTable.projectHostedRecordHeads, 2 + 2 * 30);
  const next = await page(first.next);
  assert.deepEqual(
    [...first.rows, ...next.rows].map(row => row.receiptId),
    Array.from({ length: 33 }, (_, i) => receiptIds.get(65 - 2 * i)),
  );
  assert.equal(next.next, null);
});

test('personal setup survives hide and restore on the existing FYI row with one write and no added lookup', async () => {
  const f = fixture();
  const write = (change, expectedRevision, operationId = randomUUID(), actor = 'owner') =>
    f.s.call(
      'setupPreferences',
      setup.setPreferences,
      { projectId: f.projectId, change, expectedRevision, operationId },
      actor,
    );
  await f.dismiss({ keys: ['check:old@1'] });
  const before = await f.read();
  const ranges = f.s.counts.at(-1).ranges;
  assert.equal(before.setup, undefined);

  const skip = { step: 'agent', skip: true };
  const operationId = randomUUID();
  const skipped = await write(skip, 0, operationId);
  const meter = f.s.counts.at(-1);
  assert.equal(meter.readRangesByTable.projectLandingReads, 1);
  assert.equal(meter.writes, 1);
  assert(meter.writeBytes < 1024);
  assert.deepEqual(await write(skip, 0, operationId), skipped);
  assert.equal(f.s.counts.at(-1).writes, 0);

  const hidden = await write({ visibility: 'hidden' }, 1);
  assert.deepEqual(hidden, { visibility: 'hidden', skipped: ['agent'], revision: 2 });
  const after = await f.read();
  assert.deepEqual(after.setup, hidden, 'another device sees the persisted choices');
  assert.deepEqual(after.state, before.state);
  assert.equal(f.s.counts.at(-1).ranges, ranges);
  assert.equal((await f.read('another-reader')).setup, undefined);
  await assert.rejects(write(skip, 0, operationId), error => error.data?.code === 'WORK_STALE');
  const restored = await write({ visibility: 'shown' }, 2);
  assert.deepEqual(restored, { visibility: 'shown', skipped: ['agent'], revision: 3 });
});

test('personal setup cannot be written by a stranger to a private project', async () => {
  const f = fixture();
  const privateProject = f.s.insert('hostedProjects', {
    key: 'private',
    name: 'Private',
    owner: 'owner',
    visibility: 'private',
    currentBackup: null,
    revision: 0,
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await assert.rejects(
    f.s.call(
      'setupPreferences',
      setup.setPreferences,
      {
        projectId: privateProject,
        change: { visibility: 'hidden' },
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      'stranger',
    ),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(f.s.counts.at(-1).writes, 0);
});

test('Flow receives the latest full pass time from the existing FYI audit page', async () => {
  const f = fixture();
  const audit = (sequence, kind, extra = {}) =>
    f.s.insert('projectHostedMainAuditEvents', {
      projectId: f.projectId,
      sequence,
      kind,
      at: new Date(DAY + sequence * 60_000).toISOString(),
      head: 'a'.repeat(64),
      runId: randomUUID(),
      ...extra,
    });
  assert.equal((await f.read()).mainCheckedAt, undefined);
  audit(1, 'green');
  audit(2, 'green');
  audit(3, 'stalled');
  await f.dismiss({ clearAll: true });
  assert.equal((await f.read()).mainCheckedAt, DAY + 2 * 60_000, 'the newer pass survives Clear all');
  audit(4, 'red');
  assert.equal((await f.read()).mainCheckedAt, undefined, 'a previous green must not date a red main');
  f.accept(5, 'Full-gated recovery');
  audit(5, 'green', { reverted: false });
  assert.equal((await f.read()).mainCheckedAt, undefined, 'a recovery may record landing time');
  audit(6, 'red');
  f.accept(7, 'Source for a later audit');
  audit(7, 'green', { reverted: true, at: new Date(DAY + 8 * 60_000).toISOString() });
  assert.equal((await f.read()).mainCheckedAt, DAY + 8 * 60_000, 'an audit can turn main green again');
  audit(9, 'green');
  assert.equal((await f.read()).mainCheckedAt, DAY + 9 * 60_000);
});

test('a message clears when it is acknowledged, or when its Lane lands or is abandoned', async () => {
  const f = fixture();
  const presence = f.lane('lane-a');
  f.lane('lane-b');
  const a = f.message('lane-a', 'FYI on lane a');
  const b = f.message('lane-b', 'FYI on lane b');
  assert.deepEqual((await f.read()).messages.map(row => row.id).sort(), [a, b].sort());
  // Landing or abandoning a Lane deletes its presence row (convex/projectHostedOverlapFields.ts).
  f.s.tables.projectHostedPresence.delete(presence);
  assert.deepEqual(
    (await f.read()).messages.map(row => row.id),
    [b],
  );
  f.s.insert('projectCoordinationReceipts', {
    projectId: f.projectId,
    messageId: b,
    actor: 'owner',
    ackId: randomUUID(),
    at: DAY + 6 * 60_000,
  });
  assert.deepEqual((await f.read()).messages, []);
  assert.deepEqual((await f.read('reader')).messages, [], 'messages to someone else never show');
});

test('team-only coordination (b6588425): a public project outsider gets no messages, its landings stay readable', async () => {
  const f = fixture();
  f.lane('lane-a');
  f.accept(1, 'Adapter: abort on timeout');
  // Messages a former member received while on the team: a note (FYI) and a question (Needs you).
  const to = (text, extra = {}) => {
    const operationId = randomUUID();
    f.s.insert('projectCoordinationEvents', {
      projectId: f.projectId,
      operationId,
      actor: 'agent-principal',
      at: DAY + 5 * 60_000,
      command: { kind: 'message', recipient: 'former', text, context: { laneId: 'lane-a' }, ...extra },
      kind: 'message',
      recipientActor: 'former',
      laneId: 'lane-a',
    });
    return operationId;
  };
  const note = to('Heads up: I changed the CI matrix.');
  const ask = to('Which lands first?', { choices: ['Mine', 'Theirs'] });
  const outsider = await f.read('former');
  assert.deepEqual(outsider.messages, [], 'no coordination message reaches an outsider');
  assert.deepEqual(
    outsider.landings.map(row => row.title),
    ['Adapter: abort on timeout'],
    'public landings are unchanged',
  );
  const held = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'former');
  assert.deepEqual(held.asks, [], 'no question reaches an outsider');
  // The same account as a contributor (write member) reads both again.
  f.s.insert('projectContributors', { projectId: f.projectId, contributor: 'former' });
  assert.deepEqual(
    (await f.read('former')).messages.map(row => row.id),
    [note],
  );
  const member = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'former');
  assert.deepEqual(
    member.asks.map(row => row.id),
    [ask],
  );
});

test('settings changes are the owner’s; readers never see them', async () => {
  const f = fixture();
  const before = policyPreset('trusted');
  f.s.insert('projectPolicyChanges', {
    projectId: f.projectId,
    operationId: randomUUID(),
    actor: 'owner',
    request: 'r',
    at: new Date(DAY).toISOString(),
    previous: before,
    policy: {
      ...before,
      lifecycle: { ...before.lifecycle, completeOnAccept: !before.lifecycle?.completeOnAccept },
    },
    rule: 'owner-person',
  });
  const owner = await f.read();
  assert.deepEqual(
    owner.settings.map(row => row.areas),
    [['lifecycle']],
  );
  assert.deepEqual((await f.read('reader')).settings, []);
});

test('a plan-visibility row shows as its own area with old and new, not as a policy edit (Item 65b6d701)', async () => {
  const f = fixture();
  const policy = policyPreset('trusted');
  f.s.insert('projectPolicyChanges', {
    projectId: f.projectId,
    operationId: randomUUID(),
    actor: 'owner',
    request: 'r',
    at: new Date(DAY).toISOString(),
    previous: policy,
    policy,
    planChange: { from: 'public', to: 'members' },
    rule: 'owner-person',
  });
  const owner = await f.read();
  assert.deepEqual(
    owner.settings.map(row => [row.areas, row.plan]),
    [[['planVisibility'], { from: 'public', to: 'members' }]],
  );
  assert.deepEqual((await f.read('reader')).settings, []);
});

test('Dismiss and Clear all persist per account, write only on click, and Undo puts the list back', async () => {
  const f = fixture();
  for (let i = 1; i <= 3; i++) f.accept(i, `L${i}`);
  const first = await f.read();
  assert.deepEqual(first.state, { clearedAt: null, clearedSequence: null, dismissed: [] });
  const writesBefore = f.s.counts.filter(meter => meter.writeBytes > 0).length;
  await f.read();
  assert.equal(
    f.s.counts.filter(meter => meter.writeBytes > 0).length,
    writesBefore,
    'a view writes nothing',
  );

  const key = `landing:${first.landings[0].receiptId}@1`;
  assert.equal((await f.dismiss({ keys: [key] })).changed, true);
  assert.equal((await f.dismiss({ keys: [key] })).changed, false, 'dismissing twice is dismissing once');
  assert.deepEqual((await f.read()).state.dismissed, [key]);
  assert.deepEqual((await f.read('reader')).state.dismissed, [], 'another account keeps its own list');

  const cleared = await f.dismiss({ clearAll: true });
  const after = await f.read();
  assert.equal(after.state.clearedSequence, 3);
  assert.deepEqual(after.state.dismissed, [], 'clearing folds the dismissed set into the clear line');
  assert.deepEqual(after.landings, [], 'landings at or below the clear line are not read again');
  f.accept(4, 'L4');
  assert.deepEqual(
    (await f.read()).landings.map(row => row.title),
    ['L4'],
    'a newer landing shows',
  );
  await f.dismiss({ restore: cleared.before });
  assert.deepEqual((await f.read()).state, cleared.before, 'Undo restores the earlier state exactly');

  const rows = [...f.s.tables.projectLandingReads.values()];
  assert.equal(rows.length, 2 - 1, 'one row per account and project, the one To read already uses');
  const listed = JSON.parse(await f.s.call('list', toRead.list, { projectId: f.projectId }, 'owner'));
  assert.equal(listed.started, false, 'an FYI clear marks nothing read in To read');

  await assert.rejects(
    f.dismiss({ keys: ['approval:anything'] }),
    /kind:id@version/,
    'a key without a version is refused',
  );
});

test('an idle FYI view re-runs nothing, and one read stays bounded', async () => {
  const f = fixture();
  for (let i = 1; i <= 40; i++) f.accept(i, `Landing ${i}`);
  const view = await f.read();
  assert.equal(view.landings.length, fyi.FYI_LANDINGS);
  assert.equal(view.landingsMore, true);
  const meter = f.s.counts.at(-1);
  assert.ok(
    meter.documents <= 3 * fyi.FYI_LANDINGS + 4 * fyi.FYI_EVENTS + 4 * fyi.FYI_MESSAGES + 4,
    'bounded',
  );
  const unchanged = f.s.readSet();
  assert.equal(unchanged(), true, 'nothing it read changed, so nothing re-runs');
});

test('a1e71a48 (friction ff0a29a3): same-account session-directed questions stay out of human Needs you and add no session reads', async () => {
  const f = fixture();
  f.lane('lane-a');
  const humanAsk = f.message('lane-a', 'Ship v2?', { choices: ['Yes', 'No'] });
  const before = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'owner');
  const docsBefore = f.s.counts.at(-1).documents;
  assert.deepEqual(
    before.asks.map(row => row.id),
    [humanAsk],
  );
  // Insert a same-account session-directed question (two agents on owner's account).
  const peerSession = randomUUID();
  f.s.insert('projectCoordinationEvents', {
    projectId: f.projectId,
    operationId: randomUUID(),
    actor: 'owner',
    at: DAY + 6 * 60_000,
    command: {
      kind: 'message',
      recipient: 'owner/civic-ox',
      text: 'Paging first or Hierarchy first?',
      choices: ['Paging first', 'Hierarchy first'],
      question: { holdsWork: false },
      context: { laneId: 'lane-a' },
    },
    kind: 'message',
    recipientActor: 'owner',
    recipientSession: peerSession,
    laneId: 'lane-a',
    conversation: true,
  });
  const after = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'owner');
  const docsAfter = f.s.counts.at(-1).documents;
  assert.deepEqual(
    after.asks.map(row => row.id),
    [humanAsk],
    'same-account agent-to-agent question stays out of Needs you',
  );
  // Only the one extra event row from the existing index scan is read — no receipt, presence or session lookup.
  assert.equal(docsAfter, docsBefore + 1);
  assert.deepEqual((await f.read()).messages, [], 'also excluded from FYI');
});

test('Needs you looks up a cross-account recipient session once per page, not once per question', async () => {
  const read = async directed => {
    const f = fixture();
    const sessionId = randomUUID();
    f.s.insert('projectCoordinationSessions', {
      projectId: f.projectId,
      sessionId,
      actor: 'owner',
      name: 'civic-ox',
      environment: 'Lane',
      status: 'completed',
      sequence: 1,
      summary: 'Synthetic session',
      context: {},
      lastSeen: DAY,
      operationId: randomUUID(),
    });
    f.lane('lane-a');
    for (const text of ['Ship v2?', 'Update the docs?'])
      f.message('lane-a', text, { choices: ['Yes', 'No'] }, directed ? sessionId : undefined);
    const result = await f.s.call('needsRead', needs.read, { projectId: f.projectId }, 'owner');
    return { rows: result.asks, reads: f.s.counts.at(-1).readDocumentsByTable };
  };
  const account = await read(false);
  const session = await read(true);
  assert.equal(account.rows.length, 2);
  assert.deepEqual(
    session.rows.map(row => row.recipientEnded),
    [true, true],
  );
  assert.deepEqual(session.reads, {
    ...account.reads,
    projectCoordinationSessions: 1,
    // The viewer's handle is mapped once by publicPeople for both recipient labels.
    forgeAccounts: account.reads.forgeAccounts + 1,
  });
});
