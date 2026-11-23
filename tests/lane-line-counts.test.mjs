// SPDX-License-Identifier: Apache-2.0
// Item c2388099: every changed file on the Lane page shows its +/- counts, recorded once by the saving CLI from the
// line sketches it already holds, against the Lane's first baseline. The row keeps them only in the room left after
// paths and evidence (so overlap, preflight and landing read the same row), a count measured against another version
// is dropped rather than shown, an older server is sent none, and the page's one read adds no document for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import {
  boundOverlapChanges,
  lineCounts,
  mergeOverlapChanges,
  OVERLAP_METADATA_BYTES,
} from '../dist/hosted-overlap.js';
import { lineBaseTag } from '../dist/hosted-overlap-evidence.js';
import { carryOverlapBases, overlapBaseBlobs } from '../dist/hosted-overlap-text.js';
import { saveChangeSchema } from '../dist/hosted-save.js';
import { saveContract } from '../dist/hosted-save-client.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
const { overlapBucket } = await import(moduleUrl('../convex/projectHostedOverlapChanges.ts'));

async function checkout(t, files) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-line-counts-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'lane'),
    cache = `${root}.forge-client`;
  mkdirSync(join(root, '.forge'), { recursive: true });
  const [[firstPath, firstText]] = Object.entries(files);
  const s = await saveFixture(firstText, firstPath);
  const extra = Object.entries(files).slice(1);
  const state = {
    schema: 1,
    kind: 'forge-hosted-lane-checkout',
    url: 'https://fixture.invalid',
    operationId: randomUUID(),
    selection: {
      schema: 2,
      projectId: s.projectId,
      laneId: s.laneId,
      intentId: randomUUID(),
      head: s.baseline.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      base: { head: s.baseline.sha256, receiptId: 'main-0' },
      authority: { mode: 'server', epoch: 1 },
    },
    state: {
      ...s.state,
      files: [
        ...s.state.files,
        ...extra.map(([path, text]) => ({ path, blob: digest(text), mode: 'file' })),
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
    scope: Object.keys(files),
    materialized: Object.keys(files),
  };
  const marker = join(root, '.forge/hosted-lane.json');
  writeFileSync(marker, JSON.stringify(state));
  mkdirSync(join(cache, 'objects'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(cache, 'objects', digest(text)), text, { mode: 0o600 });
    writeFileSync(join(root, path), text);
  }
  let saves = 0;
  return {
    root,
    cache,
    capture: () => captureHostedSave(root, join(parent, `save-${++saves}`)),
    /** The checkout now sits on this save: its files are the new baseline, the Lane's first baseline stays cached. */
    advance(captured) {
      for (const change of captured.changes) {
        const index = state.state.files.findIndex(file => file.path === change.path);
        if (!change.after) {
          state.state.files.splice(index, 1);
          state.materialized = state.materialized.filter(path => path !== change.path);
        } else state.state.files[index] = { ...state.state.files[index], blob: change.after.blob };
      }
      state.selection.head = digest(`save ${saves}`);
      writeFileSync(marker, JSON.stringify(state));
    },
    /** A sync moved the Lane's base to a newer main; the server row keeps its paths and their first baseline. */
    rebase(baseHead) {
      state.selection.base = { head: baseHead, receiptId: 'main-1' };
      state.selection.head = digest(`synced ${baseHead}`);
      writeFileSync(marker, JSON.stringify(state));
    },
    /** The Lane opened in a second client folder at its current head: own cache, no first-baseline record. */
    continueIn(t2) {
      const second = mkdtempSync(join(tmpdir(), 'forge-line-counts-2-'));
      t2.after(() => rmSync(second, { recursive: true, force: true }));
      const root2 = join(second, 'lane'),
        cache2 = `${root2}.forge-client`;
      mkdirSync(join(root2, '.forge'), { recursive: true });
      mkdirSync(join(cache2, 'objects'), { recursive: true });
      const state2 = structuredClone({ ...state, operationId: randomUUID() }),
        marker2 = join(root2, '.forge/hosted-lane.json');
      writeFileSync(marker2, JSON.stringify(state2));
      for (const path of state.materialized) {
        const bytes = readFileSync(join(root, path));
        writeFileSync(join(root2, path), bytes);
        writeFileSync(join(cache2, 'objects', digest(bytes)), bytes, { mode: 0o600 });
      }
      let saves2 = 0;
      return {
        root: root2,
        capture: () => captureHostedSave(root2, join(second, `save-${++saves2}`)),
        advance(captured) {
          for (const change of captured.changes)
            state2.state.files.find(entry => entry.path === change.path).blob = change.after.blob;
          state2.selection.head = digest(`second ${saves2}`);
          writeFileSync(marker2, JSON.stringify(state2));
        },
      };
    },
  };
}

const base = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');

test('a save records +/- against the Lane base across saves; a lost baseline shows nothing, never a wrong count', async t => {
  const lane = await checkout(t, { 'a.txt': base, 'gone.txt': 'one\ntwo\nthree\n' });
  writeFileSync(join(lane.root, 'a.txt'), base.replace('line 3\n', 'line 3\ninserted\n'));
  writeFileSync(join(lane.root, 'new.ts'), 'export const a = 1;\nexport const b = 2;\n');
  rmSync(join(lane.root, 'gone.txt'));
  const first = await lane.capture();
  const by = path => first.changes.find(change => change.path === path);
  assert.deepEqual(by('a.txt').lines, [1, 0, lineBaseTag(digest(base))]);
  assert.deepEqual(by('new.ts').lines, [2, 0, lineBaseTag(null)], 'an added file counts every line');
  assert.deepEqual(by('gone.txt').lines, [0, 3, lineBaseTag(digest('one\ntwo\nthree\n'))], 'a deletion too');
  for (const change of first.changes)
    assert(saveChangeSchema.safeParse(change).success, 'the page schema takes it');
  const row1 = JSON.parse(mergeOverlapChanges([], first.changes).changes);
  assert.deepEqual(
    row1.map(change => [change.path, lineCounts(change)]),
    [
      ['a.txt', [1, 0]],
      ['gone.txt', [0, 3]],
      ['new.ts', [2, 0]],
    ],
  );

  // A second save edits the same file again: its delta's before is the first save, its count is still against the
  // Lane's base, which is the before the row keeps.
  lane.advance(first);
  writeFileSync(
    join(lane.root, 'a.txt'),
    base.replace('line 3\n', 'line 3\ninserted\n').replace('line 9\n', 'nine\n'),
  );
  const second = await lane.capture();
  const edit = second.changes.find(change => change.path === 'a.txt');
  assert.notEqual(edit.before.blob, digest(base));
  assert.deepEqual(edit.lines, [2, 1, lineBaseTag(digest(base))]);
  const row2 = JSON.parse(mergeOverlapChanges(row1, second.changes).changes);
  assert.deepEqual(lineCounts(row2.find(change => change.path === 'a.txt')), [2, 1]);
  assert.deepEqual(
    lineCounts(row2.find(change => change.path === 'new.ts')),
    [2, 0],
    'untouched paths keep theirs',
  );

  // This checkout loses the Lane's first-baseline record: the CLI can only measure against the last save, so the
  // merged row (whose before is still the base) keeps no count for that file rather than a wrong one.
  lane.advance(second);
  for (const name of readdirSync(lane.cache))
    if (name.startsWith('overlap-base')) rmSync(join(lane.cache, name));
  writeFileSync(join(lane.root, 'a.txt'), base.replace('line 9\n', 'nine\n'));
  const third = await lane.capture();
  const lost = third.changes.find(change => change.path === 'a.txt');
  assert.deepEqual(lost.lines, [0, 1, lineBaseTag(lost.before.blob)], 'measured against the last save');
  const row3 = JSON.parse(mergeOverlapChanges(row2, third.changes).changes);
  const shown = row3.find(change => change.path === 'a.txt');
  assert.equal(shown.before.blob, digest(base));
  assert.equal(shown.lines, undefined, 'dropped, not stored');
  assert.equal(lineCounts(shown), null);
});

test('review f25d5544 finding 1: counts survive a sync to a newer main, a resolution rebind and a second folder', async t => {
  const other = 'one\ntwo\nthree\n';
  const lane = await checkout(t, { 'a.txt': base, 'c.txt': other });
  writeFileSync(join(lane.root, 'a.txt'), base.replace('line 3\n', 'line 3\ninserted\n'));
  writeFileSync(join(lane.root, 'c.txt'), 'one\n2\nthree\n');
  const first = await lane.capture();
  const row1 = JSON.parse(mergeOverlapChanges([], first.changes).changes);

  // A sync to a newer main (main changed only b.txt): the row keeps a.txt's first baseline, and so does this folder.
  lane.advance(first);
  const main = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [
        { path: 'a.txt', blob: digest(base), mode: 'file' },
        { path: 'b.txt', blob: digest('main\n'), mode: 'file' },
        { path: 'c.txt', blob: digest(other), mode: 'file' },
      ],
      message: 'main 2',
      at: '2026-01-02T00:00:00.000Z',
    }),
  );
  lane.rebase(digest(main));
  writeFileSync(
    join(lane.root, 'a.txt'),
    base.replace('line 3\n', 'line 3\ninserted\n').replace('line 9\n', 'nine\n'),
  );
  const second = await lane.capture();
  const synced = second.changes.find(change => change.path === 'a.txt');
  assert.deepEqual(
    synced.lines,
    [2, 1, lineBaseTag(digest(base))],
    'measured against the shown base, not the save',
  );
  const row2 = JSON.parse(mergeOverlapChanges(row1, second.changes).changes);
  assert.deepEqual(lineCounts(row2.find(change => change.path === 'a.txt')), [2, 1]);

  // Rebound onto its own resolution Lane, the folder keeps them: that row starts from this one.
  const laneId = JSON.parse(readFileSync(join(lane.root, '.forge/hosted-lane.json'), 'utf8')).selection
      .laneId,
    resolution = randomUUID();
  carryOverlapBases(lane.cache, laneId, resolution);
  assert.equal(overlapBaseBlobs(lane.cache, resolution, digest(main))['a.txt'], digest(base));
  carryOverlapBases(lane.cache, resolution, laneId);

  // Continued in a second folder: no record there, so it reads the base State from this machine's object store (which
  // the first folder filled) and measures against the base the row shows.
  lane.advance(second);
  const machine = mkdtempSync(join(tmpdir(), 'forge-line-counts-machine-')),
    previous = process.env.FORGE_OBJECT_CACHE;
  process.env.FORGE_OBJECT_CACHE = machine;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_OBJECT_CACHE;
    else process.env.FORGE_OBJECT_CACHE = previous;
    rmSync(machine, { recursive: true, force: true });
  });
  writeFileSync(join(machine, digest(main)), main);
  writeFileSync(join(machine, digest(base)), base);
  writeFileSync(join(machine, digest(other)), other);
  const elsewhere = lane.continueIn(t);
  writeFileSync(
    join(elsewhere.root, 'a.txt'),
    base.replace('line 3\n', 'line 3\ninserted\n').replace('line 9\n', 'nine\n').replace('line 15\n', ''),
  );
  const third = await elsewhere.capture();
  const continued = third.changes.find(change => change.path === 'a.txt');
  assert.notEqual(continued.before.blob, digest(base));
  assert.deepEqual(continued.lines, [2, 2, lineBaseTag(digest(base))]);
  const row3 = JSON.parse(mergeOverlapChanges(row2, third.changes).changes);
  assert.deepEqual(lineCounts(row3.find(change => change.path === 'a.txt')), [2, 2]);

  // A second save there edits a file only the first folder saved: that folder's record lacks it, and it still counts
  // against the shown base (review a42b7a29 finding 1).
  elsewhere.advance(third);
  writeFileSync(join(elsewhere.root, 'c.txt'), 'one\n2\nthree\nfour\n');
  const fourth = await elsewhere.capture();
  const later = fourth.changes.find(change => change.path === 'c.txt');
  assert.deepEqual(later.lines, [2, 1, lineBaseTag(digest(other))]);
  const row4 = JSON.parse(mergeOverlapChanges(row3, fourth.changes).changes);
  assert.deepEqual(lineCounts(row4.find(change => change.path === 'c.txt')), [2, 1]);
  assert.deepEqual(
    lineCounts(row4.find(change => change.path === 'a.txt')),
    [2, 2],
    'untouched keeps its count',
  );
});

