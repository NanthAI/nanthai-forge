// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { nextStateGeneration, validStateGeneration } from '../dist/state-generation.js';
import { workerObjectSchema } from '../dist/hosted-source-worker-format.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));

test('topological levels use every verified parent and preserve missing/overflow metadata', () => {
  const values = { a: 1, b: 400, c: 2 };
  assert.equal(
    nextStateGeneration([], id => values[id]),
    1,
  );
  assert.equal(
    nextStateGeneration(['a', 'b', 'c', 'a'], id => values[id]),
    401,
  );
  assert.equal(
    nextStateGeneration(['a', 'missing'], id => values[id]),
    undefined,
  );
  assert.equal(
    nextStateGeneration(['a'], () => Number.MAX_SAFE_INTEGER),
    undefined,
  );
  for (const value of [0, -1, 1.5, NaN, Infinity, '5', null]) assert(!validStateGeneration(value));
  assert(
    !workerObjectSchema.safeParse({
      object: { sha256: 'a'.repeat(64), size: 0 },
      recipe: null,
      stateGeneration: 100,
    }).success,
    'plans and hints cannot supply generation proof',
  );
});
test('worker derives generation from exact output parents and trusted descriptor metadata, no extra calls', async t => {
  const r2 = fakeSourceR2(t),
    parent = 'a'.repeat(64),
    calls = [];
  const { io, outputs } = convexSourceTransport(
    {
      runMutation: async (ref, input) => {
        calls.push(getFunctionName(ref));
        return JSON.stringify(
          input.digests.map(id => ({
            descriptor: { object: { sha256: id, size: 0 }, recipe: null },
            stateGeneration: id === parent ? 7 : 999,
            storageId: null,
            url: 'https://unused.invalid',
          })),
        );
      },
    },
    { projectId: 'project', jobId: 'job', step: 0 },
  );
  await io.describeBatch([parent]);
  const upload = async value => {
    const bytes = Buffer.from(JSON.stringify(value)),
      pin = { sha256: digest(bytes), size: bytes.length };
    await io.upload(
      pin,
      (async function* () {
        yield bytes;
      })(),
    );
    return pin;
  };
  const state = parents => ({
    schema: 1,
    kind: 'forge-source-state',
    parents,
    files: [],
    message: 'test',
    at: '2026-01-01T00:00:00.000Z',
  });
  const child = await upload(state([parent])),
    grandchild = await upload(state([child.sha256]));
  await upload(state(['b'.repeat(64)]));
  await upload({ kind: 'forge-source-state', ordinary: 'source blob' });
  assert.deepEqual(
    outputs.map(row => row.stateGeneration),
    [8, 9, undefined, undefined],
  );
  assert.equal(io.stateGeneration(grandchild.sha256), 9);
  assert.deepEqual(calls, ['projectConvexSourceObjects:resolve']);
  assert(
    r2.requests.every(method => ['PUT', 'HEAD'].includes(method)),
    'no State or parent byte rewrites',
  );
});
test('generation cursor fields are optional for in-flight rows and roundtrip only in R2 progress', async () => {
  const stored = new Map(),
    input = { sha256: 'a'.repeat(64), size: 0 };
  for (const extra of [
    {},
    { generations: { [input.sha256]: 4 }, ancestryCuts: [input.sha256], generationFallback: false },
  ]) {
    const cursor = { ...initialSourceStep(input), ...extra };
    const saved = await saveSourceProgress(cursor, null, async bytes => {
      const id = digest(bytes);
      stored.set(id, bytes);
      return id;
    });
    assert.deepEqual(
      (await loadSourceProgress(stored.get(saved.id), async id => stored.get(id))).cursor,
      cursor,
    );
  }
});
