// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 1d51c91f: Item audit trail (timeline, backlog window, agent attribution on puts, access & identity rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, beginRetainedWork } from './hosted-planning-fixture.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { executeHostedPlanning, markPlanningStarted } from '../dist/hosted-agent-planning.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { capabilityOptions } from '../dist/hosted-capabilities-early.js';
import {
  advertisedFeatures,
  hostedContractFeatures,
  MAX_CONTRACT_FEATURES,
  planningAuditFeature,
  planningHistoryFeature,
  planningInitiativeCountsFeature,
  planningWaitingFeature,
} from '../dist/hosted-contract-features.js';
import { diffDoneWhen, bodyDiffSummary, parseAuditInstant } from '../dist/planning-audit.js';
import { cliReplyLines } from '../dist/cli-reply-lines.js';
import { isAgentSlug } from '../dist/agent-slug.js';
import { agentAuthorship } from '../dist/agent-turn-work.js';
import { AGENT_CLIENTS, nearestAgentProcess } from '../dist/agent-session.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const hostedPlanning = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const workCommand = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const planningBatch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const notes = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const { move: startMove } = await import(moduleUrl('../convex/projectPlanningStart.ts'));

const code = expected => error => (error.data?.code ?? error.code) === expected;

function makePort(s, options = {}) {
  installPlanningSearch(s);
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(name);
    const [mod, fn] = name.split(':');
    const handler = {
      projectWorkIndex: index,
      projectHostedPlanning: hostedPlanning,
      projectWorkCommand: workCommand,
      projectPlanningBatch: planningBatch,
      projectItemWork: itemWork,
    }[mod][fn];
    return handler._handler(s.ctx, args);
  };
  return {
    calls,
    root: s.directory,
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    exchange: { client: { query: (ref, args) => invoke(getFunctionName(ref), args) } },
    query: async (name, args) => {
      const value = await invoke(name, { ...args, projectId: s.projectId });
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    mutation: async (name, args) => {
      const value = await invoke(name, { ...args, projectId: s.projectId });
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    serverFeatures: options.features ?? [
      ...hostedContractFeatures,
      planningInitiativeCountsFeature,
      planningHistoryFeature,
      planningWaitingFeature,
      planningAuditFeature,
    ],
    commentAgent: options.commentAgent,
  };
}

function addDeviceAndAccounts(s) {
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'cred-1',
    owner: 'owner',
    name: 'agent-box',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.parse('2026-11-01T00:00:00.000Z'),
    expiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
    revoked: false,
    scope: 'cli',
  });
  s.tables.forgeAccounts.set('acct-owner', {
    _id: 'acct-owner',
    _creationTime: 1,
    owner: 'owner',
    handle: 'ada',
  });
  s.tables.accountHandles.set('alias-owner', {
    _id: 'alias-owner',
    owner: 'owner',
    handle: 'ada',
  });
  s.tables.projectContributors.set('member-writer', {
    _id: 'member-writer',
    projectId: s.projectId,
    contributor: 'writer',
  });
  s.tables.projectReaders.set('member-reader', {
    _id: 'member-reader',
    projectId: s.projectId,
    reader: 'reader',
  });
}

const runPlanning = (p, input) =>
  executeHostedPlanning(p, 'owner', 'planning', input, undefined).then(r => r.result);
const runPut = (p, input) =>
  executeHostedPlanning(p, 'owner', 'put-planning-item', input, undefined).then(r => r.result);
const runComment = (p, input) =>
  executeHostedPlanning(p, 'owner', 'comment-planning-item', input, undefined).then(r => r.result);

test('capability negotiation fits planning-audit inside MAX_CONTRACT_FEATURES for all actions', () => {
  for (const [action, status, startWithIntent, input] of [
    ['status', true, false, {}],
    ['planning', false, false, {}],
    ['planning', false, false, { counts: true, initiativeId: randomUUID() }],
    ['put-planning-item', false, false, {}],
    ['tick-planning-item', false, false, {}],
    ['start', false, false, {}],
    ['start', false, true, {}],
    ['finish', false, false, {}],
  ]) {
    const { features } = capabilityOptions('.', status, startWithIntent, action, input);
    assert.ok(
      features.length <= MAX_CONTRACT_FEATURES,
      `${action} (${startWithIntent}): ${features.length} > ${MAX_CONTRACT_FEATURES}`,
    );
    if (['planning', 'put-planning-item', 'tick-planning-item', 'start'].includes(action))
      assert.ok(features.includes(planningAuditFeature), `${action} requests planning-audit`);
  }
});

test('pure audit diff helpers handle Done-when ticks, bounded body excerpts and strict calendar dates', () => {
  const dw = diffDoneWhen(
    '## Done when\n- [ ] First check\n- [x] Second check\n- [ ] Old line\n',
    '## Done when\n- [x] First check\n- [ ] Second check\n- [ ] Added line\n',
  );
  assert.deepEqual(dw, {
    ticked: ['First check'],
    unticked: ['Second check'],
    added: [{ checked: false, text: 'Added line' }],
    removed: [{ checked: false, text: 'Old line' }],
  });
  const body = bodyDiffSummary(
    Array.from({ length: 10 }, (_, i) => `old line ${i}`).join('\n'),
    Array.from({ length: 10 }, (_, i) => `new line ${i}`).join('\n'),
  );
  assert.equal(body.addedLines, 10);
  assert.equal(body.removedLines, 10);
  assert.equal(body.excerpt.length, 6);
  assert.equal(body.truncated, true);
  assert.ok(Number.isFinite(parseAuditInstant('2026-11-22')));
  assert.ok(Number.isNaN(parseAuditInstant('2026-02-30')));
  assert.ok(Number.isNaN(parseAuditInstant('2026-11-22T25:00:00Z')));
});

