// SPDX-License-Identifier: Apache-2.0
// Incident replay, Issue 55bcad06: a three-member batch reported every member LANDED while the
// shared State carried none of member 3's paths. The stepped compose moved its cursor past
// member 3 before an on-main probe that needed a fresh text merge, so the member was neither
// merged nor dropped and the result still said "clean".
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initialSourceStep, runSourceStep, enqueueSourceObject } from '../dist/hosted-source-step.js';
import { runSourceTask, applySourceFanout } from '../dist/hosted-source-fanout.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { assertBatchAccounted, batchCoverageGaps, proveMerged } from '../dist/hosted-batch-coverage.js';
import { moduleUrl } from './convex-module.mjs';
const { batchCoverageFailure } = await import(moduleUrl('../convex/projectHostedBatchCoverage.ts'));
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';

const at = '2026-01-01T00:00:00.000Z';
/** The Convex step shape: fan-out exists and uploads become readable when their step commits. */
function committedFixture() {
  const committed = new Map(),
    staged = new Map();
  let plan = null;
  const put = b => {
    b = Buffer.from(b);
    const p = { sha256: digest(b), size: b.length };
    committed.set(p.sha256, b);
    return p;
  };
  const json = v => put(saveBytes(v));
  const absent = id =>
    Object.assign(new Error(`Exact source object is absent: ${id}`), {
      name: 'ForgeError',
      code: 'SOURCE_UNAVAILABLE',
    });
  const io = {
    async describeBatch(ids) {
      return ids.map(id => {
        const b = committed.get(id);
        if (!b) throw absent(id);
        return { object: { sha256: id, size: b.length }, recipe: null };
      });
    },
    async read(p) {
      const b = committed.get(p.sha256);
      if (!b) throw absent(p.sha256);
      return (async function* () {
        yield b;
      })();
    },
    async upload(p, stream) {
      const parts = [];
      for await (const c of stream) parts.push(c);
      const b = Buffer.concat(parts);
      assert.equal(digest(b), p.sha256);
      staged.set(p.sha256, b);
    },
    fanout(value) {
      plan = value;
    },
  };
  const commit = () => {
    for (const [id, b] of staged) committed.set(id, b);
    staged.clear();
  };
  const take = () => {
    const value = plan;
    plan = null;
    return value;
  };
  const state = (files, parents = []) =>
    json({ schema: 1, kind: 'forge-source-state', parents, files, message: 'seed', at });
  return { committed, put, json, state, io, commit, take };
}
async function drainCommitted(x, input) {
  let c = initialSourceStep(input),
    steps = 0;
  while (c.phase !== 'done') {
    assert(++steps < 80, 'finite continuations');
    const result = await runSourceStep(c, x.io);
    x.commit();
    c = JSON.parse(JSON.stringify(result.cursor));
    const plan = x.take();
    if (!plan) continue;
    const results = [];
    for (const task of plan.tasks) {
      let previous = null,
        done;
      do {
        done = await runSourceTask(task, previous, x.io);
        previous = done.progress;
      } while (!done.done);
      x.commit();
      results.push(done.progress);
    }
    applySourceFanout(c, plan, results, ref => enqueueSourceObject(c, ref));
  }
  return c;
}
const lines = edits => {
  const out = Array.from({ length: 24 }, (_, i) => `line ${i}`);
  for (const [i, v] of Object.entries(edits)) out[i] = v;
  return out.join('\n') + '\n';
};

function incident() {
  const x = committedFixture(),
    file = (path, text) => ({ path, mode: 'file', blob: x.put(text).sha256 });
  const root = x.state([file('shared.txt', lines({}))]);
  // Main moved under the cohort: every member merge onto it needs a text merge.
  const main = x.state([file('shared.txt', lines({ 20: 'main' }))], [root.sha256]);
  const m1 = x.state([file('shared.txt', lines({ 0: 'member one' }))], [root.sha256]);
  const m2 = x.state([file('shared.txt', lines({})), file('two.txt', 'two\n')], [root.sha256]);
  // Member 3 edits member 1's line (a prefix-only conflict) and adds its own file.
  const m3 = x.state(
    [file('shared.txt', lines({ 0: 'member three' })), file('three.txt', 'three\n')],
    [root.sha256],
  );
  const members = [m1, m2, m3].map(head => ({
    candidateId: randomUUID(),
    head: head.sha256,
    state: { object: head, recipe: null },
  }));
  const dependencies = buildComposePages(members),
    inputs = buildComposePages([]);
  for (const page of [...dependencies.pages, ...inputs.pages]) x.json(page.value);
  const input = x.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    batch: { members: members.map(m => m.candidateId) },
    base: { head: main.sha256, receiptId: randomUUID() },
    main: { object: main, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'Compose concurrent hosted landings',
    at,
  });
  return { x, members, input };
}
const paths = (x, head) => JSON.parse(x.committed.get(head)).files.map(f => f.path);

