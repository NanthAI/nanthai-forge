// SPDX-License-Identifier: Apache-2.0
// Pure source-kernel comparison. No network, hosted writes, CLI substitution or repository code.
// Usage: nforge heavy node tests/measure-conflict-reentry.mjs BASELINE_DIST OUTPUT.json [pairs]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpuUsage, memoryUsage } from 'node:process';
import { loadavg } from 'node:os';
import * as candidate from '../dist/hosted-source-step.js';
import { digest } from '../dist/hash.js';
import { parseNativeState } from '../dist/state/format.js';

const [baselinePath, output, repeats = '11'] = process.argv.slice(2);
assert(baselinePath && output, 'Pass the baseline dist and private output file');
const baseline = await import(pathToFileURL(join(resolve(baselinePath), 'hosted-source-step.js')));
const at = '2026-01-01T00:00:00.000Z';
function fixture(count) {
  const objects = new Map(),
    parents = new Map();
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(JSON.stringify(value));
  const shared = put('base\n');
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.txt`,
    mode: 'file',
    blob: shared.sha256,
  }));
  const state = (files, edges, message) => {
    const pin = json({ schema: 1, kind: 'forge-source-state', parents: edges, files, message, at });
    parents.set(pin.sha256, edges);
    return pin;
  };
  const base = state(files, [], 'base');
  const changed = text => [{ ...files[0], blob: put(text).sha256 }, ...files.slice(1)];
  const left = state(changed('left\n'), [base.sha256], 'left');
  const right = state(changed('right\n'), [base.sha256], 'right');
  const input = work =>
    json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work,
      message: 'sync',
      at,
    });
  const ref = object => ({ object, recipe: null });
  const sync = input({ mode: 'sync', left: ref(left), right: ref(right) });
  return { objects, parents, put, json, state, changed, left, right, input, ref, sync };
}
async function run(kernel, f, input) {
  const objects = new Map(f.objects),
    reads = [],
    uploads = [];
  const io = {
    stateParents: id => f.parents.get(id),
    describeBatch: async ids => ids.map(id => f.ref({ sha256: id, size: objects.get(id).length })),
    fanout: () => assert.fail('small calculations remain inline'),
    read: async pin => {
      reads.push(pin.sha256);
      return [objects.get(pin.sha256)];
    },
    upload: async (pin, stream) => {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const bytes = Buffer.concat(parts);
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, bytes);
      uploads.push(pin.sha256);
    },
  };
  let cursor = kernel.initialSourceStep(input),
    steps = 0;
  const start = performance.now(),
    cpu = cpuUsage();
  while (cursor.phase !== 'done') {
    assert(++steps < 10, 'finite source continuations');
    cursor = (await kernel.runSourceStep(cursor, io)).cursor;
  }
  const used = cpuUsage(cpu),
    wallMs = performance.now() - start;
  return {
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    steps,
    reads: reads.length,
    readBytes: reads.reduce((n, id) => n + objects.get(id).length, 0),
    output: cursor.output.sha256,
    objects,
  };
}
const report = {
  schema: 1,
  node: process.version,
  method:
    'alternating AB/BA; fresh object maps; module load and fixture setup excluded; CPU and wall overlap',
  baselineStep: createHash('sha256')
    .update(readFileSync(join(baselinePath, 'hosted-source-step.js')))
    .digest('hex'),
  candidateStep: createHash('sha256')
    .update(readFileSync(new URL('../dist/hosted-source-step.js', import.meta.url)))
    .digest('hex'),
  samples: [],
};
for (const files of [4000, 29000]) {
  const f = fixture(files),
    qualified = await run(candidate, f, f.sync);
  const result = JSON.parse(qualified.objects.get(qualified.output)).result;
  for (const [id, bytes] of qualified.objects) f.objects.set(id, bytes);
  const draft = result.state;
  f.parents.set(draft.sha256, [f.left.sha256]);
  const saved = f.state(f.changed('resolved\n'), [draft.sha256], 'saved');
  const resolveInput = f.input({
    mode: 'resolve',
    left: f.ref(saved),
    resolution: {
      candidateId: null,
      conflicts: result.conflicts,
      left: f.left.sha256,
      right: f.right.sha256,
      draftHead: draft.sha256,
      status: 'pending',
    },
  });
  // Qualify each exact output before starting the measured pairs.
  for (const input of [f.sync, resolveInput]) {
    const a = await run(baseline, f, input),
      b = await run(candidate, f, input);
    assert.equal(a.output, b.output);
    assert.deepEqual(
      parseNativeState(a.objects.get(JSON.parse(a.objects.get(a.output)).result.state.sha256)),
      parseNativeState(b.objects.get(JSON.parse(b.objects.get(b.output)).result.state.sha256)),
    );
  }
  for (let pair = 0; pair < Number(repeats); pair++)
    for (const [operation, input] of [
      ['sync', f.sync],
      ['resolve', resolveInput],
    ]) {
      const order =
          pair % 2
            ? [
                ['b', candidate],
                ['a', baseline],
              ]
            : [
                ['a', baseline],
                ['b', candidate],
              ],
        values = {};
      const load = loadavg();
      for (const [label, kernel] of order) {
        const { objects, ...value } = await run(kernel, f, input);
        values[label] = value;
      }
      assert.equal(values.a.output, values.b.output);
      report.samples.push({ files, operation, pair, order: order.map(([label]) => label), load, ...values });
    }
}
report.peakProcessRss = memoryUsage().rss;
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    pairsPerShapeAndOperation: Number(repeats),
    samples: report.samples.length,
    exactOutputs: true,
  }),
);