test('Item audit timeline records who, when and what changed across versions, comments, Lanes and landings with exact paging', async t => {
  const baseTime = Date.parse('2026-11-18T10:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: baseTime });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);

  const as = identity => {
    s.ctx.auth.getUserIdentity = async () => identity;
  };
  const agentPort = makePort(s, {
    commentAgent: () => ({ agent: 'lucky-hornet', agentClient: 'claude-code:claude-opus-5-5' }),
  });
  const humanPort = makePort(s);

  // Create Initiatives and a parent Issue as the owner in the browser.
  as({ subject: 'owner' });
  const initA = (await runPut(humanPort, { kind: 'initiative', title: 'Init A' })).itemId;
  const initB = (await runPut(humanPort, { kind: 'initiative', title: 'Init B' })).itemId;
  const parentId = (await runPut(humanPort, { kind: 'issue', title: 'Parent Item', initiativeId: initA }))
    .itemId;

  // v1: created in browser.
  t.mock.timers.setTime(Date.parse('2026-11-18T11:00:00.000Z'));
  const itemId = (
    await runPut(humanPort, {
      kind: 'issue',
      title: 'Audit target',
      body: 'Intro paragraph.\n\n## Done when\n- [ ] Ship timeline\n- [ ] Add tests\n',
      initiativeId: initA,
    })
  ).itemId;

  // v2: agent edits title, body prose, sets waitingOn, owner, type and moves to initB + parentId + order.
  as({ subject: 'owner', forgeCredential: 'cred-1' });
  t.mock.timers.setTime(Date.parse('2026-11-18T12:00:00.000Z'));
  await runPut(agentPort, {
    planningItemId: itemId,
    expectedVersion: 1,
    title: 'Audit target v2',
    body: 'Updated intro paragraph.\n\n## Done when\n- [ ] Ship timeline\n- [ ] Add tests\n',
    initiativeId: initB,
    fields: {
      parentId,
      order: 'L000001V',
      owner: '@ada/lucky-hornet',
      type: 'task',
      waitingOn: { kind: 'evidence', reason: 'Need live counts' },
    },
  });

  // v3: agent ticks one Done-when checkbox only and clears waitingOn.
  t.mock.timers.setTime(Date.parse('2026-11-18T13:00:00.000Z'));
  await runPut(agentPort, {
    planningItemId: itemId,
    expectedVersion: 2,
    body: 'Updated intro paragraph.\n\n## Done when\n- [x] Ship timeline\n- [ ] Add tests\n',
    fields: { waitingOn: null },
  });

  // Comment (agent) + decision comment (browser, creating derived v4).
  t.mock.timers.setTime(Date.parse('2026-11-18T13:30:00.000Z'));
  const firstComment = await runComment(agentPort, { planningItemId: itemId, text: 'Started work.' });
  as({ subject: 'owner' });
  t.mock.timers.setTime(Date.parse('2026-11-18T14:00:00.000Z'));
  const decComment = await runComment(humanPort, {
    planningItemId: itemId,
    text: 'Keep timeline newest first.',
    decision: true,
    replyTo: firstComment.commentId,
  });

  // Lane + Landing + Revert on the Item's Intent (the Issue's planned Intent is already stored by create).
  const laneId = randomUUID();
  const receiptId = randomUUID();
  const revertReceiptId = randomUUID();
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    planningItemId: itemId,
    record: {
      kind: 'lane',
      id: laneId,
      version: 0,
      at: '2026-11-18T14:15:00.000Z',
      intentId: itemId,
      actor: 'owner',
      agentRun: 'lucky-hornet',
      agentClient: 'claude-code:claude-opus-5-5',
      base: { head: 'a'.repeat(64), receiptId: 'seed' },
      head: 'b'.repeat(64),
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'completed',
      authorityEpoch: 1,
    },
  });
  await notes.postIntentLandingNote(s.ctx, s.projectId, {
    intentId: itemId,
    itemId,
    receiptId,
    kind: 'landed',
    at: '2026-11-18T14:30:00.000Z',
    laneIds: [laneId],
    commit: 'c'.repeat(64),
    sequence: 10,
    actor: 'owner',
    agentRun: 'lucky-hornet',
    agentClient: 'claude-code:claude-opus-5-5',
    landedBy: { by: 'agent', review: 'none' },
  });
  await notes.postIntentLandingNote(s.ctx, s.projectId, {
    intentId: itemId,
    itemId,
    receiptId: revertReceiptId,
    kind: 'reverted',
    at: '2026-11-18T14:45:00.000Z',
    laneIds: [laneId],
    commit: 'd'.repeat(64),
    sequence: 11,
    actor: 'owner',
    revertOf: receiptId,
    landedBy: { by: 'person', review: 'person' },
  });

  // v5: close with reason, v6: reopen, v7: archive, v8: restore.
  as({ subject: 'owner', forgeCredential: 'cred-1' });
  t.mock.timers.setTime(Date.parse('2026-11-18T15:00:00.000Z'));
  await runPut(agentPort, {
    planningItemId: itemId,
    expectedVersion: 4,
    status: 'closed',
    reason: 'Done-when met',
  });
  as({ subject: 'owner' });
  t.mock.timers.setTime(Date.parse('2026-11-18T16:00:00.000Z'));
  await runPut(humanPort, {
    planningItemId: itemId,
    expectedVersion: 5,
    status: 'open',
    reason: 'Follow-up needed',
  });
  t.mock.timers.setTime(Date.parse('2026-11-18T17:00:00.000Z'));
  await runPut(humanPort, { planningItemId: itemId, expectedVersion: 6, status: 'archived' });
  t.mock.timers.setTime(Date.parse('2026-11-18T18:00:00.000Z'));
  await runPut(humanPort, { planningItemId: itemId, expectedVersion: 7, status: 'open' });

  // Single-call full timeline read (supports short 8-hex prefix too!).
  agentPort.calls.length = 0;
  const full = await runPlanning(agentPort, { planningItemId: itemId, history: true, limit: 100 });
  assert.deepEqual(agentPort.calls, ['projectHostedPlanning:itemHistory'], 'one bounded query call');
  assert.equal(full.itemId, itemId);
  assert.equal(full.historyStartsAt, '2026-11-18T11:00:00.000Z');
  assert.equal(full.firstVersion, 1);
  assert.equal(full.completeFromCreation, true);
  assert.equal(full.coverage, 'complete');
  assert.equal(full.nextCursor, null);
  assert.equal(full.events.length, 13, '8 versions + 2 comments + 1 lane + 1 landing + 1 revert');
  // Strictly newest first.
  for (let i = 1; i < full.events.length; i++)
    assert.ok(full.events[i - 1].at >= full.events[i].at, 'newest first ordering');

  const byVersion = new Map(full.events.filter(e => e.kind === 'version').map(e => [e.version, e]));
  assert.equal(byVersion.get(1).actor, 'ada');
  assert.equal(byVersion.get(1).actorKind, 'person');
  assert.equal(byVersion.get(1).changes[0].kind, 'created');

  const v2 = byVersion.get(2);
  assert.equal(v2.actor, 'ada/lucky-hornet');
  assert.equal(v2.actorKind, 'agent');
  assert.equal(v2.model, 'claude-opus-5-5');
  assert.deepEqual(v2.changes.map(c => c.kind).sort(), [
    'body',
    'move',
    'move',
    'move',
    'owner',
    'title',
    'type',
    'waiting-on',
  ]);

  const v3 = byVersion.get(3);
  assert.equal(v3.actor, 'ada/lucky-hornet');
  assert.deepEqual(
    v3.changes.map(c => c.kind),
    ['done-when', 'waiting-on'],
    'pure Done-when tick omits redundant body diff',
  );
  assert.deepEqual(v3.changes[0].ticked, ['Ship timeline']);
  assert.equal(v3.changes[1].action, 'cleared');

  assert.equal(byVersion.get(4).decisionCommentId, decComment.commentId);
  assert.equal(byVersion.get(5).changes[0].transition, 'closed');
  assert.equal(byVersion.get(5).changes[0].reason, 'Done-when met');
  assert.equal(byVersion.get(5).actor, 'ada/lucky-hornet');
  assert.equal(byVersion.get(6).changes[0].transition, 'reopened');
  assert.equal(byVersion.get(6).actor, 'ada');
  assert.equal(byVersion.get(6).actorKind, 'person');
  assert.equal(byVersion.get(7).changes[0].transition, 'archived');
  assert.equal(byVersion.get(7).changes[0].was, 'open');
  assert.equal(byVersion.get(8).changes[0].transition, 'restored');

  assert.ok(
    full.events.some(
      e => e.kind === 'comment' && e.decision === true && e.replyTo === firstComment.commentId,
    ),
  );
  assert.ok(full.events.some(e => e.kind === 'lane' && e.id === laneId && e.actor === 'ada/lucky-hornet'));
  assert.ok(full.events.some(e => e.kind === 'landing' && e.id === receiptId));
  assert.ok(
    full.events.some(e => e.kind === 'revert' && e.id === revertReceiptId && e.revertOf === receiptId),
  );

  // Page through with limit=3: exact match with full timeline, zero duplicates, zero skips.
  const paged = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = await runPlanning(agentPort, {
      planningItemId: itemId,
      history: true,
      limit: 3,
      cursor,
    });
    assert.ok(page.events.length <= 3);
    paged.push(...page.events);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(
    paged.map(e => `${e.kind}:${e.id}`),
    full.events.map(e => `${e.kind}:${e.id}`),
    'k-way paged timeline matches single-page timeline exactly',
  );

  // Terminal formatting helper produces readable lines.
  const lines = cliReplyLines(['agent', '.', 'planning'], { action: 'planning', result: full });
  assert.match(lines[0], /Audit target v2/);
  assert.ok(lines.length >= 14);

  // Older server without planning-audit refuses cleanly.
  const oldPort = makePort(s, { features: [...hostedContractFeatures, planningHistoryFeature] });
  await assert.rejects(
    runPlanning(oldPort, { planningItemId: itemId, history: true }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
});

test('backlog window view lists closed, reopened and changed Items per Initiative with shelf-restore exclusion and paging', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'cred-1' });
  const p = makePort(s, {
    commentAgent: () => ({ agent: 'amber-fox', agentClient: 'codex:gpt-5' }),
  });

  const initA = (await runPut(p, { kind: 'initiative', title: 'Alpha' })).itemId;
  const initB = (await runPut(p, { kind: 'initiative', title: 'Beta' })).itemId;

  // Before window (Nov 10): create closedItem, reopenItem, shelvedClosedItem, otherInitItem.
  const closedItem = (await runPut(p, { kind: 'issue', title: 'Will close', initiativeId: initA })).itemId;
  const reopenItem = (
    await runPut(p, { kind: 'issue', title: 'Will reopen', initiativeId: initA, status: 'closed' })
  ).itemId;
  const shelvedItem = (
    await runPut(p, { kind: 'issue', title: 'Shelved close', initiativeId: initA, status: 'closed' })
  ).itemId;
  await runPut(p, { planningItemId: shelvedItem, expectedVersion: 1, status: 'archived' });
  const otherItem = (await runPut(p, { kind: 'issue', title: 'In Beta', initiativeId: initB })).itemId;

  // Inside window (Nov 15 - Nov 18):
  t.mock.timers.setTime(Date.parse('2026-11-15T12:00:00.000Z'));
  await runPut(p, {
    planningItemId: closedItem,
    expectedVersion: 1,
    status: 'closed',
    reason: 'Shipped',
  });
  t.mock.timers.setTime(Date.parse('2026-11-16T12:00:00.000Z'));
  await runPut(p, {
    planningItemId: reopenItem,
    expectedVersion: 1,
    status: 'open',
    reason: 'Regressed',
  });
  // Restoring a shelved closed Item must NOT count as a new close.
  t.mock.timers.setTime(Date.parse('2026-11-17T12:00:00.000Z'));
  await runPut(p, { planningItemId: shelvedItem, expectedVersion: 2, status: 'closed' });
  // Edit in Beta.
  t.mock.timers.setTime(Date.parse('2026-11-18T12:00:00.000Z'));
  await runPut(p, { planningItemId: otherItem, expectedVersion: 1, title: 'In Beta edited' });

  // Outside window (Nov 20).
  t.mock.timers.setTime(Date.parse('2026-11-20T12:00:00.000Z'));
  const lateItem = (await runPut(p, { kind: 'issue', title: 'After window', initiativeId: initA })).itemId;
  void lateItem;

  // One bounded indexed read for initA [Nov 15..Nov 18].
  p.calls.length = 0;
  const allA = await runPlanning(p, {
    initiativeId: initA,
    history: { from: '2026-11-15', to: '2026-11-18' },
  });
  assert.deepEqual(p.calls, ['projectHostedPlanning:windowHistory']);
  assert.equal(allA.coverage, 'complete');
  assert.deepEqual(allA.counts, { total: 3, closed: 1, reopened: 1, created: 0, changed: 1 });
  const byId = new Map(allA.items.map(row => [row.itemId, row]));
  assert.deepEqual(byId.get(closedItem).events, ['closed']);
  assert.equal(byId.get(closedItem).closedAt, '2026-11-15T12:00:00.000Z');
  assert.equal(byId.get(closedItem).actor, 'ada/amber-fox');
  assert.deepEqual(byId.get(reopenItem).events, ['reopened']);
  assert.equal(byId.get(reopenItem).reopenedAt, '2026-11-16T12:00:00.000Z');
  assert.deepEqual(byId.get(shelvedItem).events, ['changed'], 'shelf restore is changed, not a new close');
  assert.equal(byId.get(shelvedItem).closedAt, null);

  // Filter change:'closed' and change:'reopened'.
  const onlyClosed = await runPlanning(p, {
    initiativeId: initA,
    history: { from: '2026-11-15', to: '2026-11-18', change: 'closed' },
  });
  assert.deepEqual(
    onlyClosed.items.map(i => i.itemId),
    [closedItem],
  );
  const onlyReopened = await runPlanning(p, {
    initiativeId: initA,
    history: { from: '2026-11-15', to: '2026-11-18', change: 'reopened' },
  });
  assert.deepEqual(
    onlyReopened.items.map(i => i.itemId),
    [reopenItem],
  );

  // Project-wide window read (no initiativeId) with paging (limit=2).
  const page1 = await runPlanning(p, {
    history: { from: '2026-11-15', to: '2026-11-18' },
    limit: 2,
  });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = await runPlanning(p, {
    history: { from: '2026-11-15', to: '2026-11-18' },
    limit: 2,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(
    [...page1.items, ...page2.items].map(i => i.itemId).sort(),
    [closedItem, reopenItem, shelvedItem, otherItem].sort(),
  );

  // Invalid window args refused.
  await assert.rejects(
    runPlanning(p, { history: { from: '2026-11-20', to: '2026-11-15' } }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(
    hostedAgentCommandSchemas.planning.safeParse({
      planningItemId: closedItem,
      history: { from: '2026-11-15' },
    }).success,
    false,
  );
  assert.equal(
    hostedAgentCommandSchemas.planning.safeParse({ kind: 'issue', history: { from: '2026-11-15' } }).success,
    false,
    'kind is refused on a window read instead of ignored',
  );
});

test('window read lists each Item once across scan pages, keeps its older close and ignores versions after `to`', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);
  const initiative = (await runPut(p, { kind: 'initiative', title: 'Gamma' })).itemId;
  const closer = (await runPut(p, { kind: 'issue', title: 'Closes then edits', initiativeId: initiative }))
    .itemId;
  const editor = (await runPut(p, { kind: 'issue', title: 'Edited once', initiativeId: initiative })).itemId;
  const at = iso => t.mock.timers.setTime(Date.parse(iso));
  at('2026-11-15T09:00:00.000Z');
  await runPut(p, { planningItemId: closer, expectedVersion: 1, status: 'closed', reason: 'Shipped' });
  at('2026-11-15T12:00:00.000Z');
  await runPut(p, { planningItemId: editor, expectedVersion: 1, title: 'Edited once!' });
  at('2026-11-16T09:00:00.000Z');
  await runPut(p, { planningItemId: closer, expectedVersion: 2, title: 'Closed and retitled' });
  // After the window: never listed, never spends the scan.
  at('2026-11-20T09:00:00.000Z');
  await runPut(p, { planningItemId: closer, expectedVersion: 3, status: 'open', reason: 'Later' });
  at('2026-11-21T09:00:00.000Z');

  const { readBacklogWindowAudit } = await import(moduleUrl('../convex/projectPlanningWindow.ts'));
  const project = await s.ctx.db.get(s.projectId);
  for (const initiativeId of [initiative, undefined]) {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await readBacklogWindowAudit(s.ctx, project, null, {
        ...(initiativeId ? { initiativeId } : {}),
        from: '2026-11-15',
        until: '2026-11-18',
        cursor,
        scanRows: 1,
      });
      assert.equal(page.window.until, '2026-11-18T23:59:59.999Z');
      seen.push(...page.items);
      cursor = page.nextCursor;
      assert.ok(++pages < 10, 'paging ends');
    } while (cursor);
    assert.deepEqual(seen.map(item => item.itemId).sort(), [closer, editor].sort(), 'each Item exactly once');
    const closed = seen.find(item => item.itemId === closer);
    assert.deepEqual(closed.events, ['closed', 'changed'], 'the older close survives the scan-page split');
    assert.equal(closed.closedAt, '2026-11-15T09:00:00.000Z');
    assert.equal(closed.reason, 'Shipped');
    assert.equal(closed.title, 'Closed and retitled', 'the newest in-window version, not the later reopen');
    assert.equal(closed.versionsInWindow, 2);
  }
});

