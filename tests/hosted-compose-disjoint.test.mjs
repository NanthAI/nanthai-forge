// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildComposePages, candidateFileList } from '../dist/hosted-compose.js';
import { changedPaths } from '../dist/hosted-compose-worker.js';
import { saveBytes } from '../dist/hosted-save.js';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { digest } from '../dist/hash.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { ForgeError } from '../dist/errors.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';

const at = '2026-11-26T12:00:00.000Z';
const file = (path, data = path, mode = 'file') => ({ path, blob: digest(data), mode });
const sorted = files => [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

function fixture({
  count = 1,
  batch = count > 1,
  large = false,
  overlap,
  badPin,
  restore = false,
  graph,
} = {}) {
  const storage = new Map();
  const states = new Map();
  const composeDeltas = {};
  const put = bytes => {
    const sha256 = digest(bytes);
    storage.set(sha256, bytes);
    return { sha256, size: bytes.length };
  };
  const json = value => put(Buffer.from(saveBytes(value)));
  const state = (files, parents, message = 'input') => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents,
        files: sorted(files),
        message,
        at,
      }),
    );
    const object = put(bytes);
    const recipe = large ? buildObjectRecipe(bytes) : null;
    if (recipe) for (const leaf of recipe.objects.values()) put(leaf);
    const ref = { object, recipe: recipe ? put(recipe.bytes) : null };
    states.set(object.sha256, {
      ref,
      files,
      parents,
      generation: 1 + Math.max(0, ...parents.map(id => states.get(id).generation)),
    });
    return ref;
  };
  const common = large
    ? Array.from({ length: 29000 }, (_, i) =>
        file(
          `src/deep/shared/components/features/generated/synthetic/fixture/module-${String(i).padStart(6, '0')}.ts`,
          'synthetic',
        ),
      )
    : [file('keep')];
  const shared = data => ({ path: 'merge.txt', blob: put(Buffer.from(data)).sha256, mode: 'file' });
  const before = sorted([
    file('delete'),
    file('rename-from'),
    file('mode'),
    ...common,
    ...(overlap === 'text' ? [shared('a\nb\nc\n')] : []),
  ]);
  const origin = state(before, [], 'origin');
  const base = state(before, [origin.object.sha256]);
  const side = graph === 'criss-cross' ? state(before, [origin.object.sha256], 'other root') : null;
  const mainFiles = [...before.filter(f => overlap !== 'deleted' || f.path !== 'delete'), file('main')];
  if (overlap === 'text') mainFiles[mainFiles.findIndex(f => f.path === 'merge.txt')] = shared('A\nb\nc\n');
  const main = state(mainFiles, [base.object.sha256, ...(side ? [side.object.sha256] : [])]);
  let previous;
  const entries = Array.from({ length: count }, (_, index) => {
    const memberBase = graph === 'stacked' && index ? previous : base;
    const baseFiles = states.get(memberBase.object.sha256).files;
    let files =
      index === 0
        ? [...common, file('rename-to', 'rename-from'), file('mode', 'mode', 'executable')]
        : index === 2
          ? before
          : [...before, file('other')];
    if (overlap === 'main' && index === count - 1) files = [...files, file('main/child')];
    if (overlap === 'peer' && index === count - 1) files = files.filter(item => item.path !== 'delete');
    if (overlap === 'text') files = [...before.filter(f => f.path !== 'merge.txt'), shared('a\nb\nC\n')];
    if (graph === 'empty') files = before;
    if (graph === 'fast-forward') files = [...mainFiles, file('fast-forward')];
    if (graph === 'already-merged') files = before;
    if (graph === 'modes')
      files = [...before, file('link', 'target', 'symlink'), file('module', 'commit', 'gitlink')];
    if (graph === 'stacked') files = index ? before : [...before, file('temporary')];
    const directBase = graph === 'fast-forward' ? main : memberBase;
    const selected =
      graph === 'already-merged'
        ? base
        : state(files, side ? [side.object.sha256, directBase.object.sha256] : [directBase.object.sha256]);
    previous = selected;
    const head = selected.object.sha256;
    const selection = batch
      ? { candidateId: randomUUID(), head, state: selected }
      : { laneId: randomUUID(), head, state: selected, sourceVersion: 0, version: 0, lifecycleVersion: 0 };
    const changed = new Map();
    changedPaths(changed, graph === 'fast-forward' ? sorted(mainFiles) : sorted(baseFiles), sorted(files));
    const listing = candidateFileList(directBase.object.sha256, head, changed, files, [selection]);
    if (badPin === 'malformed' && index === 0) delete listing.files[0].status;
    const pin = json(listing);
    if (badPin === 'hash' && index === 0) storage.set(pin.sha256, Buffer.from('different bytes'));
    if (badPin === 'missing' && index === 0) return selection;
    composeDeltas[head] = { base: directBase.object.sha256, files: pin };
    return selection;
  });
  const inputs = buildComposePages(batch ? [] : entries);
  const dependencies = buildComposePages(batch ? entries : []);
  for (const page of [...inputs.pages, ...dependencies.pages]) json(page.value);
  const plan = {
    schema: 1,
    kind: 'forge-hosted-compose-input',
    algorithm: 'forge-native-compose-v1',
    base: { head: main.object.sha256, receiptId: 'test' },
    main,
    at,
    message: 'recompose',
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    ...(batch ? { batch: { members: entries.map(entry => entry.candidateId) } } : {}),
    ...(restore ? { restoreBases: { [entries[0].laneId]: base } } : {}),
  };
  const input = json(plan);
  async function run(enabled, uploaded = new Map()) {
    const bodies = new Map(storage);
    const reads = new Map();
    const expected = new Set();
    let bytesRead = 0;
    const io = {
      ...(enabled && !restore ? { composeDeltas } : {}),
      expectState: id => expected.add(id),
      read: async pin => {
        reads.set(pin.sha256, (reads.get(pin.sha256) ?? 0) + 1);
        if (
          badPin === 'availability' &&
          Object.values(composeDeltas).some(delta => delta.files.sha256 === pin.sha256)
        )
          throw new ForgeError('SOURCE_UNAVAILABLE', 'Synthetic missing object.');
        assert(bodies.has(pin.sha256), 'every read names an exact fixture object');
        bytesRead += bodies.get(pin.sha256).length;
        return [bodies.get(pin.sha256)];
      },
      upload: async (pin, stream) => {
        const parts = [];
        for await (const part of stream) parts.push(Buffer.from(part));
        const bytes = Buffer.concat(parts);
        uploaded.set(pin.sha256, bytes);
        bodies.set(pin.sha256, bytes);
      },
      probeStates: async ids => ({ refs: io.describeBatch(ids), unavailable: [] }),
      describeBatch: ids =>
        ids.map(
          sha256 =>
            states.get(sha256)?.ref ?? {
              object: { sha256, size: bodies.get(sha256).length },
              recipe: null,
            },
        ),
      prepareRead: async () => {},
      stateParents: id =>
        graph === 'parent-mismatch' && id === main.object.sha256
          ? [base.object.sha256, origin.object.sha256]
          : states.get(id)?.parents,
      stateGeneration: id =>
        (graph === 'missing-generation' || badPin === 'missing-generation') && id === entries[0].head
          ? undefined
          : states.get(id)?.generation,
    };
    let cursor = initialSourceStep(input);
    for (let step = 1; step <= 12; step++) {
      ({ cursor } = await runSourceStep(cursor, io));
      if (cursor.phase === 'done') return { cursor, uploaded, reads, bytesRead, step, expected };
    }
    assert.fail('compose did not settle');
  }
  return { run, entries, main, base, composeDeltas };
}

