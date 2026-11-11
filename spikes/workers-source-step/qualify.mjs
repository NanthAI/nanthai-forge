// SPDX-License-Identifier: Apache-2.0
import { saveBytes } from '../../dist/hosted-save.js';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { writeFileSync } from 'node:fs';
import { decision } from '../../tests/workers-source-step-spike-metrics.mjs';
import { createHash } from 'node:crypto';
import { seedFixture, shapes } from './fixtures.mjs';
import { connectInspector } from './inspector.mjs';
const objects = new Map(),
  descriptors = [];
const s = {
  async putSpec(bytes, _, generation, graph = {}) {
    const pin = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    objects.set(pin.sha256, bytes);
    descriptors.push({ object: pin, recipe: null, generation, parents: graph.parents });
    return pin;
  },
  async json(v) {
    return this.putSpec(saveBytes(v));
  },
};
const shape = shapes.find(s => s.name === (process.argv[2] ?? 'smoke'));
const input = await seedFixture(s, shape);
const mf = new Miniflare({
  name: 'source-spike',
  modules: true,
  script: readFileSync(new URL('dist/worker.mjs', import.meta.url), 'utf8'),
  compatibilityDate: '2026-07-30',
  compatibilityFlags: ['nodejs_compat'],
  r2Buckets: ['SOURCE'],
  inspectorPort: 0,
});
let inspector;
try {
  const bucket = await mf.getR2Bucket('SOURCE');
  for (const [id, bytes] of objects) await bucket.put(id, bytes);
  inspector = await connectInspector(await mf.getInspectorURL());
  const load = loadavg(),
    started = performance.now();
  const response = await mf.dispatchFetch('http://local/', {
    method: 'POST',
    body: JSON.stringify({ input, descriptors, profile: true }),
  });
  if (!response.ok) throw Error(`Local Worker failed: HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  const record = {
    shape,
    input,
    ...result,
    samples: inspector.samples,
    load,
    diagnosticWallMs: performance.now() - started,
    cpuMs: null,
    decision: decision({ count: shape.count, samples: inspector.samples, output: result.output }),
  };
  const text = JSON.stringify(record, null, 2);
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) writeFileSync(process.argv[outputIndex + 1], text + '\n');
  console.log(text);
} finally {
  inspector?.close();
  await mf.dispose();
}
