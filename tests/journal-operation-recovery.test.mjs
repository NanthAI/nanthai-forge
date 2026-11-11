// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload, hostedPayloadHash } from '../dist/hosted-source-operation.js';
import { compactOperationReceipt } from '../dist/compact-operation-receipt.js';
import { digest } from '../dist/state/hash.js';
const recovery = await import(moduleUrl('../convex/projectJournalOperationRecovery.ts'));
const operations = await import(moduleUrl('../convex/projectHostedOperations.ts'));
function operation(auth, operationId = randomUUID(), result = 'original') {
  const expected = { authorityEpoch: 1 },
    firstAttempt = {
      projectId: auth.projectId,
      operationId,
      id: randomUUID(),
      parentAttemptId: null,
      at: '2026-01-01T00:00:00.000Z',
      expected,
      ids: {},
    };
  return {
    schema: 1,
    projectId: auth.projectId,
    actor: auth.actor,
    operationId,
    payloadHash: hostedPayloadHash({ kind: 'save' }, expected),
    expected,
    firstAttempt,
    terminal: { attemptId: firstAttempt.id, at: firstAttempt.at, outcome: { status: 'completed', result } },
  };
}
async function fixture() {
  const f = recordsFixture(),
    auth = await f.setup(),
    value = operation(auth);
  const id = await f.ctx.db.insert('projectHostedOperations', {
    projectId: auth.projectId,
    actor: auth.actor,
    operationId: value.operationId,
    value: canonicalPayload(value),
    recovery: 'first',
  });
  const original = await f.ctx.db.get(id),
    text = canonicalPayload(original);
  await f.ctx.db.patch(id, {
    value: compactOperationReceipt(value),
    journalSegment: 'archive',
    journalDigest: digest(text),
  });
  return { ...f, auth, id, value, original, text };
}
test('operation recovery exports the current mutable ledger once and retains the latest archived row after receipt expiry', async () => {
  const h = await fixture();
  await h.ctx.db.patch(h.id, { recovery: 'latest' });
  assert.equal(
    JSON.parse(await recovery.journalOperationRecoveryRow(h.ctx, h.auth.projectId, h.text)).recovery,
    'latest',
  );
  const latest = canonicalPayload({ ...h.original, recovery: 'latest' });
  await h.ctx.db.patch(h.id, { journalDigest: digest(latest) });
  assert.equal(await recovery.journalOperationRecoveryRow(h.ctx, h.auth.projectId, h.text), null);
  assert.equal(await recovery.journalOperationRecoveryRow(h.ctx, h.auth.projectId, latest), latest);
  await h.ctx.db.insert('projectJournalReceipts', {
    projectId: h.auth.projectId,
    operationId: `journal-operation:${h.id}`,
    hash: digest(latest),
    envelope: '{}',
  });
  await h.ctx.db.delete(h.id);
  assert.equal(await recovery.journalOperationRecoveryRow(h.ctx, h.auth.projectId, h.text), null);
  assert.equal(await recovery.journalOperationRecoveryRow(h.ctx, h.auth.projectId, latest), latest);
});
test('restored operation UUID reuse after expiry reconciles its newest physical receipt', async () => {
  const h = await fixture(),
    newer = operation(h.auth, h.value.operationId, 'newer-after-expiry');
  await h.ctx.db.insert('projectHostedOperations', {
    projectId: h.auth.projectId,
    actor: h.auth.actor,
    operationId: newer.operationId,
    value: canonicalPayload(newer),
  });
  const current = await operations.hostedOperationRow(
    h.ctx,
    h.auth.projectId,
    h.auth.actor,
    newer.operationId,
  );
  assert.deepEqual(JSON.parse(current.value), newer);
});
test('recovery advances past an obsolete archived operation instead of returning duplicate physical rows or repeating an empty page', async () => {
  const h = await fixture(),
    latest = canonicalPayload({ ...h.original, recovery: 'latest' });
  await h.ctx.db.patch(h.id, { recovery: 'latest', journalDigest: digest(latest) });
  const { journalRecoveryPage } = await import(moduleUrl('../convex/projectJournalRecovery.ts'));
  const { readRecoveryCapsuleCursor } = await import(moduleUrl('../convex/projectLandingCapsuleRecovery.ts'));
  const segments = [h.text, latest].map((text, i) => ({
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: h.auth.projectId,
    scope: 'operations',
    from: i,
    through: i,
    tables: { projectHostedOperations: [text] },
  }));
  for (const [i, segment] of segments.entries())
    await h.ctx.db.insert('projectJournalSegments', {
      projectId: h.auth.projectId,
      key: String(i),
      scope: segment.scope,
      from: i,
      through: i,
      category: 'operations',
      value: canonicalPayload({
        scope: segment.scope,
        from: i,
        through: i,
        pointer: { sha256: String(i).repeat(64) },
      }),
    });
  const ctx = { ...h.ctx, journalLoaded: segments },
    project = await h.ctx.db.get(h.auth.projectId);
  const first = JSON.parse(
    await journalRecoveryPage(ctx, project, 'projectHostedOperations', { cursor: null }),
  );
  assert.deepEqual(first.rows, []);
  assert(first.cursor);
  const second = JSON.parse(
    await journalRecoveryPage(
      ctx,
      project,
      'projectHostedOperations',
      readRecoveryCapsuleCursor('projectHostedOperations', first.cursor),
    ),
  );
  assert.deepEqual(second.rows, [latest]);
  const end = JSON.parse(
    await journalRecoveryPage(
      ctx,
      project,
      'projectHostedOperations',
      readRecoveryCapsuleCursor('projectHostedOperations', second.cursor),
    ),
  );
  assert.equal(end.done, true);
});

test('archive scheduling hints never become logical source bytes in an export or content pin', async () => {
  const { journalSourceRow } = await import(moduleUrl('../convex/projectJournalCanonical.ts'));
  const source = {
    _id: 'row',
    _creationTime: 0,
    projectId: 'project',
    value: JSON.stringify({ journalReady: 'user data stays verbatim' }),
  };
  assert.deepEqual(
    journalSourceRow({
      ...source,
      journalReady: true,
      journalReadyAt: 123,
      journalLaneId: 'lane',
      journalSegment: 'pointer',
      journalDigest: 'hash',
      journalCommand: 'facts',
    }),
    source,
  );
});