async function assertDisjoint(settings) {
  const { run, entries, main, base, composeDeltas } = fixture(settings);
  const ordinary = await run(false);
  const fast = await run(true);
  assert.equal(fast.cursor.fastDisjoint, true);
  assert.equal(fast.step, 1);
  assert.deepEqual(fast.cursor.output, ordinary.cursor.output);
  for (const [id, bytes] of fast.uploaded) assert.deepEqual(bytes, ordinary.uploaded.get(id));
  for (const ref of [base, ...entries.map(entry => entry.state)]) {
    assert(!fast.reads.has(ref.object.sha256));
    if (ref.recipe) assert(!fast.reads.has(ref.recipe.sha256));
  }
  for (const entry of entries) assert(fast.expected.has(entry.head));
  assert.equal(fast.reads.get((main.recipe ?? main.object).sha256), 1);
  for (const pin of Object.values(composeDeltas)) assert.equal(fast.reads.get(pin.files.sha256), 1);
  return { ordinary, fast };
}

for (const settings of [
  {},
  { count: 1, batch: true },
  { count: 2 },
  { graph: 'empty' },
  { graph: 'modes' },
  { graph: 'stacked', count: 2 },
])
  test(`disjoint recompose emits exact sequential States and Candidate bytes (${JSON.stringify(settings)})`, async () =>
    assertDisjoint(settings));

