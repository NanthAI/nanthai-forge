// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyOverlap } from '../dist/hosted-overlap-evidence.js';
import { hostedOverlapAdvice, boundOverlapChanges, mergeOverlapChanges } from '../dist/hosted-overlap.js';
import { estimatePreflightMinutes, preflightPlan } from '../dist/agent-preflight.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const corpus = JSON.parse(readFileSync(new URL('fixtures/notice-corpus.json', import.meta.url)));
const lane = (id, change, extra = {}) => ({
  laneId: id,
  intentId: id,
  intent: 'synthetic',
  actor: 'fixture',
  head: id,
  baseHead: 'base',
  baseSequence: 0,
  open: true,
  complete: true,
  changes: JSON.stringify([{ path: 'test.ts', ...change }]),
  ...extra,
});
const advice = (mine, peers) =>
  hostedOverlapAdvice(mine, peers, null, { head: 'base', sourceRevision: 0 }, new Set())
    .unacknowledgedOverlaps;

test('B1.5d retains 66 notices and 22 missed pairs; unknown peer remains unrun', t => {
  assert.equal(corpus.cases.filter(c => c.kind === 'notice').length, 66);
  assert.equal(corpus.cases.filter(c => c.kind === 'missed').length, 22);
  const before = corpus.cases.filter(c => c.kind === 'notice');
  assert.equal(before.filter(c => c.class === 'blocking' && c.truth === true).length, 13);
  assert.equal(before.filter(c => c.class === 'blocking' && c.truth === false).length, 31);
  assert.equal(before.filter(c => c.class === 'blocking' && c.truth === null).length, 1);
  assert.equal(before.filter(c => c.class === 'advisory' && c.truth === false).length, 21);
  const pairs = new Map();
  for (const c of corpus.cases)
    if (c.truth === true)
      for (const peer of c.peers) {
        const key = JSON.stringify([c.cell, c.path, [c.task, peer].sort()]);
        pairs.set(key, (pairs.get(key) ?? false) || c.kind === 'notice');
      }
  assert.equal(pairs.size, 33);
  assert.equal([...pairs.values()].filter(Boolean).length, 11);
  let useful = 0,
    noise = 0,
    missed = 0,
    unrun = 0;
  for (const c of corpus.cases) {
    if (c.truth === null) {
      unrun++;
      continue;
    }
    const [mine, ...peers] = c.changes;
    const found = !c.own && peers.some(peer => classifyOverlap(mine, peer).class === 'blocking');
    if (found && c.truth === true) useful++;
    if (found && c.truth === false) noise++;
    if (!found && c.truth === true) missed++;
    assert.equal(
      advice(
        lane('mine', mine),
        peers.map((p, i) => lane('peer-' + i, p, c.own ? { laneId: 'mine' } : {})),
      ).advisoryCount,
      0,
    );
  }
  assert.equal(unrun, 1);
  assert.equal(missed, 0);
  assert(useful / (useful + noise) >= 0.8);
  t.diagnostic(
    JSON.stringify({
      useful,
      unrun,
      executed: corpus.cases.length - unrun,
      noise,
      missed,
      precision: useful / (useful + noise),
      recall: (pairs.size - missed) / pairs.size,
      baselinePrecisionKnown: 13 / 44,
      baselineRecall: 11 / 33,
      uniqueRealPairs: pairs.size,
    }),
  );
});

test('resolve origin and siblings are excluded by exact provenance, not merely same Intent', () => {
  const a = corpus.cases.find(c => c.kind === 'missed').changes[0];
  const b = corpus.cases.find(c => c.kind === 'missed').changes[1];
  const mine = lane('resolve', a, { intentId: 'intent', resolutionLeft: 'origin-head' });
  const peer = lane('origin', b, { intentId: 'intent', head: 'origin-head' });
  assert.equal(advice(mine, [peer]).count, 0);
  assert.equal(
    advice(mine, [lane('sibling', b, { intentId: 'intent', resolutionLeft: 'origin-head' })]).count,
    0,
  );
  assert.equal(advice(mine, [{ ...peer, intentId: 'different' }]).blockingCount, 1);
  assert.equal(advice(mine, [{ ...peer, head: 'new-work' }]).blockingCount, 1);
  assert.equal(advice(mine, [{ ...peer, open: false }]).count, 0);
});

