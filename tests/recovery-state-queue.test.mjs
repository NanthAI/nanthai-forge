// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { NativeSource } from '../dist/native-source.js';
import { RecoveryObjects } from '../dist/recovery-hosted-objects.js';
import { hostedRecoveryObjects } from '../dist/recovery-hosted-read.js';
import { digest } from '../dist/hash.js';

function fixture(t, count = 250) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-recovery-queue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(directory),
    receipts = join(directory, 'receipts');
  mkdirSync(receipts);
  const bytes = Array.from({ length: count }, (_, i) => Buffer.from(`shared ${i}`)),
    blobs = bytes.map(value => digest(value)),
    content = new Map(bytes.map((value, i) => [blobs[i], value])),
    states = [];
  for (let i = 0; i < 5; i++) {
    const value = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: i ? [states[i - 1].sha256] : [],
        files: blobs.map((blob, j) => ({ path: `file${j}`, blob, mode: 'file' })),
        message: `State ${i}`,
        at: '2026-10-27T00:00:00.000Z',
      }),
    );
    const pin = { sha256: digest(value), size: value.length };
    states.push(pin);
    content.set(pin.sha256, value);
  }
  const calls = [],
    batches = [];
  const transport = {
    objects: async ids => {
      calls.push([...ids]);
      return ids.map(sha256 => ({ sha256, size: content.get(sha256).length }));
    },
    download: async pin => content.get(pin.sha256),
    downloadBatch: async pins => {
      batches.push(pins.map(pin => pin.sha256));
      return Promise.all(pins.map(pin => transport.download(pin)));
    },
  };
  return {
    source,
    receipts,
    transport,
    calls,
    batches,
    blobs,
    states,
    content,
    queue: () => new RecoveryObjects(source, receipts, transport),
  };
}
function closure(source, root) {
  return new Set(hostedRecoveryObjects(source, { hostedRecovery: { objects: root, pages: null } }));
}

test('iterative closure deduplicates shared hashes, includes all parents and skips retained local files', async t => {
  const f = fixture(t);
  f.transport.downloadToFile = async () =>
    assert.fail('Small prefetched blobs reuse bounded verified reads.');
  // Measure the former lookup placement: every historical file reference was
  // resolved before the durable receipt was checked. Downloads are irrelevant.
  for (const state of f.states) {
    assert(state.sha256);
    for (const id of f.blobs) await f.transport.objects([id]);
  }
  const legacyLookups = f.calls.length;
  assert.equal(legacyLookups, 1250);
  f.calls.length = 0;
  for (const id of f.blobs.slice(0, 20)) f.source.put(f.content.get(id));
  const root = await f.queue().states(f.states);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.flat().length, 230);
  t.diagnostic(
    JSON.stringify({
      historicalFileReferences: 1250,
      legacyLookups,
      batchedLookups: f.calls.length,
      localFileHits: 20,
    }),
  );
  assert(f.calls.every(ids => ids.length <= 100));
  const ids = closure(f.source, root);
  assert([...f.blobs, ...f.states.map(pin => pin.sha256)].every(id => ids.has(id)));
  f.transport.objects = async () => assert.fail('completed State receipt must skip object queries');
  f.transport.download = async () => assert.fail('completed State receipt must skip downloads');
  assert.deepEqual(await f.queue().states(f.states), root, 'completed closure reuses the original receipt');
});

test('interrupted file pages resume discovery and durable opaque receipts without querying completed hashes', async t => {
  const f = fixture(t),
    download = f.transport.download;
  let fail = true;
  f.transport.download = async pin => {
    if (fail && pin.sha256 === f.blobs[150]) throw new Error('Synthetic interruption');
    return download(pin);
  };
  await assert.rejects(f.queue().states(f.states), /Synthetic interruption/);
  assert(existsSync(join(f.receipts, `discovered-${f.states[0].sha256}.json`)));
  assert(!existsSync(join(f.receipts, `state-${f.states[0].sha256}.json`)));
  const completed = new Set(f.calls[0]);
  f.calls.length = 0;
  fail = false;
  f.transport.download = async pin => {
    assert(!f.states.some(state => state.sha256 === pin.sha256), 'discovered State bytes stay retained');
    return download(pin);
  };
  const root = await f.queue().states(f.states);
  assert(f.calls.flat().every(id => !completed.has(id)));
  assert(f.blobs.every(id => closure(f.source, root).has(id)));
  assert.equal(
    JSON.parse(readFileSync(join(f.receipts, `state-${f.states[0].sha256}.json`))).root.sha256,
    root.sha256,
  );
});

