// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { computeOwnerDerived } from '../dist/owner-derived.js';
import { viewIndexEntries } from '../dist/view-hosted-index.js';
import { stateParentEntries } from '../dist/source-state-parent-index.js';
import { sourceTreeEntries } from '../dist/source-tree-index.js';
import { moduleUrl } from './convex-module.mjs';
import { ancestryEntries } from './ancestry-fixture.mjs';
const { ownerDerivedRows, readOwnerDerived } = await import(moduleUrl('../convex/projectOwnerDerived.ts'));
const { installOwnerDerived } = await import(moduleUrl('../convex/projectOwnerDerived.ts'));
function fixture() {
  const objects = new Map(),
    states = new Map();
  const object = text => {
    const bytes = Buffer.from(text),
      hash = digest(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const base = object('base state'),
    left = object('left state'),
    right = object('right state'),
    head = object('merged state');
  const a = object('one\n'),
    b = object('two\n'),
    binary = object('\0binary');
  const files = [{ path: 'a.ts', blob: a, mode: 'file' }],
    changed = [
      { path: 'a.ts', blob: b, mode: 'executable' },
      { path: 'binary', blob: binary, mode: 'file' },
    ];
  states.set(base, { parents: [], files });
  states.set(left, { parents: [base], files: changed });
  states.set(right, { parents: [base], files });
  states.set(head, { parents: [left, right], files: changed });
  const data = {
    revision: 1,
    nativeHead: head,
    intents: [{ id: 'intent', outcome: 'Synthetic', base }],
    lanes: [
      {
        id: 'lane',
        intentId: 'intent',
        base,
        head,
        checkpoints: [
          { head, parent: base, message: 'Save', at: 'a', actor: { kind: 'agent', name: 'Fixture' } },
        ],
      },
    ],
    views: [
      {
        id: 'view',
        intentId: 'intent',
        base,
        head,
        inputs: [{ laneId: 'lane', head }],
        status: 'clean',
        at: 'a',
      },
    ],
    channelMoves: [
      {
        id: 'move',
        channel: 'main',
        viewId: 'view',
        head,
        previous: base,
        at: 'a',
        status: 'accepted',
        acceptedBy: 'owner',
      },
    ],
    runs: [],
  };
  const source = { state: h => states.get(h), object: h => objects.get(h) };
  const derived = computeOwnerDerived(data, source);
  const cursor = {
    snapshot: {
      data,
      manifest: {
        head,
        files: [
          { path: 'work.json', sha256: derived.work, size: Buffer.byteLength(JSON.stringify(data, null, 2)) },
          ...[...objects].map(([sha256, bytes]) => ({
            path: `objects/${sha256}`,
            sha256,
            size: bytes.length,
          })),
        ],
      },
    },
    final: { command: JSON.stringify({ workSha256: digest(JSON.stringify(data, null, 2)) }) },
    delta: { stopParents: [], views: [0] },
    pending: [head],
    parents: [],
    heads: [head],
    diffstats: {
      records: [
        {
          collection: 'lanes',
          key: 'lane',
          parent: 'intent',
          position: 0,
          value: JSON.stringify({ base, head }),
        },
      ],
    },
  };
  return { source, states, objects, data, derived, cursor, base, head };
}
test('unchanged View source pairs reuse file keys while still validating and replacing owner rows', async () => {
  const ordinary = fixture(),
    stable = fixture();
  for (const f of [ordinary, stable]) {
    f.cursor.delta.newViews = [];
    f.cursor.metadata = { counts: {} };
    f.cursor.rows = [];
  }
  stable.cursor.delta.unchangedViewFiles = ['view'];
  const calls = [];
  await installOwnerDerived(
    { runQuery: async () => ({ keys: [], view: 1, after: -1, bytes: 0 }) },
    ordinary.cursor,
    ordinary.derived,
  );
  await installOwnerDerived(
    {
      runQuery: async (...args) => {
        calls.push(args);
        throw Error('Unneeded key read');
      },
    },
    stable.cursor,
    stable.derived,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(stable.cursor.rows, ordinary.cursor.rows);
});
test('owner rows match hosted parent, merge ancestry, View provenance and tree computation', async () => {
  const f = fixture(),
    rows = ownerDerivedRows(f.cursor, f.derived).rows;
  assert.ok(rows);
  for (const [head, state] of f.states)
    for (const expected of stateParentEntries(head, state.parents))
      assert.deepEqual(
        rows.find(r => r.collection === expected.collection && r.key === expected.key),
        expected,
      );
  const { sourceMembership } = await import(moduleUrl('../convex/projectSourceMembership.ts'));
  const { state } = await import('./hosted-fixture.mjs');
  const hosted = state([]);
  for (const row of rows)
    await hosted.ctx.db.insert('projectWorkRecords', {
      ...row,
      projectId: 'project',
      generationId: 'generation',
    });
  const expectedAncestors = new Set(
    ancestryEntries(f.head, new Map([...f.states].map(([h, s]) => [h, s.parents])))
      .filter(r => r.collection === 'sourceAncestryChunk')
      .flatMap(r => JSON.parse(r.value).ancestors),
  );
  for (const ancestor of [...f.states.keys(), digest('unrelated')])
    assert.equal(
      await sourceMembership(hosted.ctx, 'generation', f.head, ancestor),
      expectedAncestors.has(ancestor),
    );
  const files = new Map([...f.states].map(([h, s]) => [h, s.files]));
  for (const expected of [
    ...viewIndexEntries(f.data, files, { index: 0, positions: new Map() }),
    ...sourceTreeEntries(f.head, files.get(f.head)),
  ])
    assert.deepEqual(
      rows.find(r => r.collection === expected.collection && r.key === expected.key),
      expected,
    );
});
test('owner diffstats match hosted binary, added and mode-change semantics', async () => {
  const f = fixture();
  const { fixture: hosted, upload, modules } = await import('./project-exchange-fixture.mjs');
  const s = hosted();
  for (const bytes of f.objects.values()) await upload(s, bytes);
  const before = f.states.get(f.base).files,
    after = f.states.get(f.head).files;
  const pin = hash => ({ sha256: hash, size: f.objects.get(hash).length });
  const result = await modules.projectDiffstats.compare._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    files: [{ before: pin(before[0].blob), after: pin(after[0].blob) }, { after: pin(after[1].blob) }],
  });
  const stats = new Map(f.derived.stats).get(`${f.base}:${f.head}`);
  assert.deepEqual(stats, { files: 2, ...(result.exact ? { add: result.add, del: result.del } : {}) });
});
test('immutable cache reuses source facts and View rows without object reads', () => {
  const f = fixture();
  let states = 0;
  const next = computeOwnerDerived(
    f.data,
    {
      state: h => {
        states++;
        return f.source.state(h);
      },
      object: () => {
        throw Error('unchanged blobs must be reused');
      },
    },
    f.derived,
  );
  assert.deepEqual(next, f.derived);
  assert.equal(states, 0, 'unchanged source trees are reused');
});
for (const missing of ['parents', 'stats', 'views', 'trees'])
  test(`missing ${missing} cache items are computed locally before upload`, () => {
    const f = fixture(),
      cache = structuredClone(f.derived);
    cache[missing] = [];
    let reads = 0;
    const result = computeOwnerDerived(
      f.data,
      {
        state: head => {
          reads++;
          return f.source.state(head);
        },
        object: hash => {
          reads++;
          return f.source.object(hash);
        },
      },
      cache,
    );
    assert.deepEqual(result, f.derived);
    assert.ok(reads > 0);
  });

for (const [name, mutate] of [
  [
    'wrong Work pin',
    d => {
      d.work = '0'.repeat(64);
    },
  ],
  ['duplicate State', d => d.parents.push(d.parents[0])],
  ['unknown parent pin', d => d.parents[0][1].push('0'.repeat(64))],
  [
    'wrong pair key',
    d => {
      d.stats[0][0] = 'wrong';
    },
  ],
  [
    'negative counts',
    d => {
      d.stats[0][1].files = -1;
    },
  ],
  [
    'missing View',
    d => {
      d.views = [];
    },
  ],
  [
    'wrong View key',
    d => {
      d.views[0][2][0].key = 'other';
    },
  ],
  [
    'inconsistent file count',
    d => {
      const row = d.views[0][2].find(r => r.collection === 'viewDetails');
      row.value = JSON.stringify({ ...JSON.parse(row.value), fileCount: 99 });
    },
  ],
  [
    'unrelated collection',
    d => {
      d.views[0][2][0].collection = 'intents';
    },
  ],
])
  test(`invalid owner rows are rejected: ${name}`, () => {
    const f = fixture();
    mutate(f.derived);
    const expected = {
      'wrong Work pin': 'work-pin-mismatch',
      'duplicate State': 'duplicate-key',
      'unknown parent pin': 'parent-pin-missing',
      'wrong pair key': 'stats-pin-missing',
      'negative counts': 'schema-invalid',
      'missing View': 'view-missing:view',
      'wrong View key': 'view-detail-key-invalid',
      'inconsistent file count': 'view-summary-invalid',
      'unrelated collection': 'view-collection-invalid',
    }[name];
    assert.equal(ownerDerivedRows(f.cursor, f.derived).reason, expected);
  });

test('chunked provenance payloads retain parity and reject corrupt chunks', () => {
  const f = fixture();
  f.data.lanes[0].checkpoints[0].message = 'large synthetic save '.repeat(4000);
  const derived = computeOwnerDerived(f.data, f.source);
  assert.ok(derived.views[0][2].some(r => r.collection === 'viewFiles:payload'));
  f.cursor.final.command = JSON.stringify({ workSha256: derived.work });
  f.cursor.snapshot.manifest.files.find(file => file.path === 'work.json').sha256 = derived.work;
  assert.ok(ownerDerivedRows(f.cursor, derived).rows);
  derived.views[0][2].find(r => r.collection === 'viewFiles:payload').value += 'changed';
  assert.match(ownerDerivedRows(f.cursor, derived).reason, /^payload-invalid:/);
});

test('owner-derived source return retains owner-only authority before reading sidecar bytes', async () => {
  const { fixture, modules } = await import('./project-exchange-fixture.mjs');
  const s = fixture();
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  let reads = 0;
  s.ctx.storage.get = async () => {
    reads++;
    throw Error('must authorize first');
  };
  for (const actor of ['stranger', 'contributor']) {
    s.caller(actor);
    await assert.rejects(
      modules.projectSourceReturn.returnSource._handler(s.ctx, {
        projectId: 'project',
        backupId: 'candidate',
        expectedBackupId: 'previous',
        revision: 1,
        operationId: randomUUID(),
        ownerDerived: { sha256: '0'.repeat(64), size: 1 },
      }),
      error => error.data?.code === 'PROJECT_UNAVAILABLE',
    );
  }
  assert.equal(reads, 0);
});

test('exact owner totals include deletion and a mode-only file without extra lines', async () => {
  const f = fixture();
  const before = f.states.get(f.base).files[0];
  f.states.get(f.base).files = [before, { ...before, path: 'deleted.ts' }, { ...before, path: 'mode.ts' }];
  f.states.get(f.head).files = [
    f.states.get(f.head).files[0],
    { ...before, path: 'mode.ts', mode: 'executable' },
  ];
  const result = computeOwnerDerived(f.data, f.source);
  assert.deepEqual(new Map(result.stats).get(`${f.base}:${f.head}`), { files: 3, add: 1, del: 2 });
});

test('server rejects invalid roots before reads and validates bytes and protocol', async () => {
  const { OWNER_DERIVED_MAX_BYTES } = await import('../dist/owner-derived.js');
  let reads = 0;
  const read = async () => {
    reads++;
    throw Error('must not read');
  };
  for (const size of [OWNER_DERIVED_MAX_BYTES + 1, -1, 0, Infinity, 1.5])
    await assert.rejects(
      readOwnerDerived({ sha256: '0'.repeat(64), size }, read),
      e => e.code === 'INVALID_OWNER_DATA',
    );
  assert.equal(reads, 0);
  await assert.rejects(
    readOwnerDerived(undefined, read),
    e => e.code === 'CLI_UPGRADE_REQUIRED' && /nforge/.test(e.message),
  );
  for (const [text, code] of [
    ['{broken', 'INVALID_OWNER_DATA'],
    ['{"schema":2}', 'CLI_UPGRADE_REQUIRED'],
  ]) {
    const bytes = Buffer.from(text);
    await assert.rejects(
      readOwnerDerived({ sha256: digest(bytes), size: bytes.length }, async () => bytes),
      e => e.code === code,
    );
  }
  const bytes = Buffer.from('{}');
  await assert.rejects(
    readOwnerDerived({ sha256: digest(bytes), size: 1 }, async () => bytes),
    e => e.code === 'INVALID_OWNER_DATA',
  );
  await assert.rejects(
    readOwnerDerived({ sha256: '0'.repeat(64), size: 2 }, async () => bytes),
    e => e.code === 'INVALID_OWNER_DATA',
  );
});

test('source and View rows scale with new landings; compact stats cover every retained pair', () => {
  const sizes = new Map();
  for (const history of [10, 1000])
    for (const delta of [1, 20]) {
      const f = fixture();
      const append = count => {
        for (let n = 0; n < count; n++) {
          const base = f.data.nativeHead,
            id = `landing-${f.data.views.length}`;
          const head = digest(id);
          f.states.set(head, { parents: [base], files: f.states.get(base).files });
          f.data.intents.push({ id, outcome: 'Synthetic landing', base });
          f.data.lanes.push({
            id,
            intentId: id,
            base,
            head,
            checkpoints: [{ head, parent: base, message: 'Save', at: 'a' }],
          });
          f.data.views.push({
            id,
            intentId: id,
            base,
            head,
            inputs: [{ laneId: id, head }],
            status: 'clean',
            at: 'a',
          });
          f.data.channelMoves.push({
            id,
            viewId: id,
            channel: 'main',
            head,
            previous: base,
            at: 'a',
            status: 'accepted',
            acceptedBy: 'owner',
          });
          f.data.nativeHead = head;
        }
      };
      append(history);
      const baseline = { data: structuredClone(f.data), states: new Set(f.states.keys()) };
      append(delta);
      const derived = computeOwnerDerived(f.data, f.source, undefined, baseline);
      for (const collection of ['parents', 'ancestry', 'views'])
        assert.equal(derived[collection].length, delta, collection);
      assert.equal(derived.stats.length, history + delta + 1);
      assert.equal(derived.trees.length, 1);
      for (const [head, parents] of derived.ancestry) {
        assert.deepEqual(parents, f.states.get(head).parents);
        assert.ok(parents.length <= 1, 'own parents only, no expanded closure');
        assert.ok(!baseline.states.has(head));
      }
      const bytes = Buffer.byteLength(JSON.stringify(derived));
      sizes.set(`${history}/${delta}`, bytes);
      console.log('SIDECAR_BYTES', JSON.stringify({ history, delta, bytes }));
    }
  for (const delta of [1, 20])
    assert.ok(
      Math.abs(sizes.get(`1000/${delta}`) - sizes.get(`10/${delta}`)) < 256000,
      'Retained pair metadata stays below 256 bytes per comparison',
    );
});

test('selecting a previously hosted State as a new current tree still supplies that tree', () => {
  const f = fixture();
  const baseline = { data: structuredClone(f.data), states: new Set(f.states.keys()) };
  f.data.nativeHead = f.base;
  const derived = computeOwnerDerived(f.data, f.source, undefined, baseline);
  assert.deepEqual(derived.parents, []);
  assert.deepEqual(derived.ancestry, []);
  assert.deepEqual(
    derived.trees.map(([head]) => head),
    [f.base],
  );
});

test('supersession supplies the changed old summary comparison while retaining its provenance', () => {
  const f = fixture();
  const baseline = { data: structuredClone(f.data), states: new Set(f.states.keys()) };
  const next = digest('next save');
  f.states.set(next, { parents: [f.head], files: f.states.get(f.head).files });
  f.data.lanes[0].head = next;
  f.data.lanes[0].checkpoints.push({ head: next, parent: f.head, message: 'Next', at: 'b' });
  f.data.views.push({
    ...f.data.views[0],
    id: 'next-view',
    head: next,
    inputs: [{ laneId: 'lane', head: next }],
    at: 'b',
  });
  const derived = computeOwnerDerived(f.data, f.source, undefined, baseline);
  assert.deepEqual(
    derived.views.map(([id]) => id),
    ['view', 'next-view'],
  );
  assert.ok(derived.stats.some(([key]) => key === `${f.base}:${f.head}`));
  assert.ok(derived.stats.some(([key]) => key === `${f.base}:${next}`));
});

test('index companions bind bounded count pages and lazy View pages to the existing Work digest', async () => {
  const { ownerDiffstatPages, diffstatPageSchema, ownerViewPageSchema } =
    await import('../dist/owner-diffstats.js');
  const f = fixture();
  const stats = Array.from({ length: 2167 }, (_, i) => [
    `${digest(`base-${i}`)}:${digest(`head-${i}`)}`,
    { files: 40, ...(i % 2 ? { add: 41, del: 40 } : {}) },
  ]);
  const output = ownerDiffstatPages({ ...f.derived, stats });
  assert.equal(output.pages.length, 22);
  assert(output.pages.every(page => page.size <= 64 * 1024));
  assert.equal(output.objects.size, 22, 'View bytes are produced on demand instead of retained twice');
  assert.equal(output.views.length, f.derived.views.length);
  for (const page of output.pages) {
    const bytes = output.read(page.sha256);
    assert.equal(digest(bytes), page.sha256);
    const value = diffstatPageSchema.parse(JSON.parse(bytes));
    assert.equal(value.work, f.derived.work);
    assert.equal(value.stats[0][0], page.first);
    assert.equal(value.stats.at(-1)[0], page.last);
  }
  for (const pin of output.views) {
    const bytes = output.read(pin.sha256);
    assert.equal(bytes.length, pin.size);
    assert.equal(digest(bytes), pin.sha256);
    assert.equal(ownerViewPageSchema.parse(JSON.parse(bytes)).work, f.derived.work);
  }
  assert.throws(() =>
    diffstatPageSchema.parse({ work: f.derived.work, stats: [[stats[0][0], { files: 1, add: 1 }]] }),
  );
});

test('600 retained Lane/View pairs supply stats even when unchanged and uncached by the hosted index', () => {
  const f = fixture();
  f.data.lanes = Array.from({ length: 600 }, (_, i) => ({ ...f.data.lanes[0], id: `lane-${i}` }));
  f.data.views = Array.from({ length: 600 }, (_, i) => ({
    ...f.data.views[0],
    id: `view-${i}`,
    inputs: [{ laneId: `lane-${i}`, head: f.head }],
  }));
  let stateReads = 0,
    objectReads = 0;
  const cache = { ...f.derived, views: [] };
  // Prior fingerprints omit all Views; no full-history source work is needed.
  const source = {
    state: head => {
      stateReads++;
      return f.source.state(head);
    },
    object: hash => {
      objectReads++;
      return f.source.object(hash);
    },
  };
  const derived = computeOwnerDerived(f.data, source, cache, {
    states: new Set(f.states.keys()),
    data: f.data,
  });
  assert.equal(
    derived.stats.length,
    1,
    'Same immutable pair is compared once, including unchanged summaries',
  );
  assert.equal(stateReads, 0);
  assert.equal(objectReads, 0);
  const cursor = {
    ...f.cursor,
    snapshot: { ...f.cursor.snapshot, data: f.data },
    delta: { ...f.cursor.delta, views: [], stopParents: [...f.states.keys()] },
    pending: [],
    heads: [],
  };
  cursor.snapshot.manifest.files.find(file => file.path === 'work.json').sha256 = derived.work;
  const old = { ...derived, stats: [] };
  assert.equal(ownerDerivedRows(cursor, old).reason, `stats-missing-or-unpaired:${f.base}:${f.head}`);
  assert.ok(ownerDerivedRows(cursor, derived).rows);
});

test('pending and ancestry failures identify their exact condition', () => {
  const f = fixture();
  f.derived.parents = f.derived.parents.filter(([head]) => head !== f.head);
  assert.equal(ownerDerivedRows(f.cursor, f.derived).reason, `pending-parent-missing:${f.head}`);
  const g = fixture();
  g.derived.ancestry = structuredClone(g.derived.ancestry);
  g.derived.ancestry.find(([, parents]) => parents.length)[1] = [];
  assert.match(ownerDerivedRows(g.cursor, g.derived).reason, /^ancestry-parents-differ:/);
});