test('large early-file evidence cannot push later test paths out of the projection', () => {
  const a = corpus.cases.find(c => c.kind === 'missed').changes[0];
  const evidence = {
    ...a.evidence,
    symbols: Array.from({ length: 256 }, (_, i) => String(i).padEnd(300, 'x')),
  };
  const changes = Array.from({ length: 100 }, (_, i) => ({
    ...a,
    path: i ? `tests/file-${i}.test.ts` : 'a.ts',
    evidence,
  }));
  const bounded = boundOverlapChanges(changes);
  const retained = JSON.parse(bounded.changes);
  assert.equal(retained.length, 100);
  for (const change of retained) {
    assert.deepEqual(change.evidence.ranges, evidence.ranges, 'all later paths retain useful range evidence');
    assert.deepEqual(change.evidence.symbols, [], 'unused ownership names do not displace ranges');
  }
  assert.equal(bounded.complete, false, 'omitted evidence remains incomplete');
  assert.equal(
    preflightPlan('.', { paths: changes.map(c => c.path), complete: bounded.complete }).status,
    'unavailable',
    'better path visibility never expands mandatory preflight coverage',
  );
  assert(Buffer.byteLength(bounded.changes) <= 128 * 1024);
  const first = mergeOverlapChanges([], changes.slice(0, 1));
  assert(first.complete);
  assert.equal(JSON.parse(first.changes)[0].evidence.symbols.length, 256);
  const second = mergeOverlapChanges(JSON.parse(first.changes), changes.slice(1, 2), first.complete);
  assert.equal(second.complete, false, 'successive saves preserve original budget availability');
  const third = mergeOverlapChanges(JSON.parse(second.changes), changes.slice(2, 3), second.complete);
  assert.equal(third.complete, false, 'compaction never re-enables a previously unavailable preflight');
  assert.equal(JSON.parse(third.changes).length, 3);
});

test('preflight estimates learn machine-local measured wall time and corrupt data falls back', t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-preflight-estimate-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'lane'),
    cache = root + '.forge-client';
  mkdirSync(join(cache, 'agent'), { recursive: true });
  const path = join(cache, 'agent/preflight-estimate.json');
  assert.equal(estimatePreflightMinutes(root, 39), 3);
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      laneId: 'fixture',
      head: 'head',
      tests: 39,
      selection: 'affected',
      exitCode: 0,
      passed: true,
      durationMs: 559483,
      at: new Date(0).toISOString(),
    }),
  );
  assert.equal(estimatePreflightMinutes(root, 39), 10);
  assert.equal(estimatePreflightMinutes(root, 78), 19);
  const sibling = join(cache, 'lanes', 'new-lane');
  mkdirSync(sibling, { recursive: true });
  assert.equal(estimatePreflightMinutes(sibling, 39), 10, 'new sibling Lanes reuse machine observations');
  writeFileSync(path, 'corrupt');
  assert.equal(estimatePreflightMinutes(root, 39), 3);
});

test('missing or differently based evidence stays advisory and incomplete, never silently clean', () => {
  const [a, b] = corpus.cases.find(c => c.kind === 'missed').changes;
  const mine = lane('mine', a);
  const peer = lane('peer', { ...b, evidence: undefined });
  const found = advice(mine, [peer]);
  assert.equal(found.advisoryCount, 1);
  assert.equal(found.items[0].reason, 'unavailable');
  assert.equal(found.coverage, 'hosted-incomplete');
});