test('an Item that moves out of an Initiative and back is listed once on an initiative-filtered window read (friction 0f1264b0)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);
  const home = (await runPut(p, { kind: 'initiative', title: 'Home' })).itemId;
  const away = (await runPut(p, { kind: 'initiative', title: 'Away' })).itemId;
  const wanderer = (await runPut(p, { kind: 'issue', title: 'Wanders', initiativeId: home })).itemId;
  const at = iso => t.mock.timers.setTime(Date.parse(iso));
  at('2026-11-15T09:00:00.000Z');
  await runPut(p, { planningItemId: wanderer, expectedVersion: 1, title: 'Wanders' + '!' });
  at('2026-11-15T10:00:00.000Z');
  await runPut(p, { planningItemId: wanderer, expectedVersion: 2, initiativeId: away });
  at('2026-11-15T11:00:00.000Z');
  await runPut(p, { planningItemId: wanderer, expectedVersion: 3, initiativeId: home });
  at('2026-11-21T09:00:00.000Z');
  const { readBacklogWindowAudit } = await import(moduleUrl('../convex/projectPlanningWindow.ts'));
  const project = await s.ctx.db.get(s.projectId);
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await readBacklogWindowAudit(s.ctx, project, null, {
      initiativeId: home,
      from: '2026-11-15',
      until: '2026-11-18',
      cursor,
      scanRows: 1,
    });
    seen.push(...page.items);
    cursor = page.nextCursor;
    assert.ok(++pages < 10, 'paging ends');
  } while (cursor);
  assert.deepEqual(
    seen.map(item => item.itemId),
    [wanderer],
    'listed once',
  );
});

