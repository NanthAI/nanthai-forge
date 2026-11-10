// SPDX-License-Identifier: Apache-2.0
// Issue 1b66b35a: the Now page's overlap read stays under 20 KB per first view. The fixtures replay the dev
// shapes measured on 2026-11-07: 100 full answer records per page (60 KB) plus every saved path of every
// open Lane, each detection twice (84 KB at 16:12 UTC, 139 KB at 16:56 during a 10-builder wave), resent on
// every invalidation (99 per hour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const view = await import(moduleUrl('../src/now-overlap-view.ts'));
const { nowOverlapSignals } = await import(moduleUrl('../src/now-overlap-signals.ts'));
const { overlapRows, overlapFileCount } = await import(moduleUrl('../web/src/cockpit/overlap-model.ts'));

const hex = (seed, length = 64) => seed.toString(16).repeat(length).slice(0, length);
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const change = path => ({ path, before: null, after: { blob: hex(5), mode: 'file' } });

/**
 * Open Lanes as overlap rows, run through the real detector. `paths(i)` lists Lane i's saved paths;
 * main touched `behind` paths after every Lane's base.
 */
function signalsOf(count, paths, behind = []) {
  const lanes = Array.from({ length: count }, (_, i) => ({
    laneId: randomUUID(),
    intentId: randomUUID(),
    intent: 'Synthetic change',
    actor: 'agent',
    head: hex(i + 1),
    baseHead: 'base',
    baseSequence: 1,
    open: true,
    complete: true,
    changes: JSON.stringify(paths(i).map(change)),
  }));
  const main = { sequence: 2, coverageAfter: 0, changes: JSON.stringify(behind.map(path => [path, 2])) };
  return {
    lanes: lanes.map(lane => lane.laneId),
    signals: nowOverlapSignals(lanes, main, { head: 'main', sourceRevision: 2 }, true),
  };
}
/** Full stored answers, as `list` returned them: text, delivery id, disposition and record ids. */
const records = (lanes, count) =>
  Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.UTC(2026, 10, 7, 10, 0, i)).toISOString(),
    choice: 'accept-order',
    deliveryId: `hook:${hex(i + 3)}`,
    disposition: 'acknowledged',
    id: randomUUID(),
    laneId: lanes[i % lanes.length],
    noticeId: hex(i + 11).replace(/^./, (i % 16).toString(16)),
    operationId: randomUUID(),
    text: 'Agreed order: this Lane lands second and updates from main first; no shared lines.',
    type: 'overlap-answer',
    actor: i % 9 ? 'agent-subject' : 'viewer-subject',
  }));
const file = i => `src/area-${i % 9}/module-${i}-name.ts`;
/** 16:12 UTC: 14 open Lanes, one broad Lane (318 saved paths, 177 behind main) sharing one file. */
function broadLane(answers = 100) {
  const broad = Array.from({ length: 318 }, (_, i) => file(i));
  const { lanes, signals } = signalsOf(
    14,
    i => (i === 12 ? broad : i === 1 ? [broad[0], 'docs/agents/workflow.md', 'tests/one.test.mjs'] : []),
    broad.slice(1, 178),
  );
  return { lanes, signals, records: records(lanes, answers) };
}
/** 16:56 UTC: 18 open Lanes, 93 files shared by 2-4 Lanes, over 100 detections, 127 answers. */
function busyWave(answers = 127) {
  const shared = Array.from({ length: 93 }, (_, k) => file(1000 + k));
  const { lanes, signals } = signalsOf(18, i => [
    ...shared.filter((_, k) => k % 18 === i || (k + 5) % 18 === i || (k % 4 === 0 && (k + 11) % 18 === i)),
    ...Array.from({ length: 30 }, (_, j) => `lane-${i}/own-${j}.ts`),
  ]);
  return { lanes, signals, records: records(lanes, answers) };
}
const legacyReply = ({ records, signals }) =>
  JSON.stringify({ page: records.slice(0, 100), isDone: false, continueCursor: 'x', signals });
// Answers are gone (Issue 853fcde3): the Now read carries the bounded signals only.
const nowReply = ({ signals }) => JSON.stringify({ signals: view.viewSignals(signals) });

test('incident replay: both measured shapes fail the 20 KB budget on the old reply and pass on the Now read', t => {
  for (const [name, fixture] of [
    ['broad Lane', broadLane()],
    ['busy wave', busyWave()],
  ]) {
    const before = bytes(legacyReply(fixture)),
      after = bytes(nowReply(fixture));
    t.diagnostic(JSON.stringify({ name, before, after, budget: view.NOW_OVERLAP_VIEW_BUDGET }));
    // The guard is real: the replayed incident fails it.
    assert.ok(before > view.NOW_OVERLAP_VIEW_BUDGET, `${name} replays the incident (${before} bytes)`);
    assert.ok(after < view.NOW_OVERLAP_VIEW_BUDGET, `${name}: Now overlap read is ${after} bytes`);
  }
});

test('the client reads back every rendered overlap: same edit rows, main rows summarise their count', () => {
  for (const { lanes, signals } of [broadLane(), busyWave()]) {
    const read = view.readViewSignals(JSON.parse(JSON.stringify(view.viewSignals(signals))));
    assert.deepEqual(
      read.edits.map(edit => [edit.laneId, edit.head]),
      signals.edits.map(edit => [edit.laneId, edit.head]),
      'every Lane keeps its pin (id and head)',
    );
    assert.equal(read.complete, signals.complete);
    const lane = id => ({
      id,
      name: `Lane ${lanes.indexOf(id)}`,
      tone: 'running',
      open: true,
      byAgent: true,
    });
    const editRows = edits =>
      overlapRows(
        edits.map(edit => ({ lane: lane(edit.laneId), paths: edit.paths.map(path => ({ path })) })),
      );
    assert.deepEqual(editRows(read.edits), editRows(signals.edits));
    const mainRows = edits =>
      overlapRows(
        [],
        [],
        edits.map(edit => ({
          lane: lane(edit.laneId),
          paths: edit.paths,
          ...(edit.more ? { more: edit.more } : {}),
        })),
      );
    assert.equal(
      overlapFileCount(mainRows(read.behindMain)),
      overlapFileCount(mainRows(signals.behindMain)),
      'the panel and headline still count every file',
    );
  }
  const { lanes, signals } = broadLane();
  const rows = overlapRows(
    [],
    [],
    view.readViewSignals(view.viewSignals(signals)).behindMain.map(edit => ({
      lane: { id: edit.laneId, name: 'Broad' },
      paths: edit.paths,
      more: edit.more,
    })),
  );
  assert.equal(rows.length, view.BEHIND_MAIN_PATHS + 1, '20 file rows and one count row');
  const summary = rows.find(row => row.files);
  assert.equal(summary.files, 157);
  assert.equal(summary.action.laneId, lanes[12], 'the count row opens the Lane that lists them all');
  assert.equal(overlapFileCount(rows), 177);
});
