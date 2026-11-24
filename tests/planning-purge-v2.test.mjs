// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Purge Lane 2 readers (Item 4c9e961e, lead decision 2bce94e5, follow-ups a-f of reviews e0720f64 and 327b1600):
// planning-purge-v2. A purge lists every row of its Item with the digest of its redacted facts; purged rows include an
// Intent-born Item's intent and note rows and writes through another id; a redacted command keeps only listed fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { workRecordRows } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { itemRows, markPurged, purgeList } from './planning-purge-fixture.mjs';
import { applyHostedEvent, metadataRequest } from '../dist/work-metadata.js';
import { parseWork } from '../dist/work-unified-types.js';
import {
  purgeFieldClasses,
  purgeableCommandSchema,
  purgedFactsDigest,
  purgedFactsSchema,
  redactPlanningWrite,
} from '../dist/work-intent-types.js';
import { applyCommentPurge, checkPurgedJournal, purgedIndexValue } from '../dist/work-planning-purge.js';
import { planningLineEvidence } from '../dist/planning-line-evidence.js';
import { decisionOperationId } from '../dist/work-planning-put.js';
import { purgedDecisionRequest } from '../dist/work-planning-state.js';

const code = expected => error => (error.data?.code ?? error.code) === expected;
const SECRET = 'okapi-purge-v2-fixture';
const { purgeFromServer } = await import(moduleUrl('../convex/projectWorkCommand.ts'));

async function purge(s, itemId, kind, expectedVersion, ids = [itemId]) {
  const command = {
    action: 'purge-planning-item',
    operationId: randomUUID(),
    itemId,
    kind,
    expectedVersion,
    deletedAt: '2026-11-20T00:00:00.000Z',
    rows: purgeList(itemRows(s.tables.projectWorkEvents.values(), ids)),
  };
  await purgeFromServer._handler(s.ctx, {
    projectId: s.projectId,
    operationId: command.operationId,
    command: JSON.stringify(command),
    owner: 'owner',
  });
  return command;
}
const purgeAndRedact = async (s, itemId, kind, expectedVersion, ids = [itemId]) => {
  const command = await purge(s, itemId, kind, expectedVersion, ids);
  const listed = new Set(command.rows.map(([row]) => row));
  markPurged(
    [...s.tables.projectWorkEvents.values()].filter(row => listed.has(row.operationId)),
    command.operationId,
  );
  return command;
};
const deletedPut = (itemId, expectedVersion) => ({
  action: 'put-planning-item',
  operationId: randomUUID(),
  itemId,
  expectedVersion,
  status: 'deleted',
});
async function rebuiltRows(s) {
  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const project = s.tables.hostedProjects.get(s.projectId);
  s.tables.projectWorkGenerations.get(project.work.generationId).format = 3;
  const generation = await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  const row = s.tables.projectWorkGenerations.get(generation),
    partition = row.recordsGenerationId ?? row._id;
  return workRecordRows(s.tables).filter(item => item.generationId === partition);
}
async function eventPages(s) {
  const project = s.tables.hostedProjects.get(s.projectId),
    head = [...s.tables.projectWorkHeads.values()].find(row => row.projectId === s.projectId);
  let cursor = null;
  do {
    const page = await work.events._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      initialRevision: project.work.initialRevision,
      revision: head?.revision ?? project.work.revision,
      paginationOpts: { cursor, numItems: 4 },
    });
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
}

test('every field of every purgeable command is classified, and stored facts with an extra key are refused', () => {
  for (const option of purgeableCommandSchema.options) {
    const action = option.shape.action.value,
      classes = purgeFieldClasses[action];
    const classified = [...classes.keep, ...Object.keys(classes.words), ...classes.drop];
    assert.deepEqual(
      [...classified].sort(),
      Object.keys(option.shape).sort(),
      `${action}: classify each new field as keep, words or drop in src/work-intent-types.ts`,
    );
    assert.equal(new Set(classified).size, classified.length, `${action}: a field has one class`);
  }
  const put = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    expectedVersion: 0,
    kind: 'issue',
    title: `Title ${SECRET}`,
    body: `Body ${SECRET}`,
    reason: `Reason ${SECRET}`,
    type: 'secretlabel',
    owner: '@someone',
    intentIds: [],
  };
  const facts = redactPlanningWrite(purgeableCommandSchema.parse(put));
  assert.equal(JSON.stringify(facts).includes(SECRET), false);
  assert.deepEqual([facts.type, facts.owner, facts.reason], [undefined, undefined, undefined]);
  assert.equal(purgedFactsSchema.safeParse(facts).success, true);
  assert.equal(
    purgedFactsSchema.safeParse({ ...facts, note: SECRET }).success,
    false,
    'an unknown key is not stripped and accepted',
  );
  const note = { action: 'note', intentId: randomUUID(), text: SECRET, kind: 'comment' };
  assert.equal(redactPlanningWrite(note).text, 'Deleted note');
  assert.equal(purgedFactsSchema.safeParse(note).success, false, 'a note with words is not purged facts');
});