test('window rows list the Decisions lines dated in the window across Items, without extra reads', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);
  const first = (await runPut(p, { kind: 'issue', title: 'Decided twice' })).itemId;
  const second = (await runPut(p, { kind: 'issue', title: 'Decided once' })).itemId;
  const quiet = (await runPut(p, { kind: 'issue', title: 'Only edited' })).itemId;
  const at = iso => t.mock.timers.setTime(Date.parse(iso));
  at('2026-11-12T08:00:00.000Z');
  await runComment(p, { planningItemId: first, text: 'Before the window.', decision: true });
  at('2026-11-16T09:00:00.000Z');
  await runComment(p, {
    planningItemId: first,
    text: 'Ship the filter first.\n\nLonger reasoning.',
    decision: true,
  });
  at('2026-11-17T09:00:00.000Z');
  await runComment(p, { planningItemId: second, text: 'Park the rest.', decision: true });
  await runComment(p, { planningItemId: quiet, text: 'Plain discussion is not a decision.' });
  await runPut(p, { planningItemId: quiet, expectedVersion: 1, title: 'Only edited!' });
  at('2026-11-19T09:00:00.000Z');
  await runComment(p, { planningItemId: first, text: 'After the window.', decision: true });

  p.calls.length = 0;
  const read = await runPlanning(p, { history: { from: '2026-11-15', to: '2026-11-18' } });
  assert.deepEqual(p.calls, ['projectHostedPlanning:windowHistory'], 'one read, no per-Item calls');
  const byId = new Map(read.items.map(row => [row.itemId, row]));
  assert.deepEqual(
    byId.get(first).decisions.map(({ date, text }) => [date, text]),
    [['2026-11-16', 'Ship the filter first.']],
    'only the in-window line, first paragraph, none from before or after',
  );
  assert.match(byId.get(first).decisions[0].comment, /^[0-9a-f]{8}$/);
  assert.deepEqual(
    byId.get(second).decisions.map(({ date, text }) => [date, text]),
    [['2026-11-17', 'Park the rest.']],
  );
  assert.equal('decisions' in byId.get(quiet), false, 'an Item without Decisions lines has no field');
});

test('decisionsInWindow keeps UTC-day lines, the newest max and ignores other sections', async () => {
  const { decisionsInWindow } = await import('../dist/work-planning-put.js');
  const body = [
    'Intro',
    '- 2026-11-01: not a decision',
    '## Decisions',
    '- 2026-11-14 @owner: too early (comment aaaaaaaa)',
    '- 2026-11-15 @lead/amber-fox: on the first day (comment bbbbbbbb)',
    '- 2026-11-16: no actor (comment cccccccc)',
    '- 2026-11-18: last day',
    '- 2026-11-19: too late',
    'prose line',
    '## Notes',
    '- 2026-11-16: not under Decisions',
  ].join('\n');
  const from = Date.parse('2026-11-15T13:00:00.000Z');
  const until = Date.parse('2026-11-18T01:00:00.000Z');
  const all = decisionsInWindow(body, from, until);
  assert.deepEqual(
    all.decisions.map(d => d.date),
    ['2026-11-15', '2026-11-16', '2026-11-18'],
    'a day counts when any part of it overlaps the window',
  );
  assert.equal(all.decisions[0].label, '@lead/amber-fox');
  assert.equal(all.decisions[1].label, undefined);
  assert.equal(all.decisions[2].comment, undefined);
  const capped = decisionsInWindow(body, from, until, 2);
  assert.deepEqual(
    capped.decisions.map(d => d.date),
    ['2026-11-16', '2026-11-18'],
  );
  assert.equal(capped.omitted, 1);
  assert.deepEqual(decisionsInWindow('no section here', from, until), { decisions: [], omitted: 0 });
  const odd = [
    '## Decisions',
    '```',
    '- 2026-11-16: inside a fence',
    '```',
    '- 2026-11-31: not a calendar day',
    '- 2026-11-16 @x:  (comment ABCDEF12)',
    '- 2026-11-17 @x: upper id (comment ABCDEF12)',
    '- 2026-11-18: newest listed first',
    '- 2026-11-15: older',
    '   ## Notes',
    '- 2026-11-16: after an indented heading',
  ].join('\n');
  const parsed = decisionsInWindow(odd, from, until);
  assert.deepEqual(
    parsed.decisions.map(d => [d.date, d.text, d.comment]),
    [
      ['2026-11-15', 'older', undefined],
      ['2026-11-16', '', 'abcdef12'],
      ['2026-11-17', 'upper id', 'abcdef12'],
      ['2026-11-18', 'newest listed first', undefined],
    ],
    'order and the cap follow dates, not body order; empty text keeps its comment id',
  );
  assert.deepEqual(
    decisionsInWindow(odd, from, until, 1).decisions.map(d => d.date),
    ['2026-11-18'],
  );
});

