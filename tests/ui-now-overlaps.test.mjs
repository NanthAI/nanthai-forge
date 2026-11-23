// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import { overlapNowFixture } from './hosted-cockpit-fixture.mjs';
import { laneSummary } from '../dist/work-hosted-summary.js';
import { laneSchema, noteSchema } from '../dist/work-types.js';
import { nowOverlapSignals } from '../dist/now-overlap-signals.js';

globalThis.location = { href: 'https://forge.test' };

test('stored Lane and note rows with retired path-notice fields stay readable without republishing notices (3d001cb2)', () => {
  const f = overlapNowFixture('C');
  const notice = {
    noticeId: 'a'.repeat(64),
    file: 'old.ts',
    lanes: [f.records.lanes[0].id],
    at: new Date(f.now).toISOString(),
  };
  const lane = { ...f.records.lanes[0], target: '', overlapInbox: [notice] };
  const parsed = laneSchema.parse(lane);
  assert.equal(parsed.head, lane.head);
  assert.equal(parsed.overlapInbox, undefined);
  assert.equal(laneSummary(lane).overlaps, undefined);
  const note = noteSchema.parse({
    text: 'Retained decision',
    kind: 'decision',
    at: notice.at,
    overlapAnswer: {
      laneId: lane.id,
      noticeId: notice.noticeId,
      deliveryId: 'old',
      disposition: 'acknowledged',
    },
  });
  assert.equal(note.text, 'Retained decision');
  assert.equal(note.kind, 'decision');
  assert.equal(note.overlapAnswer, undefined);
});
test('project signals include behind-main files', () => {
  const entry = (laneId, paths) => ({
    laneId,
    head: 'b',
    baseHead: 'a',
    baseSequence: 1,
    open: true,
    complete: true,
    changes: JSON.stringify(paths.map(path => ({ path }))),
  });
  const signals = nowOverlapSignals(
    [entry('a', ['x', 'y']), entry('b', ['x'])],
    { sequence: 2, coverageAfter: 0, changes: JSON.stringify([['y', 2]]) },
    { head: 'c', sourceRevision: 2 },
    true,
  );
  assert.deepEqual(signals.behindMain[0].paths, ['y']);
  assert.equal(signals.complete, true);
});