test('incident replay: a member whose on-main probe needs a fresh merge is dropped, never skipped', async () => {
  const { x, members, input } = incident();
  const cursor = await drainCommitted(x, input);
  const output = JSON.parse(x.committed.get(cursor.output.sha256));
  assert.equal(output.result.status, 'clean');
  // Member 3 conflicts only with member 1 (the prefix), so it is retained as a dropped
  // member for its own landing; it is never silently absent from both lists.
  assert.deepEqual(
    output.dropped.map(d => d.candidateId),
    [members[2].candidateId],
  );
  assert.equal(output.dropped[0].againstMain, undefined, 'member 3 merges cleanly onto main alone');
  assert.deepEqual(cursor.batchMerged, [members[0].candidateId, members[1].candidateId]);
  assert.deepEqual(paths(x, output.result.state.sha256).sort(), ['shared.txt', 'two.txt']);
  // The fixed single-process worker reaches the same accounting.
  const fixed = await buildHostedSourceState(input, x.io);
  const expected = JSON.parse(x.committed.get(fixed.output.sha256));
  assert.deepEqual(
    expected.dropped.map(d => d.candidateId),
    [members[2].candidateId],
  );
  assert.equal(expected.result.state.sha256, output.result.state.sha256);
});

test('a batch publishes one exact file listing even when its last member is dropped after a resumed merge', async () => {
  const { x, members, input } = incident();
  const cursor = await drainCommitted(x, input);
  const output = JSON.parse(x.committed.get(cursor.output.sha256));
  const listing = JSON.parse(x.committed.get(output.result.candidateFiles.sha256));
  assert.equal(listing.base, JSON.parse(x.committed.get(input.sha256)).base.head);
  assert.equal(listing.head, output.result.state.sha256);
  assert.deepEqual(
    listing.files.map(file => file.path),
    ['shared.txt', 'two.txt'],
  );
  assert.deepEqual(
    listing.dependencies,
    members.map(({ candidateId, head }) => ({ candidateId, head })),
  );
  assert.equal(
    [...x.committed.values()].filter(bytes => {
      try {
        return JSON.parse(bytes).kind === 'forge-candidate-files';
      } catch {
        return false;
      }
    }).length,
    1,
  );
  const fixed = await buildHostedSourceState(input, x.io);
  x.commit();
  const expected = JSON.parse(x.committed.get(fixed.output.sha256));
  assert.deepEqual(expected.result.candidateFiles, output.result.candidateFiles);
});

test('a batch result that neither merges nor drops a member is refused', () => {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  assertBatchAccounted([a, b, c], [a, b], [{ candidateId: c }]);
  assert.throws(() => assertBatchAccounted([a, b, c], [a, b], []), { code: 'SOURCE_JOB_INVALID' });
  assert.throws(() => assertBatchAccounted([a, b], [a, b], [{ candidateId: b }]), {
    code: 'SOURCE_JOB_INVALID',
  });
  assert.throws(() => assertBatchAccounted([a, b], [a, a], []), { code: 'SOURCE_JOB_INVALID' });
});

