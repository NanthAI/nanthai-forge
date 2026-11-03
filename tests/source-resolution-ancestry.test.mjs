// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { prepareMergeStep, computeMergeStep } from '../dist/hosted-source-step-merge.js';
import { meter } from '../dist/hosted-source-step-verify.js';
import { sourceAncestryCut } from '../dist/hosted-source-ancestry-cut.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';

const at = '2026-01-01T00:00:00.000Z';
function fixture() {
  const objects = new Map(),
    parents = {},
    reads = [],
    describes = [];
  const put = raw => {
    const bytes = Buffer.from(raw),
      pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const file = (path, text) => ({ path, mode: 'file', blob: put(text).sha256 });
  const state = (files, edges = [], message = '') => {
    const pin = json({ schema: 1, kind: 'forge-source-state', files, parents: edges, message, at });
    parents[pin.sha256] = edges;
    return pin.sha256;
  };
  const io = {
    async describeBatch(ids) {
      assert(ids.length <= 100);
      describes.push(ids);
      return ids.map(id => {
        assert(objects.has(id), `unknown State ${id} must be read, never dropped`);
        return { object: { sha256: id, size: objects.get(id).length }, recipe: null };
      });
    },
    async read(pin) {
      reads.push(pin.sha256);
      return (async function* () {
        yield objects.get(pin.sha256);
      })();
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      assert.deepEqual(put(Buffer.concat(parts)), pin);
    },
  };
  const input = (left, right) => {
    const conflicts = json({
      schema: 1,
      kind: 'forge-hosted-compose-conflicts',
      left,
      right,
      paths: [{ path: 'f', base: null, left: null, right: null }],
      next: null,
    });
    const plan = {
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'resolution', candidateId: '00000000-0000-4000-8000-000000000001', conflicts },
      message: 'draft',
      at,
    };
    return { ...initialSourceStep(json(plan)), plan, phase: 'selection' };
  };
  return { objects, parents, reads, describes, put, json, file, state, io, input };
}

async function drain(s, initial, { legacy = false, resumeOld = false, retry = false } = {}) {
  let c = structuredClone(initial),
    steps = 0;
  const start = s.reads.length;
  while (c.phase !== 'compute') {
    assert(++steps < 1000);
    // Retain the old resolution-specific expanding-root policy as the oracle.
    // All manifest authentication, frontier scheduling and merge code are shared.
    if (legacy && c.phase === 'graph') c.resolutionRoots = Object.keys(c.parents);
    if (resumeOld && c.phase === 'graph') {
      delete c.resolutionRoots;
      resumeOld = false;
    }
    const before = structuredClone(c);
    await prepareMergeStep(c, s.io, meter());
    if (retry) {
      await prepareMergeStep(before, s.io, meter());
      assert.deepEqual(before, c, 'original quantum retry preserves exact selected tips and progress');
    }
    // The legacy oracle widens roots only to model its old traversal policy.
    // That version persisted no selected-tip field; never encode this test-only
    // override as the current cursor's authenticated two-tip tuple.
    if (legacy) delete c.resolutionRoots;
    const stored = new Map();
    const saved = await saveSourceProgress(c, null, async bytes => {
      const id = digest(bytes);
      stored.set(id, bytes);
      return id;
    });
    c = (await loadSourceProgress(stored.get(saved.id), async id => stored.get(id))).cursor;
  }
  const graphReads = s.reads.slice(start);
  await computeMergeStep(c, s.io);
  return { cursor: c, graphReads, output: s.objects.get(c.output.sha256), draft: s.objects.get(c.head) };
}

