// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// C1-02: reading a busy public project costs one compact week row, independently of retained receipt size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW, id } from './public-discovery-fixture.mjs';
import { meterReads, meterWorkIO } from './hosted-read-set.mjs';
const read = await import(moduleUrl('../convex/publicRead.ts'));
const { writeLineMain } = await import(moduleUrl('../convex/projectLiveLineStore.ts'));

export async function dogfoodPublicFixture() {
  const s = fixture();
  s.tables.projectPlanningRecords.clear();
  for (let n = 0; n < 324; n++) {
    const item = {
      id: id(n + 10),
      kind: n < 22 ? 'initiative' : 'issue',
      status: n % 3 === 0 ? 'in-progress' : 'open',
      title: `Synthetic planned change ${n}`,
      body: 'synthetic detail '.repeat(25),
      initiativeId: n < 22 ? null : id(10 + (n % 22)),
    };
    s.tables.projectPlanningRecords.set(`p-${n}`, {
      _id: `p-${n}`,
      _creationTime: NOW - n,
      projectId: 'project',
      generationId: 'gen',
      collection: 'planningSearch',
      key: item.id,
      parent: '',
      position: n,
      value: JSON.stringify(item),
      planning: {
        kind: item.kind,
        status: item.status,
        initiativeId: item.initiativeId ?? '',
        text: `${item.title}\n${item.body}`,
        open: true,
      },
    });
  }
  for (let n = 0; n < 1000; n++) {
    const at = NOW - (999 - n) * 360_000;
    s.tables.projectHostedAcceptances.set(`receipt-${n}`, {
      _id: `receipt-${n}`,
      _creationTime: at,
      projectId: 'project',
      receiptId: id(n + 1000),
      submissionId: id(n + 2000),
      attemptId: id(n + 3000),
      sequence: n,
      value: JSON.stringify({
        schema: 1,
        id: id(n + 1000),
        head: String(n).padStart(64, '0'),
        inputs: Array.from({ length: 12 }, (_, i) => ({
          laneId: id(n + 4000 + i),
          head: 'a'.repeat(64),
          base: 'b'.repeat(64),
        })),
      }),
    });
    await writeLineMain(
      s.ctx,
      'project',
      { head: String(n).padStart(64, '0'), at: new Date(at).toISOString(), check: 'passed' },
      1,
    );
  }
  return s;
}

test('dogfood-sized project reads no full receipts and keeps DB read bytes bounded', async t => {
  const s = await dogfoodPublicFixture();
  const meter = meterReads(s.ctx);
  let body;
  const cost = await meter.cost(async () => {
    body = await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW });
  });
  t.diagnostic(
    `uncached project query: ${cost.documents} documents, ${cost.bytes} modeled DB bytes; retained fixture: 324 plan roots, 1000 full receipts`,
  );
  assert.equal(body.activity.landings, 1000);
  assert.equal(
    body.activity.days.reduce((sum, count) => sum + count, 0),
    1000,
  );
  assert(cost.bytes < 512 * 1024, JSON.stringify(cost));
  assert(cost.documents < 400, JSON.stringify(cost));
  // Making every receipt enormous cannot change the query's document or byte cost.
  for (const receipt of s.tables.projectHostedAcceptances.values()) receipt.value += 'x'.repeat(10_000);
  assert.deepEqual(
    await meter.cost(() => read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW })),
    cost,
  );
});

test('week totals share the existing main read/write and do not double-count retries or legacy publication', async () => {
  const s = fixture();
  const io = meterWorkIO(s.ctx, s.tables);
  const main = { head: 'a'.repeat(64), at: new Date(NOW).toISOString(), check: 'passed' };
  const first = await io.cost(() => writeLineMain(s.ctx, 'project', main, 1));
  assert.equal(first.readDocuments, 0);
  assert.equal(first.writeDocuments, 1);
  assert.equal(
    (await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW })).activity.landings,
    1,
  );
  assert.equal((await io.cost(() => writeLineMain(s.ctx, 'project', main, 1))).writeDocuments, 0);
  await writeLineMain(s.ctx, 'project', { ...main, check: 'failed' }, 1);
  await writeLineMain(s.ctx, 'project', { ...main, head: 'b'.repeat(64) });
  const body = await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW });
  assert.equal(body.activity.landings, 1);
  assert.equal(body.activity.recordedSince, NOW);
  const later = await read.projectPage._handler(s.ctx, {
    handle: 'ada',
    slug: 'atlas',
    now: NOW + 7 * 86_400_000,
  });
  assert.equal(later.activity.landings, 0);
});

test('a batch that lands under the same head still counts its receipts once (85f456c1 review)', async () => {
  const s = fixture();
  const main = { head: 'a'.repeat(64), at: new Date(NOW).toISOString(), check: 'passed' };
  await writeLineMain(s.ctx, 'project', main, 1);
  const again = { ...main, at: new Date(NOW + 60_000).toISOString(), automatic: true };
  await writeLineMain(s.ctx, 'project', again, 2);
  await writeLineMain(s.ctx, 'project', again, 2);
  const body = await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW + 60_000 });
  assert.equal(body.activity.landings, 3, 'two fresh receipts under the old head count; the replay does not');
});
