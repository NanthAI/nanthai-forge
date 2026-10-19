// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './project-exchange-fixture.mjs';
import { materializeWork } from '../dist/work-hosted-index.js';
import { workSchema } from '../dist/work-types.js';
const { ancestryEntries, stateParentEntries, deltaFits } = await import(
  moduleUrl('../convex/projectSourceReturnDelta.ts')
);
const { sourceMembership } = await import(moduleUrl('../convex/projectSourceMembership.ts'));
function insert(s, entries) {
  for (const entry of entries)
    s.tables.projectWorkRecords.set(`${entry.collection}:${entry.key}`, {
      _id: `${entry.collection}:${entry.key}`,
      projectId: 'project',
      generationId: 'generation',
      ...entry,
    });
}
test('compact immutable ancestry closures remain exact across bounded chunks', async () => {
  const s = fixture(),
    heads = Array.from({ length: 1005 }, (_, i) => i.toString(16).padStart(64, '0'));
  const parents = new Map(heads.map((head, i) => [head, i ? [heads[i - 1]] : []]));
  const entries = ancestryEntries(heads.at(-1), parents);
  assert.equal(entries.length, 3);
  assert(entries.every(e => Buffer.byteLength(JSON.stringify(e)) < 1024 * 1024));
  insert(s, entries);
  assert.equal(await sourceMembership(s.ctx, 'generation', heads.at(-1), heads[0]), true);
  assert.equal(await sourceMembership(s.ctx, 'generation', heads.at(-1), 'f'.repeat(64)), false);
  s.tables.projectWorkRecords.delete(`sourceAncestryChunk:${heads.at(-1)}:0`);
  assert.equal(
    await sourceMembership(s.ctx, 'generation', heads.at(-1), heads[0]),
    null,
    'a missing chunk never becomes a negative proof',
  );
});
test('older pair indexes lazily resolve a previously retained ancestor absent from old candidate pairs', async () => {
  const s = fixture();
  insert(s, [
    ...stateParentEntries('head', ['middle']),
    ...stateParentEntries('middle', ['root']),
    ...stateParentEntries('root', []),
    {
      collection: 'sourceAncestryHeads',
      key: 'head',
      parent: '',
      position: 0,
      value: JSON.stringify({ head: 'head' }),
    },
  ]);
  assert.equal(await sourceMembership(s.ctx, 'generation', 'head', 'middle'), true);
  assert.equal(await sourceMembership(s.ctx, 'generation', 'head', 'elsewhere'), false);
});
test('State parent caches split large fan-in without oversized documents', () => {
  const parents = Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(64, '0'));
  const rows = stateParentEntries('head', parents);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.slice(1).flatMap(r => JSON.parse(r.value).parents),
    parents,
  );
  assert(rows.every(r => Buffer.byteLength(JSON.stringify(r)) < 1024 * 1024));
});

test('complete and deferred native projections retain exact chunked parent caches', () => {
  const head = 'f'.repeat(64),
    parents = Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(64, '0')),
    root = parents[0],
    data = workSchema.parse({ schema: 11, revision: 1, nativeHead: head, intents: [], lanes: [], views: [] }),
    manifest = { kind: 'forge-native-work-backup', head, revision: 1, files: [] },
    sourceParents = new Map([
      [head, parents],
      [root, []],
    ]);
  for (const deferDerived of [false, true]) {
    const projection = materializeWork(data, manifest, [], 'objects', sourceParents, deferDerived);
    const rows = projection.entries.filter(row => row.collection.startsWith('sourceStateParent'));
    assert.equal(projection.metadata.counts.sourceStateParents, 2);
    assert.equal(projection.metadata.counts.sourceStateParentChunks, 3);
    assert.equal(rows.length, 5);
    assert.deepEqual(JSON.parse(rows.find(row => row.key === root).value), { parents: [] });
    assert.deepEqual(JSON.parse(rows.find(row => row.key === head).value), { chunks: 3 });
    const chunks = rows.filter(row => row.collection === 'sourceStateParentChunks');
    assert.deepEqual(
      chunks.map(row => row.position),
      [0, 1, 2],
    );
    assert(chunks.every(row => row.parent === head));
    assert.deepEqual(
      chunks.flatMap(row => JSON.parse(row.value).parents),
      parents,
    );
  }
});

test('new closures follow a legacy receipt boundary without replaying historical State source', async () => {
  const s = fixture();
  insert(s, [
    ...ancestryEntries('new', new Map([['new', ['old']]])),
    {
      collection: 'sourceAncestry',
      key: JSON.stringify(['old', 'accepted']),
      parent: 'old',
      position: 0,
      value: '{}',
    },
    {
      collection: 'sourceAncestryHeads',
      key: 'old',
      parent: '',
      position: 0,
      value: JSON.stringify({ head: 'old' }),
    },
  ]);
  assert.equal(await sourceMembership(s.ctx, 'generation', 'new', 'accepted'), true);
  assert.equal(await sourceMembership(s.ctx, 'generation', 'new', 'newer'), false);
});

test('summary-only refresh preserves provenance in chunked View detail payloads', async () => {
  const { viewIndexEntries } = await import('../dist/view-hosted-index.js');
  const data = {
    lanes: [],
    intents: [],
    channelMoves: [],
    views: [
      {
        id: 'view',
        intentId: 'intent',
        base: 'base',
        head: 'head',
        status: 'clean',
        at: 'now',
        inputs: Array.from({ length: 1000 }, (_, i) => ({ laneId: `lane-${i}`, head: 'a'.repeat(64) })),
      },
    ],
  };
  const rows = viewIndexEntries(data, undefined, {
    index: 0,
    positions: new Map(),
    cachedProvenance: { fileCount: 7, provenanceAvailable: true },
  });
  const header = JSON.parse(rows.find(r => r.collection === 'viewDetails').value);
  assert(header.payloadParts > 0);
  const payload = JSON.parse(
    rows
      .filter(r => r.collection === 'viewDetails:payload')
      .map(r => r.value)
      .join(''),
  );
  assert.equal(payload.fileCount, 7);
  assert.equal(payload.provenanceAvailable, true);
});

test('publication budget accounts for old rows and protocol bytes even when the new delta is small', () => {
  const delta = {
    entries: ancestryEntries('head', new Map([['head', []]])),
    removed: [],
    views: [],
    summaries: [],
    positions: {},
    stopParents: [],
    readBytes: 0,
    payloadReplacements: 0,
  };
  assert.equal(deltaFits(delta, 1024), true);
  assert.equal(deltaFits({ ...delta, readBytes: 16 * 1024 * 1024 }, 1024), false);
  assert.equal(deltaFits(delta, 16 * 1024 * 1024), false);
});