test('three chunked cohort members recompose in one quantum with exact sequential State bytes', async t => {
  const { ordinary, fast } = await assertDisjoint({ count: 3, large: true });
  assert(fast.bytesRead < ordinary.bytesRead);
  t.diagnostic(
    JSON.stringify({
      ordinary: { steps: ordinary.step, sourceBytes: ordinary.bytesRead },
      disjoint: { steps: fast.step, sourceBytes: fast.bytesRead },
    }),
  );
});

for (const settings of [
  { overlap: 'main', count: 2 },
  { overlap: 'peer', count: 2 },
  { restore: true },
  { overlap: 'deleted' },
  { overlap: 'text' },
  { graph: 'criss-cross' },
  { graph: 'fast-forward' },
  { graph: 'already-merged' },
])
  test(`ordinary merge retains results for non-disjoint inputs (${JSON.stringify(settings)})`, async () => {
    const { run } = fixture(settings);
    const ordinary = await run(false);
    const actual = await run(true);
    assert.equal(actual.cursor.fastDisjoint, undefined);
    assert.deepEqual(actual.cursor.output, ordinary.cursor.output);
    assert.deepEqual(actual.uploaded, ordinary.uploaded);
  });

test('a trusted delta that fails its hash check stops the recompose before any publication', async () => {
  const { run } = fixture({ badPin: 'hash', count: 2 });
  const uploaded = new Map();
  await assert.rejects(run(true, uploaded), { code: 'SOURCE_RECOMPOSE_INVARIANT' });
  assert.equal(uploaded.size, 0);
});

for (const settings of [
  { badPin: 'malformed' },
  { badPin: 'missing' },
  { graph: 'parent-mismatch' },
  { graph: 'missing-generation' },
  { graph: 'fast-forward', badPin: 'missing-generation' },
])
  test(`a broken attached proof stops without uploads (${JSON.stringify(settings)})`, async () => {
    const uploaded = new Map();
    await assert.rejects(fixture(settings).run(true, uploaded), { code: 'SOURCE_RECOMPOSE_INVARIANT' });
    assert.equal(uploaded.size, 0);
  });

test('missing Candidate bytes retain the retryable availability error', async () => {
  const uploaded = new Map();
  await assert.rejects(fixture({ badPin: 'availability' }).run(true, uploaded), {
    name: 'SourceIoError',
    code: 'SOURCE_UNAVAILABLE',
  });
  assert.equal(uploaded.size, 0);
});

test('the recompose proof validates serialized output independent of the writer cache', async t => {
  const write = MemoryMergeSource.prototype.writeVerifiedComposeState;
  t.mock.method(MemoryMergeSource.prototype, 'writeVerifiedComposeState', function (...args) {
    const head = write.apply(this, args);
    this.objects.set(head, Buffer.from('different bytes'));
    return head;
  });
  const uploaded = new Map();
  await assert.rejects(fixture().run(true, uploaded), { code: 'SOURCE_RECOMPOSE_INVARIANT' });
  assert.equal(uploaded.size, 0);
});