test('persisted asymmetric resolution reads only the near-tip frontier across retained history and root orders', async t => {
  const reports = [];
  for (const depth of [0, 10, 400, 800])
    for (const reverseRoots of [false, true])
      for (const reverseParents of [false, true]) {
        const s = fixture(),
          historical = new Set();
        let old;
        for (let i = 0; i < depth; i++) {
          old = s.state([], old ? [old] : [], `old-${i}`);
          historical.add(old);
        }
        const root = s.state([s.file('f', 'base\n')], old ? [old] : [], 'C'),
          a = s.state([s.file('f', 'A\n')], [root], 'A'),
          b = s.state([s.file('f', 'B\n')], [root], 'B'),
          main = s.state([s.file('f', 'main\n')], reverseParents ? [b, a] : [a, b], 'M'),
          descendant = s.state([s.file('f', 'descendant\n')], [a], 'D'),
          roots = reverseRoots ? [descendant, main] : [main, descendant],
          initial = s.input(...roots),
          full = { ...structuredClone(initial), phase: 'compute', parents: structuredClone(s.parents) };
        await computeMergeStep(full, s.io);
        const selected = await drain(s, initial);
        assert.equal(selected.cursor.ancestryBoundary, root);
        assert.deepEqual(selected.cursor.output, full.output);
        assert.deepEqual(selected.output, s.objects.get(full.output.sha256));
        assert.deepEqual(selected.draft, s.objects.get(full.head));
        assert(!selected.graphReads.some(id => historical.has(id) || id === root));
        assert.equal(selected.graphReads.length, 5, 'conflict page plus four near-tip manifests');
        reports.push({ depth, reverseRoots, reverseParents, graphReads: selected.graphReads.length });
      }
  t.diagnostic(JSON.stringify({ reports, historicalReads: 0 }));
});

test('persisted Q/A-chain resolution keeps every edge without history-sized work', async t => {
  const reports = [];
  for (const depth of [0, 10, 400, 800])
    for (const reverse of [false, true])
      for (const preloaded of [false, true]) {
        const s = fixture(),
          historical = new Set();
        let old;
        for (let i = 0; i < depth; i++) {
          old = s.state([], old ? [old] : [], `old-${i}`);
          historical.add(old);
        }
        const c = s.state([s.file('f', 'base\n')], old ? [old] : [], 'C'),
          a = s.state([s.file('f', 'A\n')], [c], 'A'),
          q = s.state([s.file('f', 'Q\n')], [a], 'Q'),
          b = s.state([s.file('f', 'B\n')], [c], 'B'),
          m = s.state([s.file('f', 'main\n')], reverse ? [b, q] : [q, b], 'M'),
          d = s.state([s.file('f', 'lane\n')], [q], 'D'),
          initial = s.input(...(reverse ? [d, m] : [m, d])),
          full = { ...structuredClone(initial), phase: 'compute', parents: structuredClone(s.parents) };
        if (preloaded) {
          initial.parents[q] = [a];
          initial.phase = 'graph';
          initial.states = [m, d, a];
        }
        await computeMergeStep(full, s.io);
        const selected = await drain(s, initial);
        assert.deepEqual(selected.output, s.objects.get(full.output.sha256));
        assert.deepEqual(selected.draft, s.objects.get(full.head));
        assert.equal(selected.cursor.ancestryBoundary, c);
        assert(!selected.graphReads.some(id => historical.has(id)));
        assert.equal(selected.graphReads.length, preloaded ? 6 : 7);
        reports.push({ depth, reverse, preloaded, graphReads: selected.graphReads.length });
      }
  t.diagnostic(JSON.stringify({ reports, historicalReads: 0 }));
});

for (const kind of ['prefetched-base', 'closed-root', 'partial-coverage', 'recursive-base', 'criss-cross']) {
  test(`resolution ${kind} retains byte-identical legacy proof and draft`, async () => {
    const s = fixture(),
      oldA = s.state([], [], 'old A'),
      oldB = s.state([], [], 'old B'),
      original = s.file('f', 'a\nb\nc\nd\ne\nf\ng\n'),
      root = s.state([original], kind === 'closed-root' ? [] : [oldA, oldB]),
      a = s.state([s.file('f', 'A\nb\nc\nd\ne\nf\ng\n')], [root]),
      b = s.state([s.file('f', 'a\nb\nc\nd\ne\nf\nG\n')], [root]);
    let left, right;
    if (kind === 'recursive-base' || kind === 'criss-cross') {
      // Both maximal bases must remain available for recursive combination,
      // including conflicting base alternatives in the criss-cross case.
      const cross = kind === 'criss-cross' ? s.state([s.file('f', 'other\n')], [root]) : b;
      left = s.state([s.file('f', 'A\nb\nC\nd\ne\nf\nG\n')], [a, cross]);
      right = s.state([s.file('f', 'A\nb\nD\nd\ne\nf\nG\n')], [cross, a]);
    } else {
      let branch = a;
      for (let i = 0; i < 11; i++) branch = s.state([original], [branch], `branch ${i}`);
      left = s.state([s.file('f', 'left\n')], [branch, b]);
      right = s.state([s.file('f', 'right\n')], [root]);
    }
    const initial = s.input(left, right),
      before = await drain(s, initial, { legacy: true }),
      after = await drain(s, initial, { retry: true, resumeOld: kind === 'partial-coverage' });
    assert.deepEqual(after.output, before.output);
    assert.deepEqual(after.draft, before.draft);
    assert.deepEqual(after.cursor.resolutionRoots, [left, right]);
    assert.equal(
      after.cursor.ancestryBoundary,
      root,
      'the final closed window still records its authenticated cut',
    );
  });
}

