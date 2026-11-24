// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { planFixture } from './plan-read-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
const { start, createIntent } = await import(moduleUrl('../convex/projectHostedStart.ts'));
const { seed } = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const { set } = await import(moduleUrl('../convex/projectAutonomy.ts'));

const head = 'a'.repeat(64);
const expectedMain = { head, receiptId: 'main' };
const authority = { mode: 'server', epoch: 1 };

async function fixture(t, scale = 0) {
  const s = scale ? await planFixture(t, scale) : await setup(t);
  if (scale) await s.project();
  const { projectId, ctx } = s;
  ctx.meta.getTransactionMetrics = async () => ({
    databaseQueries: { remaining: 4096 },
    documentsRead: { remaining: 4096 },
    bytesRead: { remaining: 16 * 1024 * 1024 },
  });
  await ctx.db.patch(projectId, { sourceAuthority: authority });
  await seed._handler(ctx, {
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
      authority,
      receipt: { id: 'main', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  const input = () => ({
    projectId,
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain,
    authorship: { kind: 'agent', declaration: 'unknown' },
    intent: { kind: 'new', outcome: 'Preserve the saved sheet', constraints: 'Keep private notes' },
  });
  return {
    ...s,
    input,
    items: () =>
      [...s.tables.projectPlanningRecords.values()]
        .filter(row => row.collection === 'planningSearch')
        .map(row => JSON.parse(row.value)),
    begin: async args => JSON.parse(await start._handler(ctx, args)),
    disable: () =>
      set._handler(ctx, {
        projectId,
        command: JSON.stringify({
          action: 'set-policy',
          operationId: randomUUID(),
          autoCreatePlanningItem: false,
        }),
      }),
  };
}

test('an unplanned agent start captures a private plain Item by default and the original start never captures twice', async t => {
  const s = await fixture(t);
  const input = s.input();
  const started = await s.begin(input);
  const [item] = s.items();
  assert.deepEqual(
    [item.id, item.title, item.body, item.status, item.hidden, item.version],
    [started.intentId, input.intent.outcome, '', 'in-progress', true, 1],
  );
  const intent = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === started.intentId,
  );
  assert.equal(intent.planningItemId, item.id, 'the landing evidence goes to the captured Item');
  await s.disable();
  assert.deepEqual(await s.begin(input), started);
  assert.equal(s.items().length, 1);
  await s.begin(s.input());
  assert.equal(s.items().length, 1, 'an owner can turn capture off for future starts');
});

test('a person start and a Lane-less Intent do not create Items even when capture is enabled', async t => {
  const s = await fixture(t);
  await s.begin({ ...s.input(), authorship: { kind: 'person' } });
  await createIntent._handler(s.ctx, s.input());
  assert.deepEqual(s.items(), []);
});

test('a stale Work selection does not stop an unplanned start', async t => {
  const s = await fixture(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  await s.ctx.db.patch(project.work.generationId, { status: 'building' });
  assert((await s.begin(s.input())).lane);
  assert.deepEqual(s.items(), []);
});

for (const scale of [1, 2])
  test(`capture adds a bounded Item write at ${324 * scale} existing Plan rows`, async t => {
    const s = await fixture(t, scale);
    const io = meterWorkIO(s.ctx, s.tables);
    const input = s.input();
    input.intent.outcome = 'é'.repeat(500); // the largest outcome accepted by hosted start
    let started;
    const before = performance.now();
    const capture = await io.cost(async () => {
      started = await s.begin(input);
    });
    const captureMs = performance.now() - before;
    const item = s.items().find(item => item.id === started.intentId);
    assert(
      item && item.title.length && input.intent.outcome.startsWith(item.title),
      'the compact title is a preview of the outcome',
    );
    await s.disable();
    const baselineBefore = performance.now();
    const baseline = await io.cost(() => s.begin(s.input()));
    const baselineMs = performance.now() - baselineBefore;
    assert(capture.readDocuments - baseline.readDocuments <= 40, JSON.stringify(capture));
    assert(capture.writeDocuments - baseline.writeDocuments <= 35, JSON.stringify(capture));
    t.diagnostic(JSON.stringify({ scale, capture, baseline, captureMs, baselineMs }));
  });
