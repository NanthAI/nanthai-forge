// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { convertWork15To16 as convert } from '../dist/work-intent-converter.js';
import { unifiedIntentSchema, unifiedWorkSchema } from '../dist/work-unified-types.js';
import { workSchema } from '../dist/work-types.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  at = '2026-01-01T00:00:00Z';
const intent = (n, extra = {}) => ({
  id: id(n),
  outcome: `Outcome ${n}`,
  constraints: '',
  base: hash,
  status: 'active',
  notes: [],
  createdAt: at,
  ...extra,
});
const item = (n, extra = {}) => ({
  id: id(n),
  operationId: id(n + 1000),
  request: hash,
  version: 1,
  previousVersion: 0,
  kind: 'issue',
  title: `Planning ${n}`,
  body: 'Synthetic details',
  status: 'open',
  intentIds: [],
  at,
  provenance: 'user-declared-local',
  ...extra,
});
const work = (intents = [], planningItems = [], extra = {}) => ({
  ...workSchema.parse({ schema: 15, revision: 7, intents: [], lanes: [], views: [] }),
  intents,
  planningItems,
  ...extra,
});
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

test('unlinked issue keeps its UUID and has no invented execution pin', () => {
  const result = convert(work([], [item(2)]));
  assert.equal(result.intents[0].id, id(2));
  assert.equal(result.intents[0].base, undefined);
  assert.equal(result.intents[0].title, 'Planning 2');
  assert.equal(result.intents[0].version, 1);
});
test('reverse-unique single link folds and aliases issue identity', () => {
  const r = convert(work([intent(1)], [item(2, { intentIds: [id(1)] })]));
  assert.equal(r.intents.length, 1);
  assert.deepEqual(r.intentAliases, [{ aliasId: id(2), intentId: id(1) }]);
  assert.equal(r.intents[0].title, 'Outcome 1');
  assert.equal(r.intents[0].description, 'Synthetic details');
});
test('execution status wins over conflicting closed issue', () => {
  const r = convert(work([intent(1)], [item(2, { status: 'closed', intentIds: [id(1)] })]));
  assert.equal(r.intents[0].status, 'active');
  assert.equal(r.legacyIntentMerge.planningItems[0].status, 'closed');
});
test('legacy ready becomes active with original ready fact retained', () => {
  const r = convert(work([intent(1, { status: 'ready' })]));
  assert.equal(r.intents[0].status, 'active');
  assert.equal(r.legacyIntentMerge.intents[0].status, 'ready');
});
test('closed and in-progress issues preserve facts without Lanes or landings', () => {
  const r = convert(work([], [item(2, { status: 'closed' }), item(3, { status: 'in-progress' })]));
  assert.deepEqual(
    r.intents.map(i => i.status),
    ['completed', 'active'],
  );
  assert.deepEqual(r.lanes, []);
  assert.deepEqual(r.channelMoves, []);
  assert.equal(r.legacyIntentMerge.planningItems[1].status, 'in-progress');
});
test('one issue linking multiple executions remains distinct with reciprocal relations', () => {
  const r = convert(work([intent(1), intent(2)], [item(3, { intentIds: [id(1), id(2)] })]));
  assert.equal(r.intents.length, 3);
  assert.deepEqual(r.intents[2].relatedIntentIds, [id(1), id(2)]);
  assert.deepEqual(r.intents[0].relatedIntentIds, [id(3)]);
  assert.deepEqual(r.intentAliases, []);
});
test('multiple issues sharing execution do not fold', () => {
  const r = convert(work([intent(1)], [item(2, { intentIds: [id(1)] }), item(3, { intentIds: [id(1)] })]));
  assert.equal(r.intents.length, 3);
  assert.equal(r.intentAliases.length, 0);
});
test('historically ambiguous links do not fold when current links become unique', () => {
  const r = convert(
    work(
      [intent(1), intent(2)],
      [
        item(3, { intentIds: [id(1), id(2)] }),
        item(3, { intentIds: [id(1)], version: 2, previousVersion: 1 }),
      ],
    ),
  );
  assert.equal(r.intents.length, 3);
  assert.deepEqual(r.intents[2].relatedIntentIds, [id(1), id(2)]);
});
test('all planning versions and operation bytes survive interleaving', () => {
  const versions = [item(2), item(3), item(2, { version: 2, previousVersion: 1, title: 'Updated' })];
  const r = convert(work([], versions));
  assert.deepEqual(r.planningItems, versions);
  assert.equal(r.intents[0].title, 'Updated');
  assert.deepEqual(r.intents[0].historyRefs, [
    { itemId: id(2), version: 1 },
    { itemId: id(2), version: 2 },
  ]);
});
test('comments retain IDs, text, labels and unknown fields', () => {
  const comment = {
    id: id(90),
    itemId: id(2),
    request: hash,
    authorLabel: '',
    text: 'Synthetic comment',
    at,
    provenance: 'user-declared-local',
    extension: { a: 1 },
  };
  const r = convert(work([], [item(2)], { planningComments: [comment] }));
  assert.deepEqual(r.planningComments, [comment]);
  assert.deepEqual(r.intents[0].conversation, [{ id: id(90), kind: 'planning-comment', itemId: id(2) }]);
});
test('notes retain anchors and unknown authorship with stable conversation identities', () => {
  const note = {
    text: 'Synthetic note',
    kind: 'decision',
    at,
    anchor: {
      viewId: id(20),
      base: hash,
      head: hash,
      file: 'synthetic.ts',
      side: 'after',
      line: 1,
      blob: hash,
    },
    extra: true,
  };
  const r = convert(work([intent(1, { notes: [note, note] })]));
  assert.deepEqual(r.intents[0].notes, [note, note]);
  assert.notEqual(r.intents[0].conversation[0].id, r.intents[0].conversation[1].id);
  assert.equal(r.intents[0].creatorAccountId, undefined);
});
test('memberships preserve multiple groups, duplicate placements and displayed order', () => {
  const r = convert(
    work(
      [intent(1)],
      [
        item(2, { initiativeId: id(5), intentIds: [id(1)] }),
        item(5, { kind: 'initiative', intentIds: [id(1)] }),
        item(6, { kind: 'initiative', intentIds: [id(1)] }),
      ],
    ),
  );
  assert.deepEqual(r.intents[0].memberships, [
    { initiativeId: id(5), sourceId: id(5), order: 0 },
    { initiativeId: id(5), sourceId: id(2), order: 1 },
    { initiativeId: id(6), sourceId: id(6), order: 0 },
  ]);
});
test('unknown fields remain at every retained level, including conflicting field names', () => {
  const w = work([intent(1, { future: { z: 3 }, title: 'Old extension' })], [item(2, { future: [1] })], {
    future: { a: 2 },
    intentAliases: { futureExtension: true },
    intentMergeReceipt: { futureExtension: 'preserve' },
  });
  const r = convert(w);
  assert.deepEqual(r.future, w.future);
  assert.deepEqual(r.legacyIntentMerge.fields.intentAliases, w.intentAliases);
  assert.deepEqual(r.legacyIntentMerge.fields.intentMergeReceipt, w.intentMergeReceipt);
  const { intentMergeReceipt, ...payload } = r;
  assert.equal(intentMergeReceipt.hashes.output, sha(payload));
  assert.deepEqual(r.intents[0].future, { z: 3 });
  assert.equal(r.legacyIntentMerge.intents[0].title, 'Old extension');
  assert.deepEqual(r.planningItems[0].future, [1]);
});
test('idempotence gives identical JSON bytes and does not mutate inputs', () => {
  const w = work([intent(1)], [item(2)]),
    before = JSON.stringify(w),
    r = convert(w);
  assert.equal(JSON.stringify(convert(r)), JSON.stringify(r));
  assert.equal(JSON.stringify(w), before);
});
test('receipt counts and SHA256 match independently calculated bytes', () => {
  const w = work([intent(1)], [item(2, { intentIds: [id(1)] }), item(3)]),
    r = convert(w);
  const { intentMergeReceipt: receipt, ...payload } = r;
  assert.equal(receipt.counts.before.intents, 1);
  assert.equal(receipt.counts.before.issues, 2);
  assert.equal(receipt.counts.after.intents, 2);
  assert.equal(receipt.counts.foldedPairs, 1);
  assert.deepEqual(receipt.hashes, {
    input: sha(w),
    output: sha(payload),
    intents: sha(w.intents),
    planningItems: sha(w.planningItems),
    planningComments: sha(w.planningComments),
  });
});
test('execution fields and source references remain exact', () => {
  const w = work([intent(1, { dependencies: [{ kind: 'view', viewId: id(20), head: hash }] })]);
  const r = convert(w);
  assert.deepEqual(r.intents[0].dependencies, w.intents[0].dependencies);
  assert.equal(r.intents[0].base, hash);
  assert.equal(r.revision, 7);
  assert.deepEqual(r.hostedEvents, w.hostedEvents);
});
test('schemas validate proposed pre-execution Intent and reject newer unknown formats', () => {
  const r = convert(work([], [item(2)]));
  assert.equal(unifiedWorkSchema.safeParse(r).success, true);
  assert.equal(
    convert(work([], [item(3, { title: 'x'.repeat(800), request: 'a'.repeat(40) })])).intents[0].request,
    'a'.repeat(40),
  );
  assert.equal(unifiedIntentSchema.safeParse({ ...r.intents[0], status: 'proposed' }).success, true);
  assert.throws(() => convert({ ...work(), schema: 17 }), { code: 'WORK_UPGRADE_REQUIRED' });
  assert.throws(() => convert(work([intent(1)], [item(1)])), { code: 'INTENT_MERGE_ID_COLLISION' });
});
test('anonymised owner-count fixture retains real cardinalities', () => {
  const counts = JSON.parse(
    readFileSync(new URL('./fixtures/intent-merge-owner-counts.json', import.meta.url)),
  );
  const w = work(
    counts.intentShape.map(i =>
      intent(i.id, {
        status: i.status,
        notes: Array.from({ length: i.notes }, () => ({ text: 'Synthetic note', kind: 'comment', at })),
      }),
    ),
    counts.planningShape.map(i =>
      item(i.id, {
        ...i,
        id: id(i.id),
        intentIds: i.intentIds.map(id),
        ...(i.initiativeId ? { initiativeId: id(i.initiativeId) } : {}),
      }),
    ),
    {
      planningComments: counts.commentTargets.map((target, i) => ({
        id: id(9000 + i),
        itemId: id(target),
        request: hash,
        authorLabel: '',
        text: 'Synthetic comment',
        at,
        provenance: 'user-declared-local',
      })),
    },
  );
  w.lanes = counts.laneIntentOrdinals.map((target, index) => ({
    id: id(20000 + index),
    intentId: id(target),
    name: 'Synthetic Lane',
    base: hash,
    head: hash,
    assignment: '',
    target: '',
    state: 'active',
    checkpoints: [],
  }));
  w.views = counts.viewIntentOrdinals.map((target, index) => ({
    id: id(30000 + index),
    intentId: id(target),
    base: hash,
    inputs: [],
    status: 'clean',
    head: hash,
    details: '',
    at,
  }));
  const r = convert(w),
    before = r.intentMergeReceipt.counts.before;
  assert.equal(r.lanes.length, counts.lanes);
  assert.equal(r.views.length, counts.views);
  assert.deepEqual(r.lanes, w.lanes);
  assert.deepEqual(r.views, w.views);
  assert.equal(before.intents, counts.intents);
  assert.equal(before.notes, counts.notes);
  assert.equal(before.versions, counts.planningVersions);
  assert.equal(before.comments, counts.planningComments);
  assert.equal(before.issues, counts.issues);
  assert.equal(before.initiatives, counts.initiatives);
  assert.equal(r.intents.length, counts.intents + counts.issues - r.intentAliases.length);
  assert.equal(JSON.stringify(convert(r)), JSON.stringify(r));
});