test('window read names where imported records begin and flags Items recorded after they changed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);
  const old = (await runPut(p, { kind: 'issue', title: 'Made before the import' })).itemId;
  t.mock.timers.setTime(Date.parse('2026-11-02T10:00:00.000Z'));
  await runPut(p, { planningItemId: old, expectedVersion: 1, status: 'closed', reason: 'Done early' });
  // The import writes these versions to the store on Nov 10; their bodies keep the real dates.
  const imported = Date.parse('2026-11-10T01:00:00.000Z');
  let offset = 0;
  for (const row of s.tables.projectHostedRecords.values())
    if (row.kind === 'issue' && row.key === old) row._creationTime = imported + offset++;
  t.mock.timers.setTime(Date.parse('2026-11-12T10:00:00.000Z'));
  const fresh = (await runPut(p, { kind: 'issue', title: 'Made after the import' })).itemId;
  t.mock.timers.setTime(Date.parse('2026-11-13T10:00:00.000Z'));

  const { readBacklogWindowAudit } = await import(moduleUrl('../convex/projectPlanningWindow.ts'));
  const project = await s.ctx.db.get(s.projectId);
  const read = (from, until) => readBacklogWindowAudit(s.ctx, project, null, { from, until });
  const before = await read('2026-10-01', '2026-11-05');
  assert.equal(before.items.length, 0);
  assert.equal(before.coverage, 'partial', 'an empty window before the store began is not complete');
  assert.equal(before.recordsFrom, '2026-11-10T01:00:00.000Z');
  const burst = await read('2026-11-10', '2026-11-10');
  assert.deepEqual(
    burst.items.map(item => item.itemId),
    [old],
  );
  assert.equal(burst.items[0].at, '2026-11-02T10:00:00.000Z', 'the real date, not the import time');
  assert.equal(burst.items[0].recordedAt, '2026-11-10T01:00:00.001Z');
  assert.equal(burst.recordedLater, 1);
  assert.equal(burst.coverage, 'partial');
  const after = await read('2026-11-11', '2026-11-13');
  assert.deepEqual(
    after.items.map(item => item.itemId),
    [fresh],
  );
  assert.equal(after.items[0].recordedAt, undefined);
  assert.equal(after.recordedLater, 0);
  assert.equal(after.coverage, 'complete');
});

test('Item timeline pages every version past lifecycle-plan rows that share its key and version', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);
  const itemId = (await runPut(p, { kind: 'issue', title: 'Many versions' })).itemId;
  for (let version = 1; version < 6; version++) {
    t.mock.timers.setTime(Date.parse(`2026-11-18T1${version}:00:00.000Z`));
    await runPut(p, { planningItemId: itemId, expectedVersion: version, title: `Many versions ${version}` });
  }
  // A purge plan's copies of versions 5 and 4 sit beside the real rows in the version index.
  for (const { _id, _creationTime, ...row } of [...s.tables.projectHostedRecords.values()].filter(
    r => r.kind === 'issue' && r.key === itemId && (r.version === 5 || r.version === 4),
  ))
    await s.ctx.db.insert('projectHostedRecords', { ...row, lifecyclePlanId: 'plan-1' });
  const versions = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = await runPlanning(p, { planningItemId: itemId, history: true, limit: 2, cursor });
    versions.push(...page.events.filter(e => e.kind === 'version').map(e => e.version));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(versions, [6, 5, 4, 3, 2, 1], 'every version once, newest first');
});

test('serverPutWriter enforces credential-based agent attribution, pre-deploy retry safety and bounded byte delta', async t => {
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  const as = identity => {
    s.ctx.auth.getUserIdentity = async () => identity;
  };
  const sendCmd = async (command, identity) => {
    as(identity);
    return workCommand.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: command.operationId,
      command: JSON.stringify(command),
    });
  };

  // Browser sign-in strips forged agent/agentClient (0 extra bytes).
  const itemId = randomUUID();
  await sendCmd(
    {
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId,
      expectedVersion: 0,
      kind: 'issue',
      title: 'Writer rules',
      agent: 'forged-slug',
      agentClient: 'claude-code:forged',
    },
    { subject: 'owner' },
  );
  const browserRows = [...s.tables.projectHostedRecords.values()].filter(
    r => r.kind === 'issue' && r.key === itemId,
  );
  const v1Item = JSON.parse(browserRows[0].inline).item;
  assert.equal(v1Item.agent, undefined);
  assert.equal(v1Item.agentClient, undefined);
  const browserBytes = browserRows[0].bytes;

  // Device credential without slug gets deterministic fallback slug; with slug+model keeps both.
  await sendCmd(
    {
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId,
      expectedVersion: 1,
      status: 'in-progress',
    },
    { subject: 'owner', forgeCredential: 'cred-1' },
  );
  const v2Row = [...s.tables.projectHostedRecords.values()].find(
    r => r.kind === 'issue' && r.key === itemId && r.version === 2,
  );
  const v2Item = JSON.parse(v2Row.inline).item;
  assert.ok(isAgentSlug(v2Item.agent), 'device without slug gets deterministic word-pair slug');
  assert.equal(v2Item.agentClient, undefined);

  await sendCmd(
    {
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId,
      expectedVersion: 2,
      status: 'closed',
      agent: 'lucky-hornet',
      agentClient: 'antigravity:gemini-4-neon',
    },
    { subject: 'owner', forgeCredential: 'cred-1' },
  );
  const v3Row = [...s.tables.projectHostedRecords.values()].find(
    r => r.kind === 'issue' && r.key === itemId && r.version === 3,
  );
  const v3Item = JSON.parse(v3Row.inline).item;
  assert.equal(v3Item.agent, 'lucky-hornet');
  assert.equal(v3Item.agentClient, 'antigravity:gemini-4-neon');

  // Measure exact byte delta on canonical version record for identical payload with vs without agent attribution.
  const withoutAgentBytes = Buffer.byteLength(
    JSON.stringify({ ...v3Item, agent: undefined, agentClient: undefined }),
  );
  const withAgentBytes = Buffer.byteLength(JSON.stringify(v3Item));
  const delta = withAgentBytes - withoutAgentBytes;
  assert.ok(delta > 0 && delta <= 160, `bounded agent attribution delta: ${delta} bytes`);
  t.diagnostic(
    JSON.stringify({
      browserRecordBytes: browserBytes,
      versionWithoutAgentBytes: withoutAgentBytes,
      versionWithAgentBytes: withAgentBytes,
      agentDeltaBytes: delta,
    }),
  );

  // Batch put from device also stamps agent & agentClient.
  const batchPort = makePort(s, {
    commentAgent: () => ({ agent: 'lucky-hornet', agentClient: 'claude-code:claude-opus-5-5' }),
  });
  as({ subject: 'owner', forgeCredential: 'cred-1' });
  await runPut(batchPort, {
    batch: [{ itemId, expectedVersion: 3, status: 'open', reason: 'Batch reopen' }],
  });
  const v4Row = [...s.tables.projectHostedRecords.values()].find(
    r => r.kind === 'issue' && r.key === itemId && r.version === 4,
  );
  assert.equal(JSON.parse(v4Row.inline).item.agent, 'lucky-hornet');

  // Pre-deploy retry compatibility: a put written before serverPutWriter (no agent) replays safely from a device.
  const preDeployOp = randomUUID();
  const preDeployPut = {
    action: 'put-planning-item',
    operationId: preDeployOp,
    itemId,
    expectedVersion: 4,
    status: 'closed',
  };
  const first = await sendCmd(preDeployPut, { subject: 'owner' });
  const replayed = await sendCmd(preDeployPut, { subject: 'owner', forgeCredential: 'cred-1' });
  assert.equal(replayed.operationId, first.operationId);
  assert.equal(replayed.revision, first.revision);
  await assert.rejects(
    sendCmd({ ...preDeployPut, status: 'abandoned' }, { subject: 'owner', forgeCredential: 'cred-1' }),
    code('WORK_OPERATION_CHANGED'),
  );

  // Server-scheduled member start move records reason 'Lane started' without agent or raw actor.
  const openId = randomUUID();
  await sendCmd(
    {
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId: openId,
      expectedVersion: 0,
      kind: 'issue',
      title: 'Member start',
    },
    { subject: 'owner' },
  );
  as(null);
  await startMove._handler(s.ctx, {
    projectId: s.projectId,
    owner: 'owner',
    itemId: openId,
    actor: 'writer',
    startOperationId: randomUUID(),
  });
  const movedRow = [...s.tables.projectHostedRecords.values()].find(
    r => r.kind === 'issue' && r.key === openId && r.version === 2,
  );
  const moved = JSON.parse(movedRow.inline).item;
  assert.equal(moved.status, 'in-progress');
  assert.equal(moved.reason, 'Lane started');
  assert.equal(moved.agent, undefined);
});