const h = c => c.repeat(64);
/** Count the spine reads and the complete catalog/point-authority miss path. */
function objectsCtx(parents) {
  const reads = [];
  const ctx = {
    db: {
      query(table) {
        if (table === 'projectObjectReceipts') {
          return {
            withIndex(index, build) {
              assert.equal(index, 'by_key');
              const q = {
                eq(field, value) {
                  assert.equal(field, 'key');
                  assert.equal(value, 'source-points:p');
                  return q;
                },
              };
              build(q);
              return { unique: async () => (reads.push(table), null) };
            },
          };
        }
        if (table === 'projectObjectCatalog') {
          // No imported catalog page covers these digests.
          const chain = {
            withIndex: () => chain,
            order: () => chain,
            take: async () => (reads.push(table), []),
          };
          return chain;
        }
        assert.equal(table, 'projectObjects');
        let digest;
        const q = { eq: (field, value) => ((digest = field === 'digest' ? value : digest), q) };
        return {
          withIndex(index, build) {
            assert.equal(index, 'by_project_and_digest');
            build(q);
            return {
              async unique() {
                reads.push(digest);
                return digest in parents
                  ? {
                      projectId: 'p',
                      digest,
                      size: 1,
                      nonce: 'n',
                      removed: false,
                      stateParents: parents[digest],
                    }
                  : null;
              },
            };
          },
        };
      },
    },
  };
  return { ctx, reads };
}
// The incident graph: aa228c06 = merge(dc5620ff, m2), dc5620ff = merge(base, m1); m3 nowhere.
const [base, m1, m2, m3, dc, aa] = ['b', '1', '2', '3', 'd', 'a'].map(h);
const incidentParents = { [aa]: [dc, m2], [dc]: [base, m1] };
const members = [
  { submissionId: 's1', head: m1, paths: ['docs/status.md', 'src/one.ts'] },
  { submissionId: 's2', head: m2, paths: ['docs/status.md', 'src/two.ts'] },
  {
    submissionId: 's3',
    head: m3,
    paths: ['docs/status.md', 'src/three.ts', ...Array.from({ length: 12 }, (_, i) => `t/${i}`)],
  },
];

test('acceptance coverage: the incident batch is refused, a complete one costs no read', async () => {
  const shared = ['docs/status.md', 'src/one.ts', 'src/two.ts'];
  const clean = objectsCtx(incidentParents);
  assert.equal(
    await batchCoverageFailure(clean.ctx, {
      projectId: 'p',
      head: aa,
      base,
      shared,
      members: members.slice(0, 2),
    }),
    null,
  );
  assert.deepEqual(clean.reads, [], 'normal path: no read beyond the Candidates already loaded');
  const lost = objectsCtx(incidentParents);
  const gap = await batchCoverageFailure(lost.ctx, { projectId: 'p', head: aa, base, shared, members });
  assert.equal(gap.submissionId, 's3');
  assert.equal(gap.missing[0], 'src/three.ts');
  assert.equal(gap.missing.length, 10);
  assert.equal(gap.more, 3);
  assert(lost.reads.length <= 2 * members.length + 2, 'bounded walk');
});

test('acceptance coverage: a net-unchanged path of a merged member still publishes; unknown parents do not', async () => {
  // Member 2's file already had its bytes on the shared base, so the shared diff omits it.
  const shared = ['docs/status.md', 'src/one.ts'];
  const proven = objectsCtx(incidentParents);
  assert.equal(
    await batchCoverageFailure(proven.ctx, {
      projectId: 'p',
      head: aa,
      base,
      shared,
      members: members.slice(0, 2),
    }),
    null,
  );
  assert.deepEqual(proven.reads, [aa, dc], 'one indexed row per spine State, nothing else');
  // Without recorded parents nothing proves the member merged: never publish on a guess.
  const unknown = objectsCtx({});
  const gap = await batchCoverageFailure(unknown.ctx, {
    projectId: 'p',
    head: aa,
    base,
    shared,
    members: members.slice(0, 2),
  });
  assert.equal(gap.submissionId, 's2');
  // Unknown path lists are gaps too; a fast-forwarded member is a spine State itself.
  assert.deepEqual(
    batchCoverageGaps(undefined, members).map(g => g.submissionId),
    ['s1', 's2', 's3'],
  );
  assert.equal(await proveMerged(m1, base, [m1], async id => ({ [m1]: [base] })[id] ?? null, 4), true);
  assert.equal(await proveMerged(aa, base, [m3], async id => incidentParents[id] ?? null, 6), false);
  assert.equal(await proveMerged(aa, base, [m1], async id => incidentParents[id] ?? null, 1), false, 'limit');
});
