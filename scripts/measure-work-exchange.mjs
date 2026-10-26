// Synthetic qualification only; no hosted project, credentials or canonical owner.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { digest } from '../dist/hash.js';
import { prepareNativeExchange, pushNativeExchange } from '../dist/native-exchange.js';
import { resolveExchangeRoot } from '../dist/native-exchange-tree.js';
const root = mkdtempSync(join(tmpdir(), 'forge-work-exchange-measure-'));
async function measure(records, sourceFiles) {
  console.error(JSON.stringify({ phase: 'fixture', records, sourceFiles }));
  const owner = join(root, `owner-${records}`);
  mkdirSync(owner);
  for (let i = 0; i < sourceFiles; i++)
    writeFileSync(join(owner, `file-${i}.ts`), `export const value${i} = ${i};\n`);
  initNative(owner);
  const w = new WorkService(owner),
    seed = w.execute({ action: 'intent', outcome: 'Retain synthetic history' }, w.status().revision).result,
    data = w.store.load();
  data.intents = Array.from({ length: records }, (_, i) => ({
    ...structuredClone(seed),
    id: digest(`intent-${i}`).slice(0, 8) + '-1234-4567-8123-' + digest(`intent-${i}`).slice(8, 20),
    outcome: `Synthetic record ${i}`,
    constraints: digest(`constraints-${i}`).repeat(4),
    notes: [{ kind: 'comment', at: '2026-01-01T00:00:00.000Z', text: digest(`note-${i}`).repeat(8) }],
  }));
  writeFileSync(join(w.store.directory, 'work.json'), JSON.stringify(data, null, 2));
  const objects = new Map();
  let sent = 0,
    count = 0;
  const transport = {
    metadataTrees: true,
    missing: async pins => pins.filter(p => !objects.has(p.sha256)).map(p => p.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, Buffer.from(bytes));
      sent += bytes.length;
      count++;
    },
    publish: async pin => pin.sha256,
  };
  console.error(JSON.stringify({ phase: 'seed', records }));
  const start = performance.now(),
    first = await pushNativeExchange(w.store, data.revision, randomUUID(), transport),
    seedMs = performance.now() - start;
  const current = w.store.load();
  current.revision++;
  current.intents[Math.floor(records / 2)].notes.push({
    kind: 'comment',
    at: '2026-01-01T01:00:00.000Z',
    text: 'One added observation',
  });
  writeFileSync(join(w.store.directory, 'work.json'), JSON.stringify(current, null, 2));
  console.error(JSON.stringify({ phase: 'delta', records }));
  const operation = randomUUID(),
    before = new Set(objects.keys());
  sent = 0;
  count = 0;
  const begin = performance.now(),
    delta = await pushNativeExchange(w.store, current.revision, operation, transport),
    deltaMs = performance.now() - begin;
  const prepared = await prepareNativeExchange(w.store, current.revision, operation, true),
    fullWork = readFileSync(join(prepared.directory, 'work.json')),
    rootBytes = objects.get(delta.digest),
    tree = JSON.parse(rootBytes),
    resolved = await resolveExchangeRoot(rootBytes, async pins => pins.map(p => objects.get(p.sha256)));
  assert.deepEqual(resolved.work, fullWork);
  assert.equal(resolved.manifest.toString(), prepared.json);
  assert.equal(sent, delta.uploadedBytes);
  assert.equal(count, delta.uploadedObjects);
  const newObjects = [...objects].filter(([id]) => !before.has(id));
  assert.equal(
    newObjects.reduce((n, [, bytes]) => n + bytes.length, 0),
    sent,
  );
  const retryStart = performance.now(),
    retry = await pushNativeExchange(w.store, current.revision, operation, transport),
    retryMs = performance.now() - retryStart;
  assert.equal(retry.uploadedBytes, 0);
  return {
    records,
    sourceFiles,
    logicalWorkBytes: fullWork.length,
    logicalManifestBytes: Buffer.byteLength(prepared.json),
    seedObjects: first.uploadedObjects,
    seedBytes: first.uploadedBytes,
    seedMs: +seedMs.toFixed(2),
    metadataEditUploadedObjects: delta.uploadedObjects,
    metadataEditUploadedBytes: delta.uploadedBytes,
    rootBytes: rootBytes.length,
    metadataEditMs: +deltaMs.toFixed(2),
    retryUploadedBytes: retry.uploadedBytes,
    retryMs: +retryMs.toFixed(2),
    exactLogicalBytesVerified: true,
    fullLogicalWorkObjectStored: objects.has(tree.work.sha256),
  };
}
try {
  const measurements = [];
  for (const scale of [1, 10]) measurements.push(await measure(1000 * scale, 100 * scale));
  assert(measurements.every(m => !m.fullLogicalWorkObjectStored));
  assert(
    measurements[1].metadataEditUploadedBytes < measurements[0].metadataEditUploadedBytes * 3,
    'An edit should not scale with tenfold retained metadata',
  );
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        measurement:
          'Synthetic production prepare/push from supported portable-JSON owner, in-memory missing-content transport; fixture construction avoids timing unrelated per-record fsync; elapsed is local preparation/validation+hashing, not network latency. Full snapshots are still read for preparation.',
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
