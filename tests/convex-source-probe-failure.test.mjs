// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { MemoryMergeSource, MemorySourceReader } from '../dist/hosted-source-memory.js';
import { buildHostedComposeState } from '../dist/hosted-compose-worker.js';

async function scenario(s, { requiredBase = false, large = false } = {}) {
  const blob = await s.putSpec(Buffer.from('base\n')),
    file = { path: 'f', mode: 'file', blob: blob.sha256 },
    big = large
      ? Array.from({ length: 29000 }, (_, i) => ({
          ...file,
          path: `src/deep/shared/components/features/generated/synthetic/module-${String(i).padStart(6, '0')}.ts`,
        }))
      : [file],
    parents = {};
  const state = async (name, edges = [], files = [file]) => {
    const pin = await s.json({
      schema: 1,
      kind: 'forge-source-state',
      files,
      parents: edges.map(p => p.sha256),
      message: name,
      at,
    });
    parents[pin.sha256] = edges.map(p => p.sha256);
    return pin;
  };
  const common = await state('M', [], big),
    c = await state('C', [common]),
    x = await state('X', [c]),
    a = await state('A', [c], big),
    b = await state('B', [x], big),
    leftBlob = await s.putSpec(Buffer.from('left\n')),
    rightBlob = await s.putSpec(Buffer.from('right\n')),
    left = await state('L', requiredBase ? [common] : [a, common], [{ ...file, blob: leftBlob.sha256 }]),
    right = await state('R', requiredBase ? [common] : [b, common], [{ ...file, blob: rightBlob.sha256 }]),
    inputs = buildComposePages([
      {
        laneId: '00000000-0000-4000-8000-000000000001',
        head: right.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: right, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  const input = await s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: left.sha256, receiptId: 'main' },
    main: { object: left, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'probe merge',
    at,
  });
  return { input, common, a, parents, left, right };
}

async function recipeState(s, object) {
  const bytes = await s.bytes(object),
    chunkBytes = Math.min(512 * 1024, Math.floor(bytes.length / 2)),
    leaves = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes)
    leaves.push(await s.putSpec(bytes.subarray(offset, offset + chunkBytes)));
  const index = await s.json({
      schema: 1,
      kind: 'forge-byte-tree',
      children: leaves.map(pin => ({ ...pin, height: 0, length: pin.size })),
    }),
    recipe = await s.json({
      schema: 1,
      kind: 'forge-object-recipe',
      object,
      tree: { ...index, height: 1, length: object.size },
    }),
    row = [...s.tables.projectObjects.values()].find(row => row.digest === object.sha256);
  await s.ctx.db.patch(row._id, { recipe: { digest: recipe.sha256, size: recipe.size } });
  return { recipe, index, leaf: leaves.at(-1) };
}

async function oracle(s, h) {
  const source = new MemoryMergeSource(h.parents);
  for (const row of s.tables.projectObjects.values()) {
    const pin = { sha256: row.digest, size: row.size };
    source.objects.set(pin.sha256, await s.bytes(pin));
  }
  const reader = new MemorySourceReader(source, {
    read: () => assert.fail('oracle must have complete verified bytes'),
    upload: async () => {},
  });
  const result = await buildHostedComposeState(
    h.input,
    JSON.parse(await s.bytes(h.input)),
    reader,
    source,
    async () => {},
  );
  return source.objects.get(result.output.sha256);
}

