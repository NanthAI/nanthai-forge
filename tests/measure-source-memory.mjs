// SPDX-License-Identifier: Apache-2.0
// nforge heavy node tests/measure-source-memory.mjs OUTPUT [PAIRS=3] [SIZES=4000,29000,60000,100000,190000]
// Offline only. Every provider action is a fresh process; never imports live credentials.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { sourceMemoryFixture } from './source-memory-fixture.mjs';
const destination = process.argv[2],
  pairs = Number(process.argv[3] ?? 3);
const sizes = (process.argv[4] ?? '4000,29000,60000,100000,190000').split(',').map(Number);
assert(destination && Number.isSafeInteger(pairs) && pairs > 0);
const report = {
  schema: 1,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  startedAt: new Date().toISOString(),
  pairs,
  sizes,
  voids: [],
  runs: [],
  sourceHashes: {},
};
for (const path of [
  'convex/projectConvexSourceNode.ts',
  'convex/projectConvexSourceTransport.ts',
  'src/hosted-source-step.ts',
  'src/hosted-source-step-merge.ts',
  'src/native-source.ts',
  'tests/source-stream-sync.mjs',
  'tests/source-stream-manifest.mjs',
  'tests/source-stream-provider.mjs',
  'tests/source-memory-fixture.mjs',
  'tests/measure-source-memory.mjs',
])
  report.sourceHashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');

async function run(files, phase, pair, streaming = false) {
  const fixture = await sourceMemoryFixture(files, phase, streaming),
    { s, input } = fixture;
  try {
    const load = loadavg(),
      startEvents = s.events.length;
    const id = await s.enqueue(input),
      countsStart = s.counts.length;
    const metrics = await s.drain({ memoryBound: false });
    const dbCounts = s.counts.slice(countsStart);
    const job = await s.job(id);
    assert.equal(job.status, 'completed', JSON.stringify(job.control));
    const result = JSON.parse(await s.bytes(job.output)),
      state = result.state ?? result.result.state;
    const bytes = await s.bytes(state);
    const parsed = JSON.parse(bytes);
    assert.equal(parsed.files.length, files);
    assert.equal(digest(bytes), state.sha256);
    const events = s.events.slice(startEvents);
    const value = {
      files,
      phase,
      pair,
      implementation: streaming ? 'stream' : 'current',
      at: new Date().toISOString(),
      load,
      stateBytes: fixture.stateBytes,
      ...metrics,
      r2: {
        get: events.filter(e => e.fetch).length,
        head: events.filter(e => e.head).length,
        put: events.filter(e => e.put !== undefined).length,
        putBytes: events.reduce((sum, e) => sum + (e.put ?? 0), 0),
      },
      dbReadBytes: dbCounts.reduce((sum, row) => sum + row.readBytes, 0),
      dbWriteBytes: dbCounts.reduce((sum, row) => sum + row.writeBytes, 0),
      result,
      state,
      stateByteEquality: null,
      actions: s.metrics.map(m => ({ name: m.name, elapsedMs: m.elapsedMs, maxRssBytes: m.maxRssBytes })),
    };
    const idle = await s.drain({ memoryBound: false });
    assert.equal(idle.calls, 0);
    assert.equal(idle.readObjects, 0);
    return { value, bytes };
  } finally {
    await fixture.dispose();
  }
}
// Same provider metrics, including parent-process scheduling/IPC in wall time on both arms.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const files of sizes) {
  for (let pair = 1; pair <= pairs; pair++) {
    for (const phase of ['save', 'sync', 'compose', 'conflict-sync']) {
      const a = await run(files, phase, pair);
      report.runs.push(a.value);
      if (phase === 'sync') {
        const b = await run(files, phase, pair, true);
        assert.deepEqual(b.value.result, a.value.result, 'all exact sync result fields match');
        assert(b.bytes.equals(a.bytes), 'resulting States are byte-identical');
        for (const key of ['get', 'head', 'put', 'putBytes'])
          assert(b.value.r2[key] <= a.value.r2[key], `prototype must not raise R2 ${key}`);
        b.value.stateByteEquality = true;
        report.runs.push(b.value);
      }
      await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(
        JSON.stringify({
          files,
          pair,
          phase,
          rssMiB: a.value.maxRssBytes / 1048576,
          wallMs: a.value.wallMs,
        }) + '\n',
      );
    }
  }
}
report.finishedAt = new Date().toISOString();
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