test('audit reads enforce membership and public-identity rules across signed-out, stranger, reader, writer and owner', async t => {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  project.visibility = 'public';
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  const as = identity => {
    s.ctx.auth.getUserIdentity = async () => identity;
  };
  as({ subject: 'owner', forgeCredential: 'cred-1' });
  const p = makePort(s, {
    commentAgent: () => ({ agent: 'lucky-hornet', agentClient: 'claude-code:claude-opus-5-5' }),
  });
  const initId = (await runPut(p, { kind: 'initiative', title: 'Public Init' })).itemId;
  const visibleId = (await runPut(p, { kind: 'issue', title: 'Visible Item', initiativeId: initId })).itemId;
  const hiddenId = (
    await runPut(p, { kind: 'issue', title: 'Secret Item', initiativeId: initId, fields: { hidden: true } })
  ).itemId;
  await runPut(p, { planningItemId: visibleId, expectedVersion: 1, fields: { owner: '@ada/lucky-hornet' } });

  // Signed-out and signed-in stranger are refused identically on visible, hidden and absent Items.
  for (const viewer of [null, { subject: 'stranger' }]) {
    as(viewer);
    for (const id of [visibleId, hiddenId, randomUUID()]) {
      await assert.rejects(
        hostedPlanning.itemHistory._handler(s.ctx, { projectId: s.projectId, itemId: id }),
        code('PROJECT_UNAVAILABLE'),
      );
    }
    await assert.rejects(
      hostedPlanning.windowHistory._handler(s.ctx, {
        projectId: s.projectId,
        initiativeId: initId,
        from: '2026-01-01',
      }),
      code('PROJECT_UNAVAILABLE'),
    );
  }

  // Reader (project member, read-only): allowed, sees agent slug & model, NEVER sees owner's handle or raw id.
  as({ subject: 'reader' });
  const readerItem = JSON.parse(
    await hostedPlanning.itemHistory._handler(s.ctx, { projectId: s.projectId, itemId: visibleId }),
  );
  const readerWindow = JSON.parse(
    await hostedPlanning.windowHistory._handler(s.ctx, {
      projectId: s.projectId,
      initiativeId: initId,
      from: '2020-01-01',
    }),
  );
  for (const payload of [readerItem, readerWindow]) {
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /\bada\b/, 'reader never sees person handle');
    assert.match(serialized, /lucky-hornet/, 'reader still sees agent slug');
    assert.match(serialized, /claude-opus-5-5/, 'reader still sees declared model');
  }
  assert.ok(
    readerItem.events.every(e => e.actor === undefined),
    'reader never sees actor handle or raw account id on timeline events',
  );
  assert.equal(
    readerItem.events[0].changes[0].after.owner,
    undefined,
    'reader never sees owner handle inside owner change',
  );
  assert.ok(
    readerWindow.items.every(i => i.actor === undefined),
    'reader never sees actor handle or raw account id on window items',
  );

  // Writer & owner see public handle 'ada/lucky-hornet', never raw account id 'owner'.
  for (const member of ['writer', 'owner']) {
    as({ subject: member });
    const reply = JSON.parse(
      await hostedPlanning.itemHistory._handler(s.ctx, { projectId: s.projectId, itemId: visibleId }),
    );
    assert.equal(reply.events[0].actor, 'ada/lucky-hornet');
    assert.doesNotMatch(JSON.stringify(reply.events.map(e => e.actor)), /"owner"/);
  }
});

test('Item audit reads without a mode marker and returns durable purge tombstones', async t => {
  const s = await setup(t);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const p = makePort(s);

  // A project without a mode marker still serves its canonical Item history and date window.
  const legacyId = (await runPut(p, { kind: 'issue', title: 'Legacy tracked' })).itemId;
  await runPut(p, { planningItemId: legacyId, expectedVersion: 1, status: 'closed', reason: 'Legacy close' });
  const legacyHist = await runPlanning(p, { planningItemId: legacyId, history: true });
  assert.equal(legacyHist.completeFromCreation, true);
  assert.equal(legacyHist.events.length, 2);
  assert.equal(legacyHist.events[0].changes[0].transition, 'closed');
  const legacyWin = await runPlanning(p, { history: { from: '2020-01-01' } });
  assert.notEqual(legacyWin.coverage, 'unavailable');
  assert.equal(
    legacyWin.items.some(item => item.itemId === legacyId),
    true,
  );

  // Purged Item on records project: returns tombstone without throwing PLANNING_ITEM_PURGED.
  beginRetainedWork(s);
  const purgedId = (await runPut(p, { kind: 'issue', title: 'Will purge' })).itemId;
  await runPut(p, { planningItemId: purgedId, expectedVersion: 1, status: 'deleted' });
  const purgeOp = randomUUID();
  const { purgeFromServer } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const { itemRows, purgeList } = await import('./planning-purge-fixture.mjs');
  const allEvents = [...s.tables.projectHostedRecordBodies.values()].filter(b => b.operationId);
  await purgeFromServer._handler(s.ctx, {
    projectId: s.projectId,
    operationId: purgeOp,
    owner: 'owner',
    command: JSON.stringify({
      action: 'purge-planning-item',
      operationId: purgeOp,
      itemId: purgedId,
      kind: 'issue',
      expectedVersion: 2,
      deletedAt: '2026-11-22T00:00:00.000Z',
      rows: purgeList(itemRows(allEvents, [purgedId])),
    }),
  });
  const purgedHist = await runPlanning(p, { planningItemId: purgedId, history: true });
  assert.equal(purgedHist.coverage, 'purged');
  assert.equal(purgedHist.events[0].changes[0].kind, 'purged');
  assert.equal(purgedHist.events[0].actor, 'ada');
});

