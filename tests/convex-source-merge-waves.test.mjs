// SPDX-License-Identifier: Apache-2.0
// Issue 1eef1b43 line 3: a conflict sync, its resolve and a compose read the merge inputs they
// need in overlapped waves (the merge base manifest with the tips, the draft and conflict page
// with the saved head), and no object twice, on the real Convex handlers. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { parseNativeState } from '../dist/state/format.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { digest } from '../dist/hash.js';

const resolveCall = 'projectConvexSourceObjects:resolve';
async function history(s, { conflict = true } = {}) {
  const generations = new Map();
  const state = async (files, parents) => {
    const generation = 1 + Math.max(0, ...parents.map(id => generations.get(id)));
    const pin = await s.putSpec(
      Buffer.from(saveBytes({ schema: 1, kind: 'forge-source-state', parents, files, message: 'm', at })),
      undefined,
      generation,
      { parents },
    );
    generations.set(pin.sha256, generation);
    return pin;
  };
  const blob = async text => (await s.putSpec(Buffer.from(text))).sha256;
  const body = (tag, i) => Array.from({ length: 30 }, (_, k) => `${tag} ${i} ${k}`).join('\n') + '\n';
  const files = [];
  for (let i = 0; i < 40; i++)
    files.push({ path: `dir${i % 4}/f${i}.txt`, mode: 'file', blob: await blob(body('base', i)) });
  files.push({ path: 'shared.txt', mode: 'file', blob: await blob('a\nb\nc\n') });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const root = await state(files, []);
  // Main moves five States ahead; its first State edits the shared file's first line.
  let main = root,
    tip = files;
  for (let i = 0; i < 5; i++) {
    const next = [];
    for (const file of tip)
      next.push(
        file.path === `dir${i % 4}/f${i}.txt`
          ? { ...file, blob: await blob(body('main', i)) }
          : file.path === 'shared.txt' && i === 0
            ? { ...file, blob: await blob('MAIN\nb\nc\n') }
            : file,
      );
    tip = next;
    main = await state(tip, [main.sha256]);
  }
  const laneFiles = [];
  for (const file of files)
    laneFiles.push(
      file.path === (conflict ? 'shared.txt' : 'dir3/f39.txt')
        ? { ...file, blob: await blob(conflict ? 'LANE\nb\nc\n' : body('lane', 39)) }
        : file,
    );
  const lane = await state(laneFiles, [root.sha256]);
  generations.set(root.sha256, 1);
  return { root, main, lane, state, blob, generations };
}
const ref = object => ({ object, recipe: null });
async function run(s, input) {
  const start = s.events.length,
    id = await s.enqueue(input);
  await s.drain();
  const job = await s.job(id);
  assert.equal(job.status, 'completed');
  return { output: job.output, events: s.events.slice(start) };
}
/** The same input on the local reference worker; its uploads stay out of the fixture's store. */
async function reference(s, input) {
  const uploaded = new Map(),
    bytes = async id => uploaded.get(id) ?? (await s.bytes({ sha256: id }));
  const out = await buildHostedSourceState(input, {
    async describeBatch(ids) {
      return Promise.all(ids.map(async id => ref({ sha256: id, size: (await bytes(id)).length })));
    },
    async read(pin) {
      return [await bytes(pin.sha256)];
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const b = Buffer.concat(parts);
      assert.equal(digest(b), pin.sha256);
      uploaded.set(pin.sha256, b);
    },
  });
  return out.output;
}
/** Descriptor calls can interleave with GET starts: prefetch overlaps its two branches. Assert
 * the bounded round trips here; the controlled reader test below proves overlap without a clock. */
function boundedWave(events, ids, label) {
  assert(
    ids.every(id => events.some(e => e.fetch === id)),
    `${label}: every input is read`,
  );
  const calls = events.filter(e => e.call === resolveCall);
  assert(calls.length <= 3, `${label}: descriptor calls ${calls.length}`);
}
function readOnce(events, label) {
  const counts = new Map();
  for (const e of events) if (e.fetch) counts.set(e.fetch, (counts.get(e.fetch) ?? 0) + 1);
  assert.deepEqual(
    [...counts].filter(([, n]) => n > 1),
    [],
    `${label}: no object is read twice`,
  );
}

