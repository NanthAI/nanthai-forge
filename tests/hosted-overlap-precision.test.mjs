// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { classifyOverlap } from '../dist/hosted-overlap-evidence.js';
import { overlapTextSketch, overlapTextEvidence, readOverlapText } from '../dist/hosted-overlap-text.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { hostedOverlapAdvice, mergeOverlapChanges } from '../dist/hosted-overlap.js';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';

const before = { blob: digest('base'), mode: 'file' };
const change = (start, end = start + 1, symbols = []) => ({
  before,
  after: { blob: digest(`edit ${start} ${end} ${symbols}`), mode: 'file' },
  evidence: { baseBlob: before.blob, ranges: [{ start, end }], symbols },
});

test('only source intersections and distinct path operations block; shared symbols alone do not', () => {
  assert.equal(classifyOverlap(change(2), change(20)).class, 'advisory');
  assert.equal(classifyOverlap(change(2, 6), change(4, 8)).class, 'blocking');
  assert.equal(classifyOverlap(change(2), change(3)).class, 'blocking');
  assert.equal(classifyOverlap(change(2), change(4)).class, 'advisory', 'one untouched line separates hunks');
  assert.equal(
    classifyOverlap(change(2, 2), { ...change(2, 2), after: change(3).after }).class,
    'blocking',
    'same insertion anchor',
  );
  assert.equal(classifyOverlap(change(2, 3, ['fn']), change(20, 21, ['fn'])).reason, 'disjoint-ranges');
  const changedBase = digest('different source base');
  assert.equal(
    classifyOverlap(change(2, 3, ['fn']), {
      ...change(20, 21, ['fn']),
      before: { ...before, blob: changedBase },
      evidence: { ...change(20, 21, ['fn']).evidence, baseBlob: changedBase },
    }).reason,
    'unavailable',
    'symbol names do not establish a conflict across different line coordinate systems',
  );
  assert.equal(classifyOverlap({ ...change(2), after: null }, change(20)).reason, 'delete-or-rename');
  // Rename deltas contain a deletion at the old path and an addition at the new one.
  const renamed = { path: 'old.ts', ...change(2), after: null };
  assert.equal(classifyOverlap(change(20), renamed).class, 'blocking');
  assert.equal(classifyOverlap({ ...change(2), evidence: undefined }, change(20)).reason, 'unavailable');
  assert.equal(
    classifyOverlap(change(2), {
      ...change(2),
      evidence: { ...change(2).evidence, baseBlob: digest('other base') },
    }).class,
    'advisory',
    'different coordinate systems never manufacture overlap',
  );
});

test('separate body changes in one function retain ownership evidence without manufacturing conflicts', () => {
  const base = `export function shared() {\n${Array.from({ length: 35 }, (_, i) => `  step(${i});\n`).join('')}}\nexport function other() { return 1; }\n`;
  const a = overlapTextEvidence(
    digest(base),
    overlapTextSketch(Buffer.from(base)),
    overlapTextSketch(Buffer.from(base.replace('step(2)', 'first(2)'))),
    true,
  );
  const b = overlapTextEvidence(
    digest(base),
    overlapTextSketch(Buffer.from(base)),
    overlapTextSketch(Buffer.from(base.replace('step(30)', 'second(30)'))),
    true,
  );
  assert.deepEqual(a.symbols, ['shared']);
  assert.deepEqual(b.symbols, ['shared']);
  const wrap = evidence => ({
    before: { ...before, blob: digest(base) },
    after: { blob: digest(JSON.stringify(evidence)), mode: 'file' },
    evidence,
  });
  assert.equal(classifyOverlap(wrap(a), wrap(b)).reason, 'disjoint-ranges');
  assert.equal(
    classifyOverlap(wrap({ ...a, symbols: [] }), wrap({ ...b, symbols: [] })).class,
    'advisory',
    'documentation ignores code-like declarations',
  );
});

