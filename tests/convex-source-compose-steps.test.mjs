// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { proveMerged } from '../dist/hosted-batch-coverage.js';

async function largeCompose(s, count, batch, conflict) {
  const blob = await s.putSpec(Buffer.from('synthetic source\n'));
  const entries = Array.from({ length: 29000 }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/synthetic/fixture/module-${String(i).padStart(6, '0')}.ts`,
    mode: 'file',
    blob: blob.sha256,
  }));
  const refs = new Map();
  const state = async (parents, additions, message) => {
    const object = await s.json({
      schema: 1,
      kind: 'forge-source-state',
      files: [...entries, ...additions],
      parents,
      message,
      at,
    });
    const built = buildObjectRecipe(await s.bytes(object));
    for (const body of built.objects.values()) await s.putSpec(body);
    const recipe = await s.putSpec(built.bytes);
    const leaves = ref =>
      ref.height === 0
        ? [{ sha256: ref.sha256, size: ref.size }]
        : JSON.parse(built.objects.get(ref.sha256)).children.flatMap(leaves);
    const row = [...s.tables.projectObjects.values()].find(row => row.digest === object.sha256);
    await s.ctx.db.patch(row._id, {
      recipe: { digest: recipe.sha256, size: recipe.size },
      recipeClosure: leaves(built.recipe.tree),
      stateParents: parents,
      stateGeneration: parents.length ? 2 : 1,
    });
    const ref = { object, recipe };
    refs.set(object.sha256, ref);
    return ref;
  };
  const add = (path, content = blob) => ({ path, mode: 'file', blob: content.sha256 });
  const base = await state([], [], 'base');
  const parents = [base.object.sha256];
  const main = await state(parents, [add('y-main')], 'advanced main');
  assert(main.object.size > 4.8 * 1024 * 1024 && main.object.size < 5.1 * 1024 * 1024);
  const members = [];
  for (let i = 0; i < count; i++) {
    const collision = conflict && i === count - 1;
    const ref = await state(
      parents,
      [collision ? add('y-main/deep.txt') : add(`z-member-${i}`)],
      `member ${i}`,
    );
    members.push({
      head: ref.object.sha256,
      state: ref,
      ...(batch
        ? { candidateId: randomUUID() }
        : { laneId: randomUUID(), version: 0, sourceVersion: 0, lifecycleVersion: 0 }),
    });
  }
  const inputs = buildComposePages(batch ? [] : members);
  const dependencies = buildComposePages(batch ? members : []);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  const input = await s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: main.object.sha256, receiptId: 'main' },
    main,
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    ...(batch ? { batch: { members: members.map(entry => entry.candidateId) } } : {}),
    algorithm: 'forge-native-compose-v1',
    message: 'compose',
    at,
  });
  return { input, main, members, refs };
}

// Read ceilings are the failing-first run on the same recipes and ancestry.
for (const { count, batch, conflict, baselineReads } of [
  { count: 1, batch: false, baselineReads: 136 },
  { count: 1, batch: true, baselineReads: 154 },
  { count: 2, batch: true, baselineReads: 197 },
  { count: 3, batch: true, baselineReads: 273 },
  { count: 2, batch: true, conflict: true, baselineReads: 190 },
])
  test(`4.9 MiB ${batch ? 'cohort' : 'solo'} compose of ${count}${conflict ? ' with a dropped final member' : ''} publishes in its last merge quantum`, async t => {
    const s = await scaleFixture();
    try {
      const { input, main, members, refs } = await largeCompose(s, count, batch, conflict);
      const oracle = new Map();
      const expected = await buildHostedSourceState(input, {
        async describeBatch(ids) {
          return Promise.all(
            ids.map(
              async sha256 =>
                refs.get(sha256) ?? {
                  object: { sha256, size: (await s.bytes({ sha256 })).length },
                  recipe: null,
                },
            ),
          );
        },
        async read(pin) {
          return [await s.bytes(pin)];
        },
        async upload(pin, stream) {
          const parts = [];
          for await (const part of stream) parts.push(part);
          oracle.set(pin.sha256, Buffer.concat(parts));
        },
      });
      const jobId = await s.enqueue(input);
      const report = await s.drain();
      const job = await s.job(jobId);
      assert.equal(job.status, 'completed');
      const measured = {
        nodeSteps: s.calls.filter(name => name === 'projectConvexSourceNode:step').length,
        nodeGBSecondsAt512MiB: report.actionMs / 2000,
        peakRss: report.maxRssBytes,
        reads: report.documentsRead,
        calls: report.functionCalls,
        sourceBytes: report.readBytes,
      };
      t.diagnostic(JSON.stringify(measured));
      assert(
        measured.reads <= baselineReads,
        'source planning and publication add zero Convex document reads',
      );
      assert.deepEqual(await s.bytes(job.output), oracle.get(expected.output.sha256));
      const result = JSON.parse(await s.bytes(job.output));
      assert.equal(result.result.status, 'clean');
      assert.deepEqual(
        await s.bytes(result.result.candidateFiles),
        oracle.get(result.result.candidateFiles.sha256),
      );
      const included = conflict ? members.slice(0, -1) : members;
      let head = result.result.state.sha256;
      const parents = new Map();
      for (const member of [...included].reverse()) {
        const bytes = await s.bytes({ sha256: head });
        assert.deepEqual(bytes, oracle.get(head));
        const edges = JSON.parse(bytes).parents;
        parents.set(head, edges);
        assert.equal(edges[1], member.head);
        head = edges[0];
      }
      assert.equal(head, main.object.sha256);
      assert(
        await proveMerged(
          result.result.state.sha256,
          head,
          included.map(m => m.head),
          async id => parents.get(id) ?? null,
          count,
        ),
      );
      if (conflict) {
        assert.equal(result.dropped[0].candidateId, members.at(-1).candidateId);
        assert.equal(result.dropped[0].againstMain, true);
      }
      if (batch) assert.equal(result.dropped.length, conflict ? 1 : 0);
      const calls = s.calls.length;
      await s.drain();
      assert.equal(s.calls.length, calls, 'idle scheduler makes zero calls');
      assert.equal(measured.nodeSteps, count, 'no ancestry-only or terminal-only Node step');
    } finally {
      s.restore();
    }
  });
