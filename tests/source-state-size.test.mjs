// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceStateLimits, sourceMemoryMargin, assertSourceStateSize } from '../dist/source-state-size.js';
import { sourceMemoryFixture } from './source-memory-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const metadata = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
const saves = await import(moduleUrl('../convex/projectHostedSaveStore.ts'));
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));

for (const [phase, limits] of Object.entries(sourceStateLimits)) {
  for (const dimension of ['fileCount', 'manifestBytes'])
    test(`${phase} accepts ${dimension} at its envelope and refuses limit+1 with one next step`, () => {
      const size = { fileCount: 1, manifestBytes: 1, [dimension]: limits[dimension] };
      assert.doesNotThrow(() => assertSourceStateSize(phase, size));
      assert.throws(
        () => assertSourceStateSize(phase, { ...size, [dimension]: size[dimension] + 1 }),
        error => {
          assert.equal(error.code, 'SOURCE_STATE_TOO_LARGE');
          assert.match(
            error.message,
            new RegExp(`${phase}: ${dimension} ${size[dimension] + 1} exceeds ${limits[dimension]}`),
          );
          assert.match(error.message, /Split the repository\./);
          assert.match(error.message, /source-exchange\.md#supported-repository-envelope/);
          assert(error.message.length <= 240, 'terminal job retains the complete message');
          return true;
        },
      );
      assert.doesNotThrow(
        () => assertSourceStateSize(phase, undefined),
        'legacy metadata is not a new refusal',
      );
    });
}

test('the envelope margin covers twice the largest measured repeat spread; Forge, counted zoo and 29k shapes pass', async () => {
  const evidence = JSON.parse(await readFile(new URL('./fixtures/source-step-memory.json', import.meta.url)));
  const groups = new Map();
  for (const row of evidence.runs.filter(row => row.implementation === 'current')) {
    const key = `${row.phase}:${row.files}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.maxRssBytes);
  }
  const spreads = [...groups.values()].map(values => {
    values.sort((a, b) => a - b);
    assert.equal(values.length, 3);
    return values[2] / values[1] - 1;
  });
  assert(Math.max(...spreads) * 2 <= sourceMemoryMargin);
  // Deep-path bytes are from the retained 162 B/entry shape, not content bytes.
  for (const files of [4222, 1387, 29000])
    for (const phase of Object.keys(sourceStateLimits))
      assert.doesNotThrow(() =>
        assertSourceStateSize(phase, { fileCount: files, manifestBytes: files * 162 + 112 }),
      );
});

async function dimensions(s, fileCount) {
  for (const row of s.tables.projectObjects.values())
    if (row.stateParents) row.stateSize = { fileCount, manifestBytes: row.size };
}
for (const phase of ['save', 'sync', 'compose', 'conflict-sync'])
  test(`${phase} registered source action honors the boundary before source GET/PUT and settles terminal without retries`, async () => {
    // Synthetic trusted counts exercise the limit without allocating 100k files.
    for (const over of [false, true]) {
      const fixture = await sourceMemoryFixture(4, phase),
        { s, input } = fixture;
      try {
        const limits = sourceStateLimits[phase];
        await dimensions(s, limits.fileCount + Number(over));
        const sourceIds = new Set(
          [...s.tables.projectObjects.values()].filter(row => row.stateParents).map(row => row.digest),
        );
        // Published immutable inputs are already source-referenced in production.
        for (const row of s.tables.projectObjects.values()) row.sourceReferenced = true;
        const before = JSON.stringify([...s.tables.projectObjects]);
        const jobId = await s.enqueue(input);
        await s.drain();
        const job = await s.job(jobId);
        if (over) {
          assert.equal(job.status, 'failed');
          assert.equal(job.control.failureCode, 'SOURCE_STATE_TOO_LARGE');
          const namedPhase = phase === 'conflict-sync' ? 'sync' : phase;
          assert.match(
            job.control.failureReason,
            new RegExp(`${namedPhase}: fileCount ${limits.fileCount + 1} exceeds ${limits.fileCount}`),
          );
          assert.equal(
            JSON.stringify([...s.tables.projectObjects]),
            before,
            'no source objects or metadata written',
          );
          assert(!s.events.some(event => event.put !== undefined), 'no output PUT');
          assert(!s.events.some(event => sourceIds.has(event.fetch)), 'no State body GET');
          assert(!s.calls.includes('projectConvexSourceStore:failed'), 'capacity is not a platform retry');
          const schedules = s.scheduled.size,
            calls = s.calls.length;
          await s.drain();
          assert.equal(s.calls.length, calls, 'idle and terminal drain make zero calls');
          assert.equal(s.scheduled.size, schedules, 'no retry scheduled');
        } else {
          assert.equal(job.status, 'completed');
          for (const row of s.tables.projectObjects.values())
            if (row.stateParents && !sourceIds.has(row.digest))
              assert.deepEqual(
                row.stateSize,
                { fileCount: 4, manifestBytes: row.size },
                'writer records logical dimensions in the original output write',
              );
        }
      } finally {
        await fixture.dispose();
      }
    }
  });

test('already-read metadata refuses admission and packed/recipe locations before I/O; legacy loads enrich only their completion', async () => {
  const fixture = await sourceMemoryFixture(4, 'save'),
    { s, input } = fixture;
  try {
    const state = [...s.tables.projectObjects.values()].find(row => row.stateParents);
    state.stateSize = { fileCount: sourceStateLimits.save.fileCount + 1, manifestBytes: state.size };
    const original = JSON.stringify([...s.tables.projectObjects]);
    await assert.rejects(
      s.run('size-admission', () => saves.saveObject(s.ctx, s.projectId, { sha256: state.digest }, 'save')),
      { code: 'SOURCE_STATE_TOO_LARGE' },
    );
    assert.equal(JSON.stringify([...s.tables.projectObjects]), original);
    for (const storage of [{}, { range: { offset: 8, total: state.size + 8 } }, { closure: [] }]) {
      const pin = { sha256: state.digest, size: state.size };
      const transport = convexSourceTransport({}, { projectId: s.projectId, jobId: 'unused', step: 0 }, [
        {
          descriptor: { object: pin, recipe: storage.closure ? pin : null },
          stateSize: state.stateSize,
          storageId: null,
          url: null,
          ...storage,
        },
      ]);
      transport.io.setSourceSizePhase('save');
      assert.throws(() => transport.io.expectState(pin.sha256), { code: 'SOURCE_STATE_TOO_LARGE' });
      assert.equal(transport.reads.objects, 0);
      assert.equal(transport.outputs.length, 0);
    }
    delete state.stateSize;
    const id = await s.enqueue(input);
    await s.drain();
    assert.equal((await s.job(id)).status, 'completed');
    assert.deepEqual(s.tables.projectObjects.get(state._id).stateSize, {
      fileCount: 4,
      manifestBytes: state.size,
    });
    const written = JSON.stringify([...s.tables.projectObjects]);
    await s.run('immutable-size-replay', () =>
      metadata.recordSourceStateSizes(s.ctx, s.projectId, [
        { sha256: state.digest, size: state.size, fileCount: 4, manifestBytes: state.size },
      ]),
    );
    assert.equal(
      JSON.stringify([...s.tables.projectObjects]),
      written,
      'same metadata replays without a write',
    );
    await assert.rejects(
      s.run('immutable-size-change', () =>
        metadata.recordSourceStateSizes(s.ctx, s.projectId, [
          { sha256: state.digest, size: state.size, fileCount: 5, manifestBytes: state.size },
        ]),
      ),
      { code: 'SOURCE_HASH_MISMATCH' },
    );
  } finally {
    await fixture.dispose();
  }
});

for (const files of [4000, 29000])
  for (const phase of ['save', 'sync', 'compose', 'conflict-sync'])
    test(`${files}-file ${phase} retains exact State bytes and calls/R2 budgets across legacy and sized inputs`, async t => {
      const evidence = JSON.parse(
        await readFile(new URL('./fixtures/source-step-memory.json', import.meta.url)),
      );
      const expected = evidence.runs.find(
        row => row.implementation === 'current' && row.files === files && row.phase === phase,
      );
      const legacy = await sourceMemoryFixture(files, phase);
      let before;
      try {
        const id = await legacy.s.enqueue(legacy.input);
        const metrics = await legacy.s.drain({ memoryBound: false });
        const job = await legacy.s.job(id);
        before = {
          result: JSON.parse(await legacy.s.bytes(job.output)),
          calls: metrics.functionCalls,
          r2: {
            get: legacy.s.events.filter(e => e.fetch).length,
            head: legacy.s.events.filter(e => e.head).length,
            put: legacy.s.events.filter(e => e.put !== undefined).length,
            putBytes: legacy.s.events.reduce((sum, e) => sum + (e.put ?? 0), 0),
          },
        };
      } finally {
        await legacy.dispose();
      }
      const fixture = await sourceMemoryFixture(files, phase),
        { s, input } = fixture;
      try {
        await dimensions(s, files);
        const id = await s.enqueue(input);
        const metrics = await s.drain({ memoryBound: false });
        const job = await s.job(id);
        assert.equal(job.status, 'completed');
        const bytes = await s.bytes(job.output);
        const result = JSON.parse(bytes);
        assert.deepEqual(result, before.result, 'metadata never changes logical State/result identity');
        const outputState = result.state ?? result.result.state;
        assert.deepEqual(outputState, expected.state, 'logical State still matches the measured spike');
        assert.equal(metrics.functionCalls, before.calls, 'zero added Convex calls');
        assert(
          metrics.functionCalls <= expected.functionCalls,
          'also retains the original spike call ceiling; fewer descriptor calls are allowed',
        );
        const r2 = {
          get: s.events.filter(event => event.fetch).length,
          head: s.events.filter(event => event.head).length,
          put: s.events.filter(event => event.put !== undefined).length,
          putBytes: s.events.reduce((sum, event) => sum + (event.put ?? 0), 0),
        };
        assert.deepEqual(r2, before.r2, 'zero added R2 requests or source bytes');
        assert.equal(metrics.storageCalls, 0, 'logical bytes stay in R2');
        assert(
          metrics.maxRssBytes < 512 * 1024 * 1024,
          'supported shape remains below action memory ceiling',
        );
        const row = [...s.tables.projectObjects.values()].find(row => row.digest === outputState.sha256);
        if (row) assert.deepEqual(row.stateSize, { fileCount: files, manifestBytes: row.size });
        t.diagnostic(
          JSON.stringify({
            files,
            phase,
            functionCalls: metrics.functionCalls,
            documentsRead: metrics.documentsRead,
            documentsWritten: metrics.documentsWritten,
            maxRssBytes: metrics.maxRssBytes,
            r2,
          }),
        );
      } finally {
        await fixture.dispose();
      }
    });

test('oversized metadata-only ancestor hints stay usable until that exact State body is needed', async () => {
  const pin = { sha256: '1'.repeat(64), size: 200 };
  let calls = 0;
  const transport = convexSourceTransport(
    {
      runMutation: async () => {
        calls++;
        return JSON.stringify([
          {
            descriptor: { object: pin, recipe: null },
            stateParents: [],
            stateSize: { fileCount: sourceStateLimits.sync.fileCount + 1, manifestBytes: pin.size },
            storageId: null,
            url: null,
          },
        ]);
      },
    },
    { projectId: 'synthetic', jobId: 'synthetic', step: 0 },
  );
  transport.io.setSourceSizePhase('sync');
  assert.equal((await transport.io.ancestry([pin.sha256], [])).length, 1);
  transport.io.setSourceSizePhase('sync');
  assert.deepEqual(
    transport.io.stateParents(pin.sha256),
    [],
    'known edges can prove a cut without loading that State',
  );
  assert.throws(() => transport.io.expectState(pin.sha256), { code: 'SOURCE_STATE_TOO_LARGE' });
  assert.equal(calls, 1, 'no extra metadata read');
  assert.equal(transport.reads.objects, 0);
  assert.equal(transport.outputs.length, 0);
});

test('State-shaped file content remains readable; the guard applies only when interpreting it as a State', async () => {
  const { digest } = await import('../dist/hash.js');
  const text = JSON.stringify({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [],
    message: '',
    at: '2026-01-01T00:00:00.000Z',
  });
  const bytes = Buffer.from(text),
    pin = { sha256: digest(bytes), size: bytes.length };
  const transport = convexSourceTransport(
    {},
    { projectId: 'synthetic', jobId: 'synthetic', step: 0 },
    [
      {
        descriptor: { object: pin, recipe: null },
        storageId: null,
        url: null,
        stateSize: { fileCount: sourceStateLimits.sync.fileCount + 1, manifestBytes: pin.size },
      },
    ],
    undefined,
    { preloaded: [{ ...pin, text }], bindings: [{ ...pin, r2Key: `v1/p/synthetic/o/${pin.sha256}` }] },
  );
  transport.io.setSourceSizePhase('sync');
  const parts = [];
  for await (const part of await transport.io.read(pin)) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), bytes, 'file bodies are outside the manifest envelope');
  assert.throws(() => transport.io.expectState(pin.sha256), { code: 'SOURCE_STATE_TOO_LARGE' });
  assert.equal(transport.outputs.length, 0);
});

test('V8 save refuses an oversized hinted baseline before starting concurrent protocol or State reads', async () => {
  const { runSmallSourceSave } = await import('../dist/hosted-source-small-save.js');
  const pin = { sha256: '2'.repeat(64), size: 1 };
  let reads = 0;
  await assert.rejects(
    runSmallSourceSave(
      pin,
      {
        expectState: () =>
          assertSourceStateSize('save', {
            fileCount: sourceStateLimits.save.fileCount + 1,
            manifestBytes: 1,
          }),
        read: () => {
          reads++;
          assert.fail('no source or protocol read after known refusal');
        },
        upload: () => assert.fail('no output'),
      },
      [pin],
    ),
    { code: 'SOURCE_STATE_TOO_LARGE' },
  );
  assert.equal(reads, 0);
});