test('conflict sync reads the merge base with the tips, then resolve reads draft and page with the saved head', async t => {
  const s = await scaleFixture();
  try {
    const h = await history(s);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: ref(h.lane), right: ref(h.main) },
      message: 'sync',
      at,
    });
    const sync = await run(s, input);
    boundedWave(sync.events, [h.lane.sha256, h.main.sha256, h.root.sha256], 'sync');
    // The text merge and then its conflict markers use the same three blobs: read once.
    readOnce(sync.events, 'sync');
    assert.deepEqual(sync.output, await reference(s, input), 'byte-exact sync result');
    const result = JSON.parse(await s.bytes(sync.output)).result;
    assert.equal(result.status, 'conflict');

    const draft = parseNativeState(await s.bytes(result.state)),
      files = [];
    for (const file of draft.files)
      files.push(file.path === 'shared.txt' ? { ...file, blob: await h.blob('BOTH\nb\nc\n') } : file);
    const row = await s.ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q =>
        q.eq('projectId', s.projectId).eq('digest', result.state.sha256),
      )
      .unique();
    h.generations.set(result.state.sha256, row.stateGeneration);
    const saved = await h.state(files, [result.state.sha256]);
    const resolveInput = await s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: {
        mode: 'resolve',
        left: ref(saved),
        resolution: {
          candidateId: null,
          conflicts: result.conflicts,
          left: result.left,
          right: result.right,
          draftHead: result.state.sha256,
          status: 'pending',
        },
      },
      message: 'resolve',
      at,
    });
    const resolved = await run(s, resolveInput);
    boundedWave(resolved.events, [saved.sha256, result.state.sha256, result.conflicts.sha256], 'resolve');
    readOnce(resolved.events, 'resolve');
    assert.deepEqual(resolved.output, await reference(s, resolveInput), 'byte-exact resolve result');
    assert.equal(JSON.parse(await s.bytes(resolved.output)).result.status, 'resolved');
    t.diagnostic(
      JSON.stringify({
        sync: {
          calls: sync.events.filter(e => e.call === resolveCall).length,
          reads: sync.events.filter(e => e.fetch).length,
        },
        resolve: {
          calls: resolved.events.filter(e => e.call === resolveCall).length,
          reads: resolved.events.filter(e => e.fetch).length,
        },
      }),
    );
  } finally {
    s.restore();
  }
});

test('compose merges from the tip manifests its graph step read, with no extra descriptor call', async t => {
  const s = await scaleFixture();
  try {
    const h = await history(s, { conflict: false });
    const entries = [
      {
        laneId: randomUUID(),
        head: h.lane.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: ref(h.lane),
      },
    ];
    const inputs = buildComposePages(entries),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: h.main.sha256, receiptId: randomUUID() },
      main: ref(h.main),
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'compose',
      at,
    });
    const composed = await run(s, input);
    // The graph reads both tip manifests to learn their parents, and compute merges from those same
    // verified bytes; the base's descriptor came with the graph probe, so compute adds no call.
    readOnce(composed.events, 'compose');
    const calls = composed.events.filter(e => e.call === resolveCall).length;
    assert(calls <= 4, `compose descriptor calls: ${calls}`);
    assert.deepEqual(composed.output, await reference(s, input), 'byte-exact compose result');
    assert.equal(JSON.parse(await s.bytes(composed.output)).result.status, 'clean');
    t.diagnostic(JSON.stringify({ calls, reads: composed.events.filter(e => e.fetch).length }));
  } finally {
    s.restore();
  }
});

// Incident 3e3f9fe6: a descriptor RPC between two GET starts is valid overlap. The old integration
// assertion required zero such RPCs, so filesystem/IPC scheduling decided whether it failed.
test('prefetch starts descriptors before known bytes finish, under both completion orders', async () => {
  for (const first of ['known', 'unknown']) {
    const directory = await mkdtemp(join(tmpdir(), 'forge-merge-wave-'));
    const data = new Map(
      ['known', 'second-known', 'unknown'].map(text => {
        const bytes = Buffer.from(text);
        return [digest(bytes), bytes];
      }),
    );
    const [known, second, unknown] = [...data.keys()];
    const pin = id => ({ sha256: id, size: data.get(id).length });
    const events = [],
      gates = new Map(),
      started = new Map(),
      finished = new Map();
    for (const id of [known, unknown]) {
      const gate = Promise.withResolvers(),
        begin = Promise.withResolvers();
      finished.set(id, Promise.withResolvers());
      gates.set(id, gate);
      started.set(id, begin);
    }
    const reader = new SourceWorkerReader(directory, {
      async describeBatch(ids) {
        events.push({ call: resolveCall, args: { digests: ids } });
        return ids.map(id => ref(pin(id)));
      },
      async read(p) {
        events.push({ fetch: p.sha256 });
        started.get(p.sha256)?.resolve();
        return (async function* () {
          if (gates.has(p.sha256)) await gates.get(p.sha256).promise;
          yield data.get(p.sha256);
          finished.get(p.sha256)?.resolve();
        })();
      },
    });
    const pending = reader.prefetch([ref(pin(known)), ref(pin(second))], [unknown]);
    try {
      await started.get(known).promise;
      assert(
        events.some(e => e.call === resolveCall),
        'descriptor starts while known bytes are held',
      );
      await started.get(unknown).promise;
      assert.deepEqual(
        events.slice(0, 3).map(e => e.call ?? e.fetch),
        [known, resolveCall, unknown],
        'valid overlap interleaves an RPC between GET starts',
      );
      const firstId = first === 'known' ? known : unknown;
      gates.get(firstId).resolve();
      await finished.get(firstId).promise;
    } finally {
      for (const gate of gates.values()) gate.resolve();
      await pending;
      await rm(directory, { recursive: true, force: true });
    }
    readOnce(events, first);
    assert.equal(events.filter(e => e.call === resolveCall).length, 1, 'one batched descriptor round');
    assert.equal(reader.metrics.downloads, 3);
  }
});