test('purging decision evidence removes the line digest from journal facts, index and checkpoint copies', () => {
  const id = randomUUID();
  const itemId = randomUUID();
  const line = planningLineEvidence(1, SECRET);
  const words = { itemId, text: SECRET, authorLabel: 'Fixture', decision: true, line };
  const comment = { id, ...words };
  const facts = redactPlanningWrite(
    purgeableCommandSchema.parse({ ...words, action: 'comment-planning-item', operationId: id }),
  );
  const index = purgedIndexValue('planningComments', comment, randomUUID());
  applyCommentPurge({ planningComments: [comment] }, { commentId: id });
  for (const value of [facts, index, comment]) {
    assert.equal(value.itemId, itemId);
    assert.equal(value.text, 'Deleted comment');
    assert.equal(value.decision, true);
    assert(!Object.hasOwn(value, 'line'));
  }
});

test('an Intent-born Item’s intent, put and note rows purge, and a rebuild and full load find none of its words', async t => {
  const s = await setup(t);
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: `Outcome ${SECRET}`,
      constraints: `Constraints ${SECRET}`,
      base: initial.sourceHead,
    }),
  });
  await s.send(s.item({ itemId: intentId, title: `Title ${SECRET}`, body: `Body ${SECRET}` }));
  await s.send({ action: 'note', intentId, text: `Note ${SECRET}`, kind: 'comment' });
  await s.send(deletedPut(intentId, 1));
  const keep = s.item({ title: 'Kept Item' });
  await s.send(keep);
  const command = await purgeAndRedact(s, intentId, 'issue', 2);
  assert.equal(command.rows.length, 4, 'the intent row, two puts and the note');
  await eventPages(s);
  const rows = await rebuiltRows(s);
  assert.equal(rows.filter(row => row.value.includes(SECRET)).length, 0, 'the rebuilt index has no words');
  const data = (await s.read()).data;
  assert.equal(JSON.stringify(data).includes(SECRET), false, 'the full load has no words');
  assert.equal(data.intents.find(intent => intent.id === intentId).outcome, 'Deleted Item');
  assert.equal(data.planningItems.filter(item => item.id === keep.itemId).at(-1).title, 'Kept Item');
  const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId, purgedRows: 2 });
  assert.equal(journal.includes(SECRET), false);
});

test('a purged row must be listed on its purge with the digest of the facts it holds', async t => {
  const s = await setup(t);
  const target = s.item({ title: `Title ${SECRET}` }),
    other = s.item({ title: 'Other' });
  await s.send(other);
  await s.send(target);
  await s.send(deletedPut(target.itemId, 1));
  const command = await purgeAndRedact(s, target.itemId, 'issue', 2);
  await eventPages(s);
  const row = [...s.tables.projectWorkEvents.values()].find(item => item.operationId === target.operationId);
  const facts = JSON.parse(row.command);
  const original = { ...row };
  // Self-declared structure no longer vouches for itself: links the purge did not record are refused.
  row.command = JSON.stringify({ ...facts, intentIds: [other.itemId] });
  await assert.rejects(eventPages(s), code('INVALID_WORK_JOURNAL'), 'facts that differ from the list');
  await assert.rejects(s.read(), code('INVALID_WORK_JOURNAL'), 'the full load refuses them too');
  Object.assign(row, original);
  // A whole row of another Item cannot be turned into a purged row of this purge.
  const otherRow = [...s.tables.projectWorkEvents.values()].find(
    item => item.operationId === other.operationId,
  );
  const otherOriginal = { ...otherRow };
  markPurged([otherRow], command.operationId);
  await assert.rejects(eventPages(s), code('INVALID_WORK_JOURNAL'), 'a row the purge does not list');
  Object.assign(otherRow, otherOriginal);
  delete otherRow.purged;
  await eventPages(s);
});