test('successive captures lazily retain exact original base coordinates from verified cached bytes', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-overlap-precision-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'lane'),
    cache = `${root}.forge-client`;
  mkdirSync(join(root, '.forge'), { recursive: true });
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  const s = await saveFixture(base);
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
    state: s.state,
    scope: ['a.txt'],
    materialized: ['a.txt'],
  };
  const marker = join(root, '.forge/hosted-lane.json');
  writeFileSync(marker, JSON.stringify(state));
  mkdirSync(join(cache, 'objects'), { recursive: true });
  const original = join(cache, 'objects', s.original.sha256);
  writeFileSync(original, base, { mode: 0o600 });
  assert.equal(existsSync(join(cache, 'overlap-text')), false, 'open needs no eager sketch');
  const first = base.replace('line 2\n', 'inserted\nline 2\n');
  writeFileSync(join(root, 'a.txt'), first);
  const captured = await captureHostedSave(root, join(parent, 'first'));
  assert.deepEqual(captured.changes[0].evidence.ranges, [{ start: 2, end: 2 }]);
  assert.equal(readOverlapText(cache, s.original.sha256).lines.length, 40);
  rmSync(original); // Subsequent saves reuse the original sketch after the object goes away.
  state.state.files[0].blob = digest(first);
  state.selection.head = digest('first saved state');
  writeFileSync(marker, JSON.stringify(state));
  const second = base.replace('line 30\n', 'second edit\n');
  writeFileSync(join(root, 'a.txt'), second); // Revert the insertion and edit a distant line.
  const saved = await captureHostedSave(root, join(parent, 'second'));
  assert.deepEqual(saved.changes[0].evidence.ranges, [{ start: 30, end: 31 }]);
  assert.equal(saved.changes[0].evidence.baseBlob, s.original.sha256);
  const projection = JSON.parse(mergeOverlapChanges(captured.changes, saved.changes).changes)[0];
  assert.equal(projection.before.blob, s.original.sha256);
  assert.deepEqual(projection.evidence.ranges, [{ start: 30, end: 31 }]);
  assert(
    !readFileSync(join(cache, 'overlap-text', `${s.original.sha256}.json`), 'utf8').includes('line 30'),
    'sketch holds hashes, not source lines',
  );
  assert.equal(overlapTextSketch(Buffer.from([0, 255])), null);
  assert.equal(overlapTextEvidence(s.original.sha256, null, null, false), undefined);
});