test('counts ride in the room left: paths and evidence are chosen exactly as without them', () => {
  const side = seed => ({ blob: digest(seed), mode: 'file' });
  const many = Array.from({ length: 900 }, (_, i) => ({
    path: `src/${String(i).padStart(4, '0')}-a-reasonably-long-module-name.ts`,
    before: side(`b${i}`),
    after: side(`a${i}`),
    evidence: { baseBlob: digest(`b${i}`), ranges: [{ start: i, end: i + 1 }], symbols: [] },
  }));
  const counted = many.map((change, i) => ({ ...change, lines: [i, 1, lineBaseTag(change.before.blob)] }));
  const plain = boundOverlapChanges(many),
    withLines = boundOverlapChanges(counted);
  const strip = text => JSON.parse(text).map(({ lines, ...rest }) => rest);
  assert.deepEqual(strip(withLines.changes), JSON.parse(plain.changes), 'same paths and evidence');
  assert.equal(withLines.complete, plain.complete);
  assert(new TextEncoder().encode(withLines.changes).length <= OVERLAP_METADATA_BYTES);
  // A small save keeps every count: about 24 bytes a file.
  const small = boundOverlapChanges(counted.slice(0, 10));
  const grew = small.changes.length - boundOverlapChanges(many.slice(0, 10)).changes.length;
  assert(JSON.parse(small.changes).every(change => lineCounts(change)));
  assert(grew / 10 <= 26, `${grew / 10} bytes a file`);
});