test('the whole-journal check accepts a listed row written through another id and refuses a changed one', () => {
  const data = parseWork({ schema: 8, revision: 0, intents: [], lanes: [], views: [] });
  const project = randomUUID(),
    archive = 'b'.repeat(64),
    itemId = randomUUID();
  const events = [];
  const append = (command, id = command.operationId, request = metadataRequest(command)) => {
    const event = {
      projectKey: project,
      archiveSha256: archive,
      id,
      actor: 'owner',
      at: '2026-11-20T00:00:00.000Z',
      request,
      previousRevision: events.length,
      command,
    };
    applyHostedEvent(data, event);
    events.push(event);
    return event;
  };
  const put = patch => ({ action: 'put-planning-item', operationId: randomUUID(), itemId, ...patch });
  const create = put({ expectedVersion: 0, kind: 'issue', title: `Title ${SECRET}` });
  append(create);
  append(put({ expectedVersion: 1, status: 'deleted' }));
  // A row of another Item id that the purge step resolved to this Item (an alias or Intent id) is listed by id.
  const alias = { action: 'note', intentId: randomUUID(), text: `Note ${SECRET}`, kind: 'comment' };
  const aliasEvent = { id: randomUUID(), command: alias };
  const purgeCommand = {
    action: 'purge-planning-item',
    operationId: randomUUID(),
    itemId,
    kind: 'issue',
    expectedVersion: 2,
    deletedAt: '2026-11-20T00:00:00.000Z',
    rows: [
      [create.operationId, purgedFactsDigest(redactPlanningWrite(create))],
      [aliasEvent.id, purgedFactsDigest(redactPlanningWrite(alias))],
    ],
  };
  const journal = [
    {
      ...events[0],
      command: {
        action: 'purged-planning-row',
        purgeOperationId: purgeCommand.operationId,
        command: redactPlanningWrite(create),
      },
    },
    events[1],
    {
      ...events[1],
      id: aliasEvent.id,
      previousRevision: 2,
      command: {
        action: 'purged-planning-row',
        purgeOperationId: purgeCommand.operationId,
        command: redactPlanningWrite(alias),
      },
    },
    { ...events[1], id: purgeCommand.operationId, previousRevision: 3, command: purgeCommand },
  ];
  checkPurgedJournal(journal);
  // A row the purge listed but whose stored facts changed afterwards, purged or still whole, is refused.
  const changed = structuredClone(journal);
  changed[0].command.command.intentIds = [randomUUID()];
  assert.throws(() => checkPurgedJournal(changed), code('INVALID_WORK_JOURNAL'));
  const whole = structuredClone(journal);
  whole[0].command = { ...create, title: 'Changed after the purge listed it' };
  assert.doesNotThrow(() => checkPurgedJournal(whole), 'a whole row redacts to the same facts');
  whole[0].command = { ...create, initiativeId: randomUUID() };
  assert.throws(() => checkPurgedJournal(whole), code('INVALID_WORK_JOURNAL'));
});

test('a new link, parent, relation or Initiative naming a tombstone is refused; existing ones still edit', async t => {
  const s = await setup(t);
  const initiative = s.item({ kind: 'initiative', title: 'Group' }),
    issue = s.item({ title: 'Target' });
  await s.send(initiative);
  await s.send(issue);
  const child = s.item({ title: 'Child', initiativeId: initiative.itemId, intentIds: [issue.itemId] });
  await s.send(child);
  for (const [item, kind] of [
    [initiative, 'initiative'],
    [issue, 'issue'],
  ]) {
    await s.send(deletedPut(item.itemId, 1));
    await purge(s, item.itemId, kind, 2);
  }
  for (const patch of [
    { initiativeId: initiative.itemId },
    { intentIds: [issue.itemId] },
    { parentId: issue.itemId },
    { relations: [{ kind: 'related', id: issue.itemId }] },
  ])
    await assert.rejects(s.send(s.item({ title: 'New', ...patch })), code('PLANNING_ITEM_PURGED'));
  // The child already names both; editing it keeps them and is accepted.
  await s.send({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: child.itemId,
    expectedVersion: 1,
    title: 'Child edited',
  });
  const data = (await s.read()).data;
  assert.equal(data.planningItems.filter(item => item.id === child.itemId).at(-1).title, 'Child edited');
});