test('Lead 2026-11-22: every agent-made Item change (tick, put, comment, decision, start) records its declared model or says "not declared"', async t => {
  const baseTime = Date.parse('2026-11-22T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: baseTime });
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-audit-model-'));
  const envKeys = [
    'XDG_STATE_HOME',
    'FORGE_AGENT_MODEL',
    'FORGE_AGENT_SESSION',
    'FORGE_HUMAN',
    'ANTHROPIC_MODEL',
    'GEMINI_MODEL',
    ...AGENT_CLIENTS.map(client => client.sessionVariable).filter(Boolean),
  ];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });
  const setEnv = vars => {
    for (const key of envKeys) delete process.env[key];
    process.env.XDG_STATE_HOME = stateDir;
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  };

  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'cred-1' });
  installPlanningSearch(s);

  const calls = [];
  let intentState = null;
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'projectHostedAgent:capabilities')
      return JSON.stringify({
        schema: 1,
        protocolVersion: 1,
        projectId: s.projectId,
        actor: 'owner',
        authority: { mode: 'server', epoch: 1 },
        actions: ['planning', 'put-planning-item', 'comment-planning-item', 'start'],
        mainReady: true,
        sourceWorkerConfigured: true,
        checkCallbackConfigured: true,
        nativeOwnerRequired: false,
        observation: 'finite',
        features: advertisedFeatures(args.features ?? []),
      });
    if (name === 'projectHostedPlanning:intentStates')
      return JSON.stringify(intentState ? Object.fromEntries(args.ids.map(id => [id, intentState])) : {});
    if (name === 'projectItemWork:read')
      return JSON.stringify({
        role: true,
        intent: intentState,
        intents: 1,
        lanes: [],
        total: 0,
        atLeast: false,
        nextCursor: null,
      });
    const [mod, fn] = name.split(':');
    const handler = {
      projectWorkIndex: index,
      projectHostedPlanning: hostedPlanning,
      projectWorkCommand: workCommand,
      projectPlanningBatch: planningBatch,
      projectItemWork: itemWork,
    }[mod][fn];
    return handler._handler(s.ctx, args);
  };
  const address = { url: 'https://fixture.invalid', projectId: s.projectId };
  const makeTransport = agentSession => {
    const client = {
      query: (ref, args) => invoke(getFunctionName(ref), args),
      mutation: (ref, args) => invoke(getFunctionName(ref), args),
    };
    const tr = new HostedAgentTransport(s.directory, address, { client, projectId: s.projectId });
    if (agentSession !== undefined) tr.agentSession = agentSession;
    return tr;
  };

  // 1. Create an Item with two Done-when boxes via HostedAgentTransport with FORGE_AGENT_MODEL (even with no harness).
  setEnv({ FORGE_AGENT_MODEL: 'synth-forge-model' });
  const created = (
    await makeTransport(undefined).dispatch('put-planning-item', {
      kind: 'issue',
      title: 'Model audit target',
      body: 'Scope.\n\n## Done when\n- [ ] First check\n- [ ] Second check\n',
    })
  ).result;
  const itemId = created.itemId;

  // 2. Run tick-planning-item through HostedAgentTransport: negotiates planning-audit and stamps
  //    checkbox-tick version, evidence decision comment AND derived Decisions version with the model.
  t.mock.timers.setTime(Date.parse('2026-11-22T12:10:00.000Z'));
  calls.length = 0;
  const tickSession = `tick-${randomUUID()}`;
  const ticked = (
    await makeTransport(tickSession).dispatch('tick-planning-item', {
      planningItemId: itemId,
      line: 1,
      evidence: 'Verified line 1.',
    })
  ).result;
  assert.equal(ticked.version, 2);
  assert.equal(
    calls.filter(c => c === 'projectWorkCommand:command').length,
    2,
    'exactly 2 mutations (body tick + decision comment), 0 extra Convex calls',
  );

  // Inspect stored versions v1, v2 (tick), v3 (derived Decisions body) directly.
  const versionItem = ver => {
    const row = [...s.tables.projectHostedRecords.values()].find(
      r => r.kind === 'issue' && r.key === itemId && r.version === ver,
    );
    const raw = row.inline ?? s.tables.projectHostedRecordBodies.get(row.bodyId)?.value;
    return JSON.parse(raw).item;
  };
  assert.ok(isAgentSlug(versionItem(1).agent), 'create with only FORGE_AGENT_MODEL gets an agent slug');
  assert.match(versionItem(1).agentClient, /:synth-forge-model$/);
  assert.ok(isAgentSlug(versionItem(2).agent), 'tick body put records agent slug');
  assert.match(versionItem(2).agentClient, /:synth-forge-model$/, 'tick body put records declared model');
  assert.ok(isAgentSlug(versionItem(3).agent), 'derived Decisions version records agent slug');
  assert.match(
    versionItem(3).agentClient,
    /:synth-forge-model$/,
    'derived Decisions version records declared model directly (for windowHistory & cross-page reads)',
  );

  // 3. Session-inherited model (declared once at start, then put with NO model env var).
  const ancestor = nearestAgentProcess();
  const inheritedKey = `inherited-${randomUUID()}`;
  const inheritedEnv = ancestor
    ? ancestor.sessionVariable
      ? { FORGE_AGENT_SESSION: inheritedKey, [ancestor.sessionVariable]: inheritedKey }
      : {}
    : { CODEX_THREAD_ID: inheritedKey };
  setEnv(inheritedEnv);
  const startStamp = agentAuthorship({ model: 'inherited-from-start', required: true }, process.env);
  assert.match(startStamp.agentClient, /:inherited-from-start$/);
  t.mock.timers.setTime(Date.parse('2026-11-22T12:20:00.000Z'));
  // markPlanningStarted (used by start {planningItemId}) stamps the start's model on the in-progress put.
  const startPort = makePort(s, {
    commentAgent: () => ({ agent: startStamp.agentRun, agentClient: startStamp.agentClient }),
  });
  const started = await markPlanningStarted(startPort, itemId, randomUUID(), `ada/${startStamp.agentRun}`);
  assert.equal(started.updated, true);
  assert.equal(versionItem(4).agent, startStamp.agentRun);
  assert.match(versionItem(4).agentClient, /:inherited-from-start$/);
  // Subsequent plain put-planning-item in the same session inherits the start's model with no model env var.
  t.mock.timers.setTime(Date.parse('2026-11-22T12:25:00.000Z'));
  await makeTransport(undefined).dispatch('put-planning-item', {
    planningItemId: itemId,
    expectedVersion: 4,
    title: 'Model audit target (inherited)',
  });
  assert.match(versionItem(5).agentClient, /:inherited-from-start$/);

  // 4. Held advice is a read, not an audit event attributed to whoever opened the Item.
  t.mock.timers.setTime(Date.parse('2026-11-22T12:30:00.000Z'));
  intentState = 'completed';
  calls.length = 0;
  await makeTransport(undefined).dispatch('planning', { planningItemId: itemId, reconcile: true });
  assert.ok(!calls.includes('projectWorkCommand:command'));
  intentState = null;

  // 5. Agent with NO declared model anywhere: stored agentClient has no fake model, and audit reads say 'not declared'.
  setEnv({});
  const undeclaredSession = `undeclared-${randomUUID()}`;
  t.mock.timers.setTime(Date.parse('2026-11-22T12:40:00.000Z'));
  await makeTransport(undeclaredSession).dispatch('tick-planning-item', {
    planningItemId: itemId,
    line: 2,
    evidence: 'Verified line 2 without a model env.',
  });
  assert.ok(isAgentSlug(versionItem(6).agent));
  assert.equal(versionItem(6).agentClient, undefined, 'no fake model id is stored');
  assert.ok(isAgentSlug(versionItem(7).agent));
  assert.equal(versionItem(7).agentClient, undefined);

  // Also add an undeclared agent Lane and landing note, plus a browser (person) edit.
  const laneId = randomUUID();
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    record: {
      kind: 'lane',
      id: laneId,
      version: 0,
      at: '2026-11-22T12:45:00.000Z',
      intentId: itemId,
      actor: 'owner',
      agentRun: 'amber-fox',
      agentClient: 'claude-code',
      base: { head: 'a'.repeat(64), receiptId: 'seed' },
      head: 'b'.repeat(64),
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      authorityEpoch: 1,
    },
  });
  await notes.postIntentLandingNote(s.ctx, s.projectId, {
    intentId: itemId,
    itemId,
    receiptId: randomUUID(),
    kind: 'landed',
    at: '2026-11-22T12:46:00.000Z',
    laneIds: [laneId],
    commit: 'c'.repeat(64),
    sequence: 12,
    actor: 'owner',
    agentRun: 'amber-fox',
    agentClient: 'claude-code',
    landedBy: { by: 'agent', review: 'none' },
  });
  const sluglessLandingId = randomUUID();
  await notes.postIntentLandingNote(s.ctx, s.projectId, {
    intentId: itemId,
    itemId,
    receiptId: sluglessLandingId,
    kind: 'landed',
    at: '2026-11-22T12:47:00.000Z',
    laneIds: [laneId],
    commit: 'd'.repeat(64),
    sequence: 13,
    actor: 'owner',
    landedBy: { by: 'agent', review: 'none' },
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  t.mock.timers.setTime(Date.parse('2026-11-22T12:50:00.000Z'));
  await runPut(makePort(s), { planningItemId: itemId, expectedVersion: 7, title: 'Browser edit' });

  // Read full Item timeline: EVERY agent event has a non-empty model (declared or 'not declared'); person has null.
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'cred-1' });
  const history = (
    await makeTransport(undefined).dispatch('planning', { planningItemId: itemId, history: true, limit: 100 })
  ).result;
  const agentEvents = history.events.filter(e => e.actorKind === 'agent');
  assert.ok(
    agentEvents.length >= 10,
    `expected agent events across versions/comments/lane/landing, got ${agentEvents.length}`,
  );
  for (const event of agentEvents) {
    assert.ok(
      typeof event.model === 'string' && event.model.length > 0,
      `${event.kind} ${event.id} must never have an empty model, got ${JSON.stringify(event.model)}`,
    );
  }
  const byVersion = new Map(history.events.filter(e => e.kind === 'version').map(e => [e.version, e]));
  assert.equal(byVersion.get(1).model, 'synth-forge-model');
  assert.equal(byVersion.get(2).model, 'synth-forge-model');
  assert.equal(byVersion.get(3).model, 'synth-forge-model');
  assert.equal(byVersion.get(4).model, 'inherited-from-start');
  assert.equal(byVersion.get(5).model, 'inherited-from-start');
  assert.equal(byVersion.get(6).model, 'not declared');
  assert.equal(byVersion.get(7).model, 'not declared');
  assert.equal(byVersion.get(8).actorKind, 'person');
  assert.equal(byVersion.get(8).model, null, 'person edits have null model');
  const laneEvent = history.events.find(e => e.kind === 'lane');
  const landingEvents = history.events.filter(e => e.kind === 'landing');
  assert.equal(laneEvent.model, 'not declared');
  assert.equal(landingEvents.length, 2);
  for (const landing of landingEvents) {
    assert.equal(landing.actorKind, 'agent');
    assert.equal(landing.model, 'not declared');
  }

  // Cross-page timeline read (limit=1): derived Decisions version v3 keeps its model even without its comment on the page.
  let pageCursor = null;
  let pagedV3 = null;
  for (let guard = 0; guard < 30; guard++) {
    const page = (
      await makeTransport(undefined).dispatch('planning', {
        planningItemId: itemId,
        history: true,
        limit: 1,
        cursor: pageCursor,
      })
    ).result;
    const hit = page.events.find(e => e.kind === 'version' && e.version === 3);
    if (hit) {
      pagedV3 = hit;
      break;
    }
    pageCursor = page.nextCursor;
    if (!pageCursor) break;
  }
  assert.ok(pagedV3, 'found derived Decisions version v3 while paging 1 event at a time');
  assert.equal(pagedV3.actorKind, 'agent');
  assert.equal(pagedV3.model, 'synth-forge-model');

  // Backlog window read for the undeclared agent version (before the browser edit) says 'not declared'.
  const windowUndeclared = (
    await makeTransport(undefined).dispatch('planning', {
      history: { from: '2026-11-22T12:00:00Z', to: '2026-11-22T12:42:00Z' },
    })
  ).result;
  const winItem = windowUndeclared.items.find(i => i.itemId === itemId);
  assert.equal(winItem.actorKind, 'agent');
  assert.equal(winItem.model, 'not declared');

  // Backlog window read ending at v3 (tick's derived Decisions version) reports 'synth-forge-model'.
  const windowTick = (
    await makeTransport(undefined).dispatch('planning', {
      history: { from: '2026-11-22T12:00:00Z', to: '2026-11-22T12:15:00Z' },
    })
  ).result;
  const winTickItem = windowTick.items.find(i => i.itemId === itemId);
  assert.equal(winTickItem.actorKind, 'agent');
  assert.equal(winTickItem.model, 'synth-forge-model');

  // Terminal formatting prints both declared model and '(not declared)', and omits model for person.
  const lines = cliReplyLines(['agent', '.', 'planning'], { action: 'planning', result: history });
  assert.ok(lines.some(line => line.includes('(synth-forge-model)')));
  assert.ok(lines.some(line => line.includes('(not declared)')));
});

