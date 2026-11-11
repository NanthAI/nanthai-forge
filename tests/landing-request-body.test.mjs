// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
const { landingRequestBodies } = await import(moduleUrl('../convex/projectLandingRequestBody.ts'));
const { finishReadWriter, projectPurgeWriter } = await import(
  moduleUrl('../convex/projectFinishReadWriter.ts')
);
const { finishReadReader } = await import(moduleUrl('../convex/projectFinishReadReader.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const request = { channel: 'main', candidateId: 'candidate', message: 'synthetic '.repeat(2000) };
const ticket = () => ({
  projectId: 'project',
  channel: 'main',
  submissionId: 'submission',
  operationId: 'operation',
  actor: 'owner',
  sequence: 1,
  runnable: true,
  phase: 'queued',
  runId: null,
  attemptId: 'attempt',
  batchSelection: JSON.stringify({ files: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`) }),
  value: canonicalPayload({ id: 'submission', attemptId: 'attempt', phase: 'queued', request }),
});
const logical = row => {
  const { _id, _creationTime, requestBodyId, selectionBodyId, ...value } = row;
  return value;
};

test('all 24 landing ticket indexes retain exact logical reads while cold bodies and observer projections stay unindexed', async () => {
  const s = state([]),
    ctx = landingRequestBodies(finishReadWriter(s.ctx));
  const value = ticket();
  const id = await ctx.db.insert('projectHostedLandingRequests', value);
  const raw = s.tables.projectHostedLandingRequests.get(id);
  assert(raw.requestBodyId);
  assert.equal(JSON.parse(raw.value).request, undefined);
  assert.equal(raw.batchSelection, undefined);
  assert.equal(schema.tables.projectHostedLandingBodies.export().indexes.length, 0);
  const indexes = schema.tables.projectHostedLandingRequests.export().indexes;
  assert.equal(indexes.length, 24);
  for (const index of indexes) {
    const row = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex(index.indexDescriptor, q => index.fields.reduce((q, key) => q.eq(key, value[key]), q))
      .unique();
    assert.deepEqual(logical(row), value, index.indexDescriptor);
  }
  const observer = finishReadReader(ctx);
  const projected = await observer.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', value.projectId).eq('submissionId', value.submissionId),
    )
    .unique();
  assert.deepEqual(JSON.parse(projected.value).request, request);
  const projection = [...s.tables.projectFinishReadRows.values()].find(
    r => r.kind === 'projectHostedLandingRequests',
  );
  assert(!projection.value.includes('synthetic synthetic'));
  assert.equal(JSON.parse(projection.value).requestBodyId, raw.requestBodyId);
});

test('phase writes reuse one cold body, legacy rows read unchanged, and changed batch selection replaces only its owning body', async () => {
  const s = state([]),
    value = ticket();
  const legacyId = await s.ctx.db.insert('projectHostedLandingRequests', value);
  const ctx = landingRequestBodies(finishReadWriter(s.ctx));
  assert.deepEqual(logical(await ctx.db.get(legacyId)), value);
  const id = await ctx.db.insert('projectHostedLandingRequests', { ...value, submissionId: 'new' });
  const bodyId = s.tables.projectHostedLandingRequests.get(id).requestBodyId;
  const before = structuredClone(s.tables.projectHostedLandingBodies.get(bodyId));
  const run = JSON.parse((await ctx.db.get(id)).value);
  await ctx.db.patch(id, { phase: 'checking', value: JSON.stringify({ ...run, phase: 'checking' }) });
  assert.deepEqual(s.tables.projectHostedLandingBodies.get(bodyId), before);
  assert.equal(s.tables.projectHostedLandingBodies.size, 2);
  await ctx.db.patch(id, { batchSelection: 'changed exact selection' });
  assert.equal((await ctx.db.get(id)).batchSelection, 'changed exact selection');
  assert.equal(s.tables.projectHostedLandingBodies.size, 2);
  const foreign = await ctx.db.insert('projectHostedLandingRequests', {
    ...value,
    projectId: 'foreign',
    submissionId: 'foreign',
  });
  const foreignBody = s.tables.projectHostedLandingRequests.get(foreign).requestBodyId;
  await s.ctx.db.patch(id, { requestBodyId: foreignBody });
  await assert.rejects(ctx.db.get(id), /belongs to another ticket/);
  // Restore only the pointer tampered by this negative control; deleting a ticket removes its own body.
  await s.ctx.db.patch(id, { requestBodyId: bodyId });
  await ctx.db.get(id);
  await ctx.db.delete(id);
  assert(!s.tables.projectHostedLandingBodies.has(bodyId));
  assert(s.tables.projectHostedLandingBodies.has(foreignBody));
  assert.equal(
    projectPurgeWriter(ctx).db,
    s.ctx.db,
    'permanent purge bypasses every ordinary companion writer',
  );
});

test('cold companion accounting rejects per-ticket fanout growth instead of relaxing logical budgets', async () => {
  const { landingBodyCounts } = await import('./observer-projection-budget.mjs');
  const meter = {
    readDocumentsByTable: { projectHostedLandingRequests: 1, projectHostedLandingBodies: 2 },
    readRangesByTable: { projectHostedLandingBodies: 2 },
    written: ['projectHostedLandingRequests', 'projectHostedLandingBodies', 'projectHostedLandingBodies'],
  };
  assert.deepEqual(landingBodyCounts(meter), { reads: 2, writes: 2, ranges: 2 });
  assert.throws(
    () =>
      landingBodyCounts({
        ...meter,
        readDocumentsByTable: { ...meter.readDocumentsByTable, projectHostedLandingBodies: 3 },
      }),
    /at most two cold bodies/,
  );
  assert.throws(
    () => landingBodyCounts({ ...meter, written: [...meter.written, 'projectHostedLandingBodies'] }),
    /at most two cold-body writes/,
  );
});

test('a copied body pointer cannot overwrite another landing ticket during an insert', async () => {
  const s = state([]),
    ctx = landingRequestBodies(finishReadWriter(s.ctx));
  const id = await ctx.db.insert('projectHostedLandingRequests', ticket());
  const row = s.tables.projectHostedLandingRequests.get(id);
  const before = structuredClone(s.tables.projectHostedLandingBodies.get(row.requestBodyId));
  await assert.rejects(
    ctx.db.insert('projectHostedLandingRequests', {
      ...ticket(),
      submissionId: 'different-submission',
      requestBodyId: row.requestBodyId,
    }),
    /belongs to another ticket/,
  );
  assert.deepEqual(s.tables.projectHostedLandingBodies.get(row.requestBodyId), before);
  assert.equal(s.tables.projectHostedLandingRequests.size, 1);
});
