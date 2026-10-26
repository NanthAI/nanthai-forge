// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture, cascade, maxima } from './hosted-lane-lifecycle-fixture.mjs';
test('205-child cascade has constant final publication and paged projection despite 10,050 retained events', async t => {
  const f = await lifecycleFixture();
  for (let i = 1; i < 205; i++) await f.addLane();
  for (let i = 0; i < 10050; i++)
    f.insert('projectHostedLifecycleEvents', {
      projectId: f.projectId,
      kind: 'lane',
      key: randomUUID(),
      planId: 'retained-plan',
      index: i,
      value: '{}',
    });
  const mainId = f.insert('projectHostedChannels', {
    projectId: f.projectId,
    operationId: randomUUID(),
    name: 'main',
    selection: JSON.stringify({ head: f.baseline.sha256, receipt: 'main-0' }),
  });
  const main = structuredClone(f.tables.projectHostedChannels.get(mainId)),
    objects = structuredClone(f.tables.projectObjects);
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  const started = performance.now(),
    rssBefore = process.memoryUsage().rss;
  await f.begin(r);
  let pages = 0;
  while (!f.plan(r).ready) {
    assert(++pages < 20);
    await f.advance(r);
  }
  assert.equal(pages, 11);
  assert.equal(f.plan(r).staged, 205);
  await f.lifeRun('lifecycleFinal', cascade.advanceLifecycle, f.plan(r));
  const final = f.counts.at(-1);
  assert(final.documents < 35 && final.ranges < 35);
  assert(!final.touched.includes('projectHostedLifecyclePointers'));
  assert(!final.touched.includes('projectHostedLifecycleEvents'));
  assert.equal((await f.read(f.laneId)).state, 'abandoned');
  const ticks = await f.drain();
  assert(f.plan(r).materialized);
  assert.equal(f.pending().length, 0);
  assert.deepEqual(f.tables.projectObjects, objects);
  assert.deepEqual(f.tables.projectHostedChannels.get(mainId), main);
  const events = [...f.tables.projectHostedLifecycleEvents.values()].filter(
    e => e.planId === f.plan(r)._id && e.kind === 'lane',
  );
  assert.equal(events.length, 205);
  const heads = [...f.tables.projectHostedRecordHeads.values()].filter(
    h => h.kind === 'lane' && h.parent === f.intentId,
  );
  assert.equal(heads.filter(h => h.status === 'abandoned').length, 205);
  await f.begin(r);
  await f.advance(r);
  assert.equal(f.pending().length, 0);
  t.diagnostic(
    JSON.stringify({
      children: 205,
      retainedEvents: 10050,
      pages,
      ticks,
      final,
      maxima,
      elapsedMs: performance.now() - started,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      sourceBytesThroughConvex: 0,
      realProviderCalls: 0,
    }),
  );
});
