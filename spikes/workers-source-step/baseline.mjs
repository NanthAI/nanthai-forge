// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { scaleFixture } from '../../tests/convex-source-scale-fixture.mjs';
import { shapes, seedFixture } from './fixtures.mjs';
const shape = shapes.find(s => s.name === (process.argv[2] ?? '29k-compose'));
if (!shape) throw Error('Unknown spike shape');
const s = await scaleFixture({ parallelism: 1 });
try {
  const input = await seedFixture(s, shape),
    offset = s.counts.length;
  const descriptors = [...s.tables.projectObjects.values()].map(row => ({
    object: { sha256: row.digest, size: row.size },
    recipe: null,
    generation: row.stateGeneration,
    parents: row.stateParents,
  }));
  const inputs = [...s.objects].map(([id, bytes]) => [id, bytes.toString('base64')]);
  const load = loadavg(),
    startedAt = new Date().toISOString();
  const id = await s.enqueue(input),
    report = await s.drain({ memoryBound: false }),
    job = await s.job(id);
  assert.equal(job.status, 'completed');
  const events = s.events;
  const r2 = {
    get: events.filter(e => e.fetch).length,
    head: events.filter(e => e.head).length,
    put: events.filter(e => e.put !== undefined).length,
    putBytes: events.reduce((sum, e) => sum + (e.put ?? 0), 0),
    readBytes: report.readBytes,
  };
  const db = s.counts.slice(offset);
  const sample = {
    shape,
    input,
    output: job.output,
    report,
    r2,
    load,
    startedAt,
    dbReadBytes: db.reduce((n, c) => n + c.readBytes, 0),
    dbWriteBytes: db.reduce((n, c) => n + c.writeBytes, 0),
  };
  if (process.argv.includes('--export-inputs')) Object.assign(sample, { descriptors, inputs });
  console.log(JSON.stringify(sample));
} finally {
  s.restore();
}