test('old graph cursors recover selected tips once from the authenticated pinned page', async () => {
  const s = fixture(),
    root = s.state([], [], 'root'),
    left = s.state([s.file('f', 'left')], [root]),
    right = s.state([s.file('f', 'right')], [root]),
    c = s.input(left, right);
  c.phase = 'graph';
  c.states = [left, right];
  await prepareMergeStep(c, s.io, meter());
  assert.deepEqual(c.resolutionRoots, [left, right]);
  await prepareMergeStep(c, s.io, meter());
  assert.equal(s.reads.filter(id => id === c.plan.work.conflicts.sha256).length, 1);
});

test('a substituted conflict page or parent manifest cannot establish a cut', async () => {
  for (const corruptPage of [false, true]) {
    const s = fixture(),
      root = s.state([], [], 'root'),
      left = s.state([s.file('f', 'left')], [root]),
      right = s.state([s.file('f', 'right')], [root]),
      c = s.input(left, right);
    s.objects.set(corruptPage ? c.plan.work.conflicts.sha256 : left, Buffer.from('{}'));
    await assert.rejects(drain(s, c), error => error.code === 'SOURCE_HASH_MISMATCH');
    if (corruptPage) {
      c.phase = 'graph';
      c.states = [left, right];
      await assert.rejects(drain(s, c), error => error.code === 'SOURCE_HASH_MISMATCH');
    }
  }
});

test('unknown, cyclic, closed side and criss-cross frontiers never manufacture a proof', () => {
  for (const parents of [
    { L: ['M', 'unknown'], R: ['M'], M: ['older'] },
    { L: ['A'], R: ['A'], A: ['A', 'M'], M: [] },
    { L: ['M', 'closed'], R: ['M'], M: [], closed: [] },
    { L: ['A', 'B'], R: ['B', 'A'], A: [], B: [] },
  ])
    assert.equal(sourceAncestryCut(parents, ['unknown', 'older'], ['L', 'R']), null);
});

test('an uncovered side branch remains required despite a known common ancestor', async () => {
  const s = fixture(),
    unknown = digest('not provided'),
    root = s.state([], [], 'root'),
    left = s.state([s.file('f', 'left')], [root, unknown]),
    right = s.state([s.file('f', 'right')], [root]);
  for (const legacy of [false, true])
    await assert.rejects(drain(s, s.input(left, right), { legacy }), /unknown State/);
});