test('an older server is sent no counts; the page schema takes only a well-formed count', () => {
  assert(hostedContractFeatures.includes('save-line-counts'));
  assert.equal(saveContract({ features: [] }).lineCounts, false);
  assert.equal(saveContract({ features: ['save-line-counts'] }).lineCounts, true);
  const change = {
    path: 'a.txt',
    before: null,
    after: {
      blob: digest('x'),
      mode: 'file',
      content: { object: { sha256: digest('x'), size: 1 }, recipe: null },
    },
  };
  assert(saveChangeSchema.safeParse({ ...change, lines: [1, 0, 'abcdef'] }).success);
  for (const lines of [
    [1, 0],
    [-1, 0, 'abcdef'],
    [1, 0, 'ABCDEF'],
    [1, 0, 'abcdef', 1],
  ])
    assert(!saveChangeSchema.safeParse({ ...change, lines }).success, JSON.stringify(lines));
});

test("the Lane page's one read carries the recorded counts with no extra document; a stale tag shows none", async t => {
  const review = await import(moduleUrl('../convex/projectLaneReview.ts'));
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const s = await saveFixture('original', 'a.txt');
  const lane = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const write = (record, overlap, expectedVersion = null) =>
    s.transaction(
      'write',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion,
            record,
            overlap,
          }),
      },
      {},
    );
  const first = {
    ...lane,
    id: randomUUID(),
    intentId: randomUUID(),
    version: 0,
    at: new Date().toISOString(),
  };
  await write(first, { baseSequence: 0, intent: 'Counts' });
  const side = seed => ({ blob: digest(seed), mode: 'file' });
  const changes = [
    { path: 'src/a.ts', before: side('a0'), after: side('a1'), lines: [12, 3, lineBaseTag(digest('a0'))] },
    { path: 'src/b.ts', before: null, after: side('b1'), lines: [40, 0, lineBaseTag(null)] },
    { path: 'src/c.ts', before: side('c0'), after: side('c1'), lines: [5, 5, lineBaseTag(digest('other'))] },
    { path: 'src/d.ts', before: side('d0'), after: side('d1') },
  ];
  const saved = { ...first, head: digest(first.id), version: 1, sourceVersion: 1 };
  await write(saved, { baseSequence: 0, intent: 'Counts', changes }, 0);
  const reply = JSON.parse(
    await s.transaction(
      'projectLaneReview:read',
      review.read,
      { projectId: s.projectId, laneId: saved.id },
      'owner',
    ),
  );
  assert.deepEqual(
    reply.files.items.map(item => [item.path, item.lines ?? null]),
    [
      ['src/a.ts', [12, 3]],
      ['src/b.ts', [40, 0]],
      ['src/c.ts', null],
      ['src/d.ts', null],
    ],
    'a count measured against another version, or an older save with none, shows nothing',
  );
  const meter = s.counts.filter(c => c.name === 'projectLaneReview:read').at(-1);
  t.diagnostic(`per view: ${meter.documents} documents, ${meter.readBytes} bytes`);
  // The saved list is read whole: one bucket document per distinct path hash, beside the handful of Lane documents.
  const bucketDocuments = new Set(changes.map(change => overlapBucket(change.path))).size;
  assert(meter.documents <= 10 + bucketDocuments, `reads ${meter.documents} documents`);
});