test('lazy overlap evidence rejects corrupt, missing, oversized and linked baseline objects', t => {
  const cache = mkdtempSync(join(tmpdir(), 'forge-overlap-lazy-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(cache, 'objects'));
  const bytes = Buffer.from('export function original() { return 1; }\n'),
    blob = digest(bytes);
  const path = join(cache, 'objects', blob),
    outside = join(cache, 'original');
  assert.equal(readOverlapText(cache, blob), null);
  writeFileSync(path, 'corrupt');
  assert.equal(readOverlapText(cache, blob), null);
  assert.equal(existsSync(join(cache, 'overlap-text')), false);
  rmSync(path);
  writeFileSync(outside, bytes);
  symlinkSync(outside, path);
  assert.equal(readOverlapText(cache, blob), null);
  rmSync(path);
  linkSync(outside, path);
  assert.equal(readOverlapText(cache, blob), null);
  rmSync(path);
  writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
  assert.equal(readOverlapText(cache, blob), null);
  writeFileSync(path, bytes);
  assert.deepEqual(readOverlapText(cache, blob), overlapTextSketch(bytes));
  assert.equal(readOverlapText(cache, '../original'), null);
});

test('blocking notices stay visible and preserve acknowledgements across changed evidence', () => {
  const lane = (laneId, changes) => ({
    laneId,
    intentId: laneId,
    actor: 'synthetic',
    intent: 'precision',
    head: digest(laneId),
    baseHead: digest('base'),
    baseSequence: 0,
    open: true,
    complete: true,
    changes: JSON.stringify(changes),
  });
  const mine = lane('mine', [{ path: 'shared.ts', ...change(2) }]);
  const peers = Array.from({ length: 8 }, (_, i) =>
    lane(`peer-${i}`, [{ path: 'shared.ts', ...change(20 + i) }]),
  );
  peers.push(lane('blocker', [{ path: 'shared.ts', ...change(2), after: change(3).after }]));
  const current = { head: mine.baseHead, sourceRevision: 0 };
  const result = hostedOverlapAdvice(mine, peers, null, current, new Set());
  assert.equal(result.unacknowledgedOverlaps.blockingCount, 1);
  assert.equal(result.unacknowledgedOverlaps.advisoryCount, 0);
  assert.equal(result.unacknowledgedOverlaps.items[0].class, 'blocking');
  const oldId = hostedOverlapAdvice(mine, [peers[0]], null, current, new Set(), true, 5, 'shared.ts')
    .unacknowledgedOverlaps.items[0].noticeId;
  const updated = {
    ...peers[0],
    changes: JSON.stringify([{ path: 'shared.ts', ...change(2), after: change(3).after }]),
  };
  const pending = hostedOverlapAdvice(mine, [updated], null, current, new Set([oldId]));
  assert.equal(pending.unacknowledgedOverlaps.items[0].class, 'blocking');
  assert.notEqual(pending.unacknowledgedOverlaps.items[0].noticeId, oldId);
  const legacyId = digest(JSON.stringify(['first-write', ['mine', 'peer-0'], 'shared.ts']));
  assert.equal(pending.unacknowledgedOverlaps.items[0].noticeId, legacyId);
  const moved = { ...updated, changes: JSON.stringify([{ path: 'shared.ts', ...change(2, 4) }]) };
  assert.equal(
    hostedOverlapAdvice(mine, [moved], null, current, new Set([legacyId])).unacknowledgedOverlaps.count,
    0,
    'an existing blocking answer remains valid when blocking evidence changes',
  );
});

test('real hosted finish with an advisory same-file peer reaches landed without any acknowledgement', async t => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  const mine = base.replace('line 2\n', 'my edit\n');
  const peerText = base.replace('line 30\n', 'peer edit\n');
  const file = 'shared.txt';
  const s = await resolutionFixture(t, { baselineFiles: [[file, base]], selectedFiles: [[file, mine]] });
  const f = s.f,
    c = f.c;
  const other = await c.lane(c.state([c.baseFile, c.hidden, c.file(file, peerText)], [c.baseline.sha256]));
  const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
  for (const [entry, text] of [
    [f.lane, mine],
    [other, peerText],
  ]) {
    const raw = await f.readLane(entry.laneId);
    await f.tx(
      'precision-projection',
      {
        _handler: ctx =>
          tracking.trackHostedOverlapLane(ctx, f.projectId, raw, {
            baseSequence: 0,
            changes: [
              {
                path: file,
                before: { blob: digest(base), mode: 'file' },
                after: { blob: digest(text), mode: 'file' },
                evidence: overlapTextEvidence(
                  digest(base),
                  overlapTextSketch(Buffer.from(base)),
                  overlapTextSketch(Buffer.from(text)),
                  false,
                ),
              },
            ],
          }),
      },
      {},
    );
  }
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      agentDefaults: { ...project.autonomyPolicy.agentDefaults, overlapGate: 'block', preflight: 'off' },
    },
  });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const submitted = await s.transport().dispatch('finish', { laneId: f.lane.laneId, accept: true });
  assert.equal(submitted.unacknowledgedOverlaps.count, 0);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, file), mine);
  assert.equal(f.tables.projectHostedOverlapAcks.size, 0, 'landed without any answer');
});

test('equal local names in separate arrow functions do not create a false shared symbol', () => {
  const base = `const first = () => { const value = 1; return value; };\n${'\n'.repeat(12)}const second = () => { const value = 2; return value; };\n`;
  const evidence = text =>
    overlapTextEvidence(
      digest(base),
      overlapTextSketch(Buffer.from(base)),
      overlapTextSketch(Buffer.from(text)),
      true,
    );
  const a = evidence(base.replace('value = 1', 'value = 3'));
  const b = evidence(base.replace('value = 2', 'value = 4'));
  const wrap = evidence => ({
    before: { blob: digest(base), mode: 'file' },
    after: change(1).after,
    evidence,
  });
  assert.equal(classifyOverlap(wrap(a), wrap(b)).class, 'advisory');
});

test('separate bindings in one declaration do not turn disjoint edits into a shared symbol', () => {
  const base = `const a = {\n  value: 1\n},\n${'\n'.repeat(12)}b = {\n  value: 2\n};\n`;
  const changed = text => ({
    before: { blob: digest(base), mode: 'file' },
    after: { blob: digest(text), mode: 'file' },
    evidence: overlapTextEvidence(
      digest(base),
      overlapTextSketch(Buffer.from(base)),
      overlapTextSketch(Buffer.from(text)),
      true,
    ),
  });
  const a = changed(base.replace('value: 1', 'value: 3'));
  const b = changed(base.replace('value: 2', 'value: 4'));
  assert.deepEqual(a.evidence.symbols, ['a']);
  assert.deepEqual(b.evidence.symbols, ['b']);
  assert.equal(classifyOverlap(a, b).class, 'advisory');
});
