// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off conversion of landing notes (Item c0af6cfa, F8 leftover): the original landing names its revert,
// and a note archived before it carried a landing time takes its receipt's. Deleted with the job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { itemWorkFixture as fixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const job = await import(moduleUrl('../convex/legacyLandingNotes.ts'));
const prior = process.env.CONVEX_CLOUD_URL;
test.before(() => (process.env.CONVEX_CLOUD_URL = 'https://synthetic-dev-1.convex.cloud'));
test.after(() => {
  if (prior === undefined) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = prior;
});

async function notes() {
  const s = await fixture({ details: true });
  const revert = randomUUID();
  const original = randomUUID();
  await s.addLandingNote(70, { receiptId: original });
  await s.addLandingNote(71, { kind: 'reverted', receiptId: revert, revertOf: original });
  // A revert whose landing has no note (an Intent of no Item) is not an error and has nothing to name.
  await s.addLandingNote(72, { kind: 'reverted', receiptId: randomUUID(), revertOf: randomUUID() });
  const named = receiptId =>
    [...s.tables.projectIntentLandingNotes.values()].find(row => row.receiptId === receiptId);
  const run = (args = {}) =>
    job.notesRun._handler(
      { runMutation: (_ref, input) => job.notesPage._handler(s.ctx, input) },
      { deployment: 'synthetic-dev-1', apply: false, budgetBytes: 50_000_000, ...args },
    );
  return { s, original, revert, named, run };
}

test('a dry run counts the landings that lack their revert link and writes nothing', async () => {
  const { original, named, run } = await notes();
  const result = await run();
  assert.equal(result.stopped, null);
  assert.equal(result.counts.revertedMissing, 1);
  assert.equal(result.counts.revertedSet, 0);
  assert.equal(named(original).revertedBy, undefined);
});

test('apply names the revert on its original landing, and a replay changes nothing', async () => {
  const { original, revert, named, run } = await notes();
  const applied = await run({ apply: true });
  assert.equal(named(original).revertedBy, revert);
  assert.equal(applied.counts.revertedSet, 1);
  const replay = await run({ apply: true });
  assert.equal(replay.counts.revertedMissing, 0);
  assert.equal(replay.counts.revertedSet, 0);
  assert.equal(replay.counts.atMissing, 0);
});

test('an archived note without a landing time takes its receipt’s time, and one with no receipt is listed', async () => {
  const { s, run } = await notes();
  const receipt = [...s.tables.projectHostedAcceptances.values()][0];
  const parsed = JSON.parse(receipt.value);
  const archive = receiptId =>
    s.ctx.db.insert('projectIntentLandingNotes', {
      projectId: s.auth.projectId,
      intentId: s.itemId,
      receiptId,
      kind: 'landed',
      laneIds: [],
      capsule: randomUUID(),
    });
  const withReceipt = await archive(receipt.receiptId);
  const withoutReceipt = await archive(randomUUID());
  const result = await run({ apply: true });
  assert.equal(s.tables.projectIntentLandingNotes.get(withReceipt).at, parsed.at);
  assert.equal(s.tables.projectIntentLandingNotes.get(withoutReceipt).at, undefined);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0], /no-receipt/);
});

test('a deployment argument that does not name this deployment refuses before any read', async () => {
  const { run } = await notes();
  await assert.rejects(run({ deployment: 'prod-lookalike', apply: true }), /deployment/i);
});

test('the run stops at its read budget and says so', async () => {
  const { run } = await notes();
  const result = await run({ budgetBytes: 1 });
  assert.equal(result.stopped, 'budget');
  assert.equal(result.counts.notes, 0);
});