for (const large of [false, true])
  for (const required of [false, true])
    test(`${large ? 'fan-out' : 'direct'} worker normalizes nested recipe/index/leaf descriptor failures for ${required ? 'required' : 'dispensable'} States`, async t => {
      let healthy;
      for (const fault of ['healthy', 'recipe', 'index', 'leaf']) {
        const s = await scaleFixture();
        try {
          const h = await scenario(s, { large }),
            expected = await oracle(s, h),
            parts = await recipeState(s, required ? h.a : h.common);
          if (fault !== 'healthy') {
            const row = [...s.tables.projectObjects.values()].find(row => row.digest === parts[fault].sha256);
            await s.ctx.db.patch(row._id, { removed: true });
          }
          const id = await s.enqueue(h.input),
            report = await s.drain(),
            job = await s.job(id);
          if (required && fault !== 'healthy') {
            assert.equal(job.status, 'failed');
            assert.equal(job.control.failureCode, 'SOURCE_UNAVAILABLE');
            assert.equal(job.output, null);
          } else {
            assert.equal(job.status, 'completed', JSON.stringify(job.control));
            const output = await s.bytes(job.output);
            assert.deepEqual(output, expected, 'complete verified-ancestry oracle');
            if (fault === 'healthy') healthy = output;
            else assert.deepEqual(output, healthy, 'dispensable failure preserves exact output bytes');
          }
          const stateTasks = [...s.tables.projectSourceTasks.values()].filter(
            row => JSON.parse(row.input).kind === 'states',
          );
          assert.equal(stateTasks.length > 0, large, 'exercise the intended graph summary path');
          // The logical descriptor is present: the nested strict resolver must
          // cross the real sourceMutation ConvexError boundary, not probe.unavailable.
          assert(s.calls.includes('projectConvexSourceObjects:resolve'));
          assert.equal(s.tables.projectSourceSteps.size, 1);
          assert.equal(report.storageCalls, 0);
          const idle = s.calls.length;
          await s.drain();
          assert.equal(s.calls.length, idle);
          t.diagnostic(JSON.stringify({ large, required, fault, ...report }));
        } finally {
          s.restore();
        }
      }
    });

test('full worker retains unavailable descriptor probes until independent paths prove the cut', async t => {
  let healthy;
  const reports = [];
  for (const fault of ['healthy', 'common', 'required-side', 'required-base']) {
    const s = await scaleFixture();
    try {
      const h = await scenario(s, { requiredBase: fault === 'required-base' });
      if (fault !== 'healthy') {
        const absent = fault === 'required-side' ? h.a : h.common;
        const row = [...s.tables.projectObjects.values()].find(row => row.digest === absent.sha256);
        await s.ctx.db.patch(row._id, { removed: true });
      }
      const id = await s.enqueue(h.input),
        report = await s.drain(),
        job = await s.job(id);
      if (fault === 'required-side' || fault === 'required-base') {
        assert.equal(job.status, 'failed');
        assert.equal(job.control.failureCode, 'SOURCE_UNAVAILABLE');
        assert.equal(job.output, null);
      } else {
        assert.equal(job.status, 'completed');
        const bytes = await s.bytes(job.output);
        if (fault === 'healthy') healthy = bytes;
        else assert.deepEqual(bytes, healthy);
        assert.equal(s.readCounts.get(h.common.sha256) ?? 0, fault === 'healthy' ? 1 : 0);
      }
      assert.equal(s.tables.projectSourceSteps.size, 1);
      assert.equal(report.storageCalls, 0);
      const idle = s.calls.length;
      await s.drain();
      assert.equal(s.calls.length, idle);
      reports.push({ fault, commonReads: s.readCounts.get(h.common.sha256) ?? 0, ...report });
    } finally {
      s.restore();
    }
  }
  t.diagnostic(JSON.stringify({ reports }));
});

test('fan-out retains a failed common-manifest summary without discarding independent authenticated edges', async t => {
  let healthy;
  for (const corrupt of [false, true]) {
    const s = await scaleFixture();
    try {
      const h = await scenario(s, { large: true });
      if (corrupt) s.objects.set(h.common.sha256, Buffer.alloc(h.common.size, 120));
      const id = await s.enqueue(h.input),
        report = await s.drain(),
        job = await s.job(id);
      assert.equal(job.status, 'completed');
      const bytes = await s.bytes(job.output);
      if (!corrupt) healthy = bytes;
      else assert.deepEqual(bytes, healthy);
      assert(s.calls.includes('projectConvexSourceTask:run'), 'exercise child summary application');
      assert(report.maxRssBytes < 400 * 1024 * 1024);
      assert.equal(report.storageCalls, 0);
      t.diagnostic(JSON.stringify({ corrupt, ...report }));
    } finally {
      s.restore();
    }
  }
});

test('graph descriptor probes retain the active-execution fence', async () => {
  const s = await scaleFixture();
  try {
    const pin = await s.putSpec(Buffer.from('synthetic'));
    const h = await scenario(s),
      jobId = await s.enqueue(h.input);
    await s.drain();
    await assert.rejects(
      s.invoke('projectConvexSourceObjects:resolve', {
        projectId: s.projectId,
        jobId,
        step: 9999,
        digests: [pin.sha256],
        ancestry: false,
        known: [],
        probe: true,
      }),
      error => (error.data?.code ?? error.code) === 'SOURCE_JOB_FENCED',
    );
  } finally {
    s.restore();
  }
});