test('the Item audit pages landing notes by landing time: landings written late for old receipts stay in order across pages', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T10:00:00.000Z') });
  const s = await setup(t);
  beginRetainedWork(s);
  addDeviceAndAccounts(s);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const port = makePort(s);
  const itemId = (await runPut(port, { kind: 'issue', title: 'Late landing notes' })).itemId;
  const post = (day, label) =>
    notes.postIntentLandingNote(s.ctx, s.projectId, {
      intentId: itemId,
      itemId,
      receiptId: `${label}-${randomUUID()}`,
      kind: 'landed',
      at: `2026-11-${day}T12:00:00.000Z`,
      laneIds: [],
      commit: 'c'.repeat(64),
      sequence: Number(day),
      actor: 'owner',
      landedBy: { by: 'agent', review: 'none' },
    });
  // Recent landings first, then a conversion writes the older ones last (their rows are the newest).
  for (const day of ['20', '21', '22', '23', '24', '25']) await post(day, 'recent');
  for (const day of ['02', '03', '04', '05', '06', '07']) await post(day, 'converted');
  const landingDays = [];
  let cursor;
  for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
    const page = await runPlanning(port, { planningItemId: itemId, history: true, limit: 4, cursor });
    landingDays.push(...page.events.filter(e => e.kind === 'landing').map(e => e.at.slice(8, 10)));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(landingDays, ['25', '24', '23', '22', '21', '20', '07', '06', '05', '04', '03', '02']);
});