test('revocation between lookup pages stops retention and leaves an incomplete State resumable', async t => {
  const f = fixture(t),
    objects = f.transport.objects;
  let pages = 0;
  f.transport.objects = async ids => {
    if (++pages === 2) throw Object.assign(new Error('Access changed'), { code: 'PROJECT_UNAVAILABLE' });
    return objects(ids);
  };
  await assert.rejects(f.queue().states(f.states), { code: 'PROJECT_UNAVAILABLE' });
  assert(!existsSync(join(f.receipts, `state-${f.states[0].sha256}.json`)));
  f.transport.objects = objects;
  await f.queue().states(f.states);
});

test('missing registration coverage traverses parents explicitly and malformed pins fail closed', async t => {
  const f = fixture(t, 2);
  const root = await f.queue().states([f.states.at(-1)]);
  const ids = closure(f.source, root);
  assert(f.states.every(pin => ids.has(pin.sha256)));
  assert(f.calls.flat().includes(f.states[0].sha256));
  await assert.rejects(f.queue().states([{ ...f.states[0], size: f.states[0].size + 1 }]), {
    code: 'INVALID_WORK_BACKUP',
  });
});

// Match existing source-return memory tests: collect within the RSS budget,
// instead of letting V8's default heap grow past it before collecting. This is
// a test-process constraint, not a recovery input or product limit.
test('2,500-State / 3,000-file recovery bounds lookup calls and peak RSS in a fresh process', async t => {
  const result = await promisify(execFile)(
    process.execPath,
    ['--max-old-space-size=128', '--max-semi-space-size=4', 'tests/recovery-state-queue-scale.mjs'],
    {
      cwd: new URL('../', import.meta.url),
      maxBuffer: 1024 * 1024,
    },
  );
  const measured = JSON.parse(result.stdout.trim());
  assert.equal(measured.uniqueObjects, 32000);
  assert(measured.lookupCalls <= 400);
  assert(measured.recoveryRssBytes < 256 * 1024 * 1024);
  t.diagnostic(JSON.stringify(measured));
});

test('interruption during State discovery resumes retained trees and preserves completed discovery records', async t => {
  const f = fixture(t, 2),
    object = f.source.object.bind(f.source);
  let stop = true;
  f.source.object = id => {
    if (stop && id === f.states[2].sha256) throw new Error('Synthetic discovery interruption');
    return object(id);
  };
  await assert.rejects(f.queue().states(f.states), /Synthetic discovery interruption/);
  assert(existsSync(join(f.receipts, `discovered-${f.states[0].sha256}.json`)));
  assert(!existsSync(join(f.receipts, `state-${f.states[0].sha256}.json`)));
  stop = false;
  f.transport.download = async pin => {
    assert(!f.states.some(state => state.sha256 === pin.sha256));
    return f.content.get(pin.sha256);
  };
  const root = await f.queue().states(f.states);
  const ids = closure(f.source, root);
  assert([...f.blobs, ...f.states.map(pin => pin.sha256)].every(id => ids.has(id)));
});

test('lookup pages must return the exact ordered pins before downloading unknown source', async t => {
  const f = fixture(t, 2);
  f.transport.objects = async ids => ids.map(sha256 => ({ sha256: 'a'.repeat(64), size: 1 }));
  await assert.rejects(f.queue().states(f.states), { code: 'SOURCE_UNAVAILABLE' });
  assert(!existsSync(join(f.receipts, `state-${f.states[0].sha256}.json`)));
});

test('completed States from separate walks retain every distinct closure without new reads', async t => {
  const f = fixture(t, 2);
  await f.queue().states([f.states[0]]);
  await f.queue().states([f.states.at(-1)]);
  f.transport.objects = async () => assert.fail('Completed closures need no project lookup.');
  f.transport.download = async () => assert.fail('Completed closures need no download.');
  const root = await f.queue().states([f.states[0], f.states.at(-1)]);
  const ids = closure(f.source, root);
  assert([...f.blobs, ...f.states.map(pin => pin.sha256)].every(id => ids.has(id)));
});