test('an unavailable speculative boundary cannot fail independent frontier proof, but required bytes still fail', async t => {
  const reports = [];
  for (const failure of ['healthy', 'descriptor', 'bytes', 'required-boundary', 'required-side']) {
    const s = fixture(),
      common = s.state([s.file('f', 'base\n')], [], 'M'),
      c = s.state([s.file('f', 'C\n')], [common], 'C'),
      x = s.state([s.file('f', 'X\n')], [c], 'X'),
      a = s.state([s.file('f', 'A\n')], [c], 'A'),
      b = s.state([s.file('f', 'B\n')], [x], 'B'),
      left = s.state([s.file('f', 'left\n')], [a, common], 'L'),
      right = s.state([s.file('f', 'right\n')], [b, common], 'R'),
      initial = s.input(left, right),
      full = { ...structuredClone(initial), phase: 'compute', parents: structuredClone(s.parents) };
    await computeMergeStep(full, s.io);
    const unavailable = failure === 'required-side' ? a : common,
      describe = s.io.describeBatch,
      read = s.io.read;
    s.io.probeStates = async ids => ({
      refs: await describe(ids.filter(id => !(failure === 'descriptor' && id === unavailable))),
      unavailable: ids.filter(id => failure === 'descriptor' && id === unavailable),
    });
    // Throw the real typed deterministic error, never an untyped I/O failure.
    if (failure !== 'healthy' && failure !== 'descriptor') {
      const { ForgeError } = await import('../dist/errors.js');
      s.io.read = async pin => {
        if (pin.sha256 === unavailable)
          throw new ForgeError('SOURCE_UNAVAILABLE', 'Exact source unavailable.');
        return read(pin);
      };
    }
    if (failure === 'required-boundary') {
      // Here M supplies the actual maximal base's file tree.
      const l = s.state([s.file('f', 'left')], [common]),
        r = s.state([s.file('f', 'right')], [common]);
      await assert.rejects(drain(s, s.input(l, r)), { code: 'SOURCE_UNAVAILABLE' });
    } else if (failure === 'required-side')
      await assert.rejects(drain(s, initial), { code: 'SOURCE_UNAVAILABLE' });
    else {
      const selected = await drain(s, initial);
      assert.deepEqual(selected.output, s.objects.get(full.output.sha256));
      assert.deepEqual(selected.draft, s.objects.get(full.head));
      assert.equal(selected.cursor.ancestryBoundary, common);
      assert.equal(selected.graphReads.filter(id => id === common).length, failure === 'healthy' ? 1 : 0);
      reports.push({
        failure,
        graphReads: selected.graphReads.length,
        commonManifestReads: selected.graphReads.filter(id => id === common).length,
      });
    }
  }
  t.diagnostic(JSON.stringify({ reports, healthyExtraCommonManifestReads: 1 }));
});

test('selected tips preserve full-history resolution bytes across varied merged DAGs', async () => {
  let seed = 947;
  const random = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let sample = 0; sample < 60; sample++) {
    const s = fixture(),
      nodes = [s.state([s.file('f', 'base\n')])];
    for (let i = 1; i < 20; i++)
      nodes.push(
        s.state(
          [s.file('f', `variant ${random(4)}\n`)],
          [...new Set(Array.from({ length: 1 + random(3) }, () => nodes[random(i)]))],
          `node ${i}`,
        ),
      );
    const left = s.state([s.file('f', 'left\n')], [nodes[19], nodes[17]]),
      right = s.state([s.file('f', 'right\n')], [nodes[18], nodes[16]]),
      initial = s.input(left, right),
      full = { ...structuredClone(initial), phase: 'compute', parents: structuredClone(s.parents) };
    // Force the hint seam using authenticated unrelated prefetch. No hint
    // changes the conflict page's selected tips or proves an absent edge.
    for (let i = 0; i < 32; i++) initial.parents[s.state([], [], `prefetch-${i}`)] = [];
    await computeMergeStep(full, s.io);
    const legacy = await drain(s, initial, { legacy: true }),
      selected = await drain(s, initial);
    assert.deepEqual(selected.cursor.output, full.output, `full history sample ${sample}`);
    assert.deepEqual(selected.output, legacy.output, `legacy sample ${sample}`);
    assert.deepEqual(selected.draft, legacy.draft, `draft sample ${sample}`);
    let hintCalls = 0;
    const locations = new Map();
    s.io.probeStates = async (roots, options) => {
      const known = options?.known ?? [];
      if (options) hintCalls++;
      const ids =
        sample % 3 === 0
          ? []
          : sample % 3 === 1
            ? roots.slice(0, 1)
            : [...new Set([...roots.flatMap(id => s.parents[id] ?? []), ...roots.toReversed()])].filter(
                id => !known.includes(id),
              );
      for (const id of ids)
        locations.set(id, { object: { sha256: id, size: s.objects.get(id).length }, recipe: null });
      for (const ref of await s.io.describeBatch(roots.filter(id => !locations.has(id))))
        locations.set(ref.object.sha256, ref);
      return { refs: roots.map(id => locations.get(id)), unavailable: [] };
    };
    const hinted = await drain(s, initial);
    assert(hintCalls > 0, `exercise the actual probe/cache hint seam, sample ${sample}`);
    assert.deepEqual(hinted.cursor.output, full.output, `hinted full history sample ${sample}`);
    assert.deepEqual(hinted.output, selected.output, `hinted output sample ${sample}`);
    assert.deepEqual(hinted.draft, selected.draft, `hinted draft sample ${sample}`);
  }
});
