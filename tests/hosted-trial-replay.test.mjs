// SPDX-License-Identifier: Apache-2.0
// 83e6d0d3: synthetic bytes preserve the incident's packed-main and saved-resolution topology.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';
import { trialMerge, TrialUnavailable } from '../dist/hosted-trial-merge.js';
import { encodePhysicalEntries, physicalBucket } from '../dist/physical-manifest-codec.js';
import { moduleUrl } from './convex-module.mjs';
const merge = await import(moduleUrl('../convex/projectHostedConflictMerge.ts'));
const path = 'src/service.test.ts';
const base = Buffer.from('one\ntwo\nthree\nfour\nfive\n');
const own = Buffer.from('one\nMINE\nthree\nfour\nfive\n');
const other = Buffer.from('one\nTHEIRS\nthree\nfour\nfive\n');
const file = bytes => ({ blob: digest(bytes), mode: 'file' });

function compositionConflict(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-trial-compose-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root),
    at = '2026-01-01T00:00:00.000Z';
  const state = (bytes, parents) =>
    source.writeState([{ path, blob: source.put(bytes), mode: 'file' }], parents, 'synthetic', at);
  const original = state(base, []),
    left = state(other, [original]),
    right = state(own, [original]);
  return source.compose(left, right, 'real composition replay', at).conflicts;
}

function storage(t) {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'];
  const before = names.map(key => [key, process.env[key]]);
  Object.assign(
    process.env,
    Object.fromEntries(
      names.map(key => [key, key === 'R2_ENDPOINT' ? 'https://synthetic.invalid' : 'synthetic']),
    ),
  );
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const bodies = new Map();
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes);
    bodies.set(id, bytes);
    return {
      digest: id,
      size: bytes.length,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/project/o/${id}`,
    };
  };
  const packed = bytes => {
    const pack = put(Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]));
    return {
      sha256: digest(bytes),
      size: bytes.length,
      pack: { digest: pack.digest, size: pack.size, offset: 6 },
    };
  };
  const state = (bytes, physical) => {
    const object = put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [{ path, ...file(bytes) }],
        message: 'synthetic',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    if (physical) {
      const chunk = put(encodePhysicalEntries([physical]));
      const root = put(
        JSON.stringify({
          schema: 1,
          kind: 'forge-physical-manifest',
          state: object.digest,
          chunks: [{ sha256: chunk.digest, size: chunk.size, bucket: physicalBucket(physical.sha256) }],
        }),
      );
      object.statePhysical = { sha256: root.digest, size: root.size };
    }
    return object;
  };
  t.mock.method(globalThis, 'fetch', async (url, input) => {
    const id = new URL(url).pathname.split('/o/')[1];
    const bytes = bodies.get(id);
    if (!bytes) return new Response(null, { status: 404 });
    const range = new Headers(input?.headers).get('range');
    if (!range) return new Response(bytes);
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range);
    return new Response(bytes.subarray(+from, +to + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${bytes.length}` },
    });
  });
  const run = async plan => {
    let recorded;
    await merge.run._handler(
      {
        runMutation: async (ref, args) => {
          assert.equal(getFunctionName(ref), 'projectHostedConflicts:record');
          recorded = args;
          return null;
        },
        runQuery: async () => assert.fail('the planned State supplies merge rules without another call'),
      },
      { projectId: 'project', plan: JSON.stringify(plan) },
    );
    return recorded;
  };
  return { put, state, packed, run };
}

test('83e6d0d3 first conflict: packed main bytes reach the existing conflict record, with no catalog call', async t => {
  assert.deepEqual(compositionConflict(t), [path]);
  const s = storage(t);
  const main = s.state(other, s.packed(other));
  const result = await s.run({
    laneId: 'mine',
    head: 'saved',
    peers: [],
    tasks: [{ path, mine: { before: file(base), after: file(own) }, peers: [] }],
    objects: [s.put(base), s.put(own)],
    main: { head: main.digest, state: main, paths: [path] },
  });
  assert.deepEqual(
    result.conflicts.map(c => [c.peer, c.path, c.mine, c.theirs]),
    [['main', path, [[2, 2]], [[2, 2]]]],
  );
});

test('legacy raw main bytes remain readable when a State has no physical metadata', async t => {
  const s = storage(t),
    main = s.state(other);
  s.put(other);
  const result = await s.run({
    laneId: 'mine',
    head: 'saved',
    peers: [],
    tasks: [{ path, mine: { before: file(base), after: file(own) }, peers: [] }],
    objects: [s.put(base), s.put(own)],
    main: { head: main.digest, state: main, paths: [path] },
  });
  assert.equal(result.conflicts[0].peer, 'main');
});

test('83e6d0d3 second conflict: a resolution delta based on marker bytes uses its real source base', async t => {
  assert.deepEqual(compositionConflict(t), [path]);
  const s = storage(t);
  const draft = Buffer.from('one\n<<<<<<< lane\nMINE\n=======\nold\n>>>>>>> target\nthree\nfour\nfive\n');
  const task = {
    path,
    mine: { before: file(draft), after: file(own) },
    peers: [{ laneId: 'peer', before: file(base), after: file(other) }],
  };
  const objects = [base, draft, own, other].map(s.put);
  const read = id => {
    const index = objects.findIndex(object => object.digest === id);
    if (index < 0) throw new TrialUnavailable(id);
    return [base, draft, own, other][index];
  };
  assert.deepEqual(
    (await trialMerge([structuredClone(task)], read)).conflicts,
    [],
    'the recorded draft projection reproduces the silent peer miss',
  );
  const actualBase = s.state(base),
    actualHead = s.state(own);
  const result = await s.run({
    laneId: 'mine',
    head: actualHead.digest,
    peers: [{ laneId: 'peer', head: 'peer-head' }],
    tasks: [task],
    objects,
    sources: [{ laneId: 'mine', base: actualBase, head: actualHead }],
  });
  assert.deepEqual(
    result.conflicts.map(c => [c.peer, c.path]),
    [['peer', path]],
  );
});

test('missing or corrupt selected source never publishes a guessed conflict and still records the trial outcome', async t => {
  const s = storage(t);
  const main = s.state(other, s.packed(other));
  main.digest = '0'.repeat(64);
  const result = await s.run({
    laneId: 'mine',
    head: 'saved',
    peers: [],
    tasks: [{ path, mine: { before: file(base), after: file(own) }, peers: [] }],
    objects: [s.put(base), s.put(own)],
    main: { head: main.digest, state: main, paths: [path] },
  });
  assert.deepEqual(result.conflicts, []);
});