test('a purged decision comment rebuilds with its derived body version under a request derived from its own', async t => {
  const s = await setup(t);
  const item = s.item({ title: `Title ${SECRET}` });
  await s.send(item);
  const comment = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.itemId,
    authorLabel: 'Owner',
    text: `Decision ${SECRET}`,
    decision: true,
  };
  await s.send(comment);
  await s.send(deletedPut(item.itemId, 2));
  await purgeAndRedact(s, item.itemId, 'issue', 3);
  const rows = await rebuiltRows(s);
  assert.equal(rows.filter(row => row.value.includes(SECRET)).length, 0);
  const data = (await s.read()).data;
  assert.equal(JSON.stringify(data).includes(SECRET), false);
  const derived = data.planningItems.find(
    version => version.operationId === decisionOperationId(comment.operationId),
  );
  const commentRow = [...s.tables.projectWorkEvents.values()].find(
    row => row.operationId === comment.operationId,
  );
  assert.equal(derived.request, purgedDecisionRequest(commentRow.request));
  await assert.rejects(
    s.send(comment),
    code('PLANNING_ITEM_PURGED'),
    'a retry of the comment answers purged',
  );
});

test('a put linking a purged Item through a folded Intent is refused on the live row set as in a full replay (review fea40ac0 finding 1)', async () => {
  const { commandPlanningRows } = await import(moduleUrl('../convex/projectWorkCommandRows.ts'));
  const { applyUnifiedPlanning } = await import('../dist/work-planning-unified.js');
  const folded = randomUUID(),
    history = randomUUID(),
    purgeOperation = randomUUID();
  const intent = {
    id: folded,
    title: 'Deleted Item',
    outcome: 'Deleted Item',
    description: '',
    constraints: '',
    status: 'active',
    notes: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    memberships: [],
    relatedIntentIds: [],
    historyRefs: [{ itemId: history, version: 1 }],
    conversation: [],
  };
  const tombstone = {
    id: history,
    operationId: purgeOperation,
    request: 'a'.repeat(64),
    version: 3,
    previousVersion: 2,
    kind: 'issue',
    title: 'Deleted Item',
    body: '',
    status: 'deleted',
    intentIds: [],
    at: '2026-11-20T00:00:00.000Z',
    provenance: 'user-declared-local',
    purged: { operationId: purgeOperation, deletedAt: '2026-11-20T00:00:00.000Z', by: 'owner' },
  };
  const store = new Map([
    [`intents:${folded}`, intent],
    [`planningItems:${history}`, tombstone],
  ]);
  const lookups = [];
  const lookup = async keys => {
    lookups.push(keys);
    return keys.map(({ collection, key }) => {
      const value = store.get(`${collection}:${key}`);
      return value ? { collection, key, value: JSON.stringify(value) } : null;
    });
  };
  const put = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    expectedVersion: 0,
    kind: 'issue',
    title: 'New',
    intentIds: [folded],
  };
  // What commandKeys loads for this put: the linked Intent under the id the put names.
  const rows = [{ collection: 'intents', key: folded, value: JSON.stringify(intent) }];
  await commandPlanningRows(rows, put, lookup);
  const values = collection =>
    rows.filter(row => row?.collection === collection).map(row => JSON.parse(row.value));
  const live = {
    planningItems: values('planningItems'),
    planningComments: [],
    intents: values('intents'),
    initiatives: [],
    intentAliases: values('intentAliases'),
  };
  const full = {
    planningItems: [tombstone],
    planningComments: [],
    intents: [intent],
    initiatives: [],
    intentAliases: [],
  };
  for (const data of [live, full])
    assert.throws(
      () => applyUnifiedPlanning(structuredClone(data), put, '2026-11-20T00:00:00.000Z', 'b'.repeat(64)),
      code('PLANNING_ITEM_PURGED'),
    );
  // A put that names no new link reads nothing for the check.
  lookups.length = 0;
  const unchanged = { ...put, operationId: randomUUID(), intentIds: undefined, title: 'Edit' };
  await commandPlanningRows([], unchanged, lookup);
  assert.deepEqual(lookups.flat(), [], 'no added reads for an unchanged put');
});
