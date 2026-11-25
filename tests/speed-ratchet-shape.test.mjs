// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 4e8d6bbf: the ratchet math moved out of landing-speed-alerts into speed-ratchet. The stored
// entry shape and every threshold, recovery decision and status must stay byte-identical to what the
// code before the move produced (fixture recorded from that code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ratchetStatus, stepRatchet } from '../dist/landing-speed-alerts.js';

const day = 86_400_000,
  t0 = Date.parse('2026-11-01T09:00:00.000Z');
const hold = (n, v) => Array.from({ length: n }, (_, i) => [i, 3, v + (i % 3)]);
// [file max, pinned, closed-day budget, [day offset, hour, window value]...]
const scenarios = {
  holdThenRatchet: [100, false, false, [...hold(9, 40), [9, 1, 41]]],
  undoWithinMax: [100, false, false, [...hold(9, 40), [9, 1, 41], [10, 1, 90], [11, 1, 30]]],
  undoOverMax: [100, false, false, [...hold(9, 40), [9, 1, 41], [10, 1, 140]]],
  breakResetsHold: [
    100,
    false,
    false,
    [...hold(4, 40), [4, 2, 120], ...hold(3, 40).map(([d, h, v]) => [d + 5, h, v])],
  ],
  pinned: [100, true, false, hold(10, 40)],
  closedDayBudget: [50, false, true, hold(10, 20)],
  sameDayMax: [
    100,
    false,
    false,
    [
      [0, 1, 10],
      [0, 5, 30],
      [0, 9, 20],
      [1, 1, 5],
    ],
  ],
};

test('stored ratchet entries, lines, undo and ratchet decisions match the recorded pre-move trace byte for byte', () => {
  const recorded = readFileSync(new URL('./fixtures/speed-ratchet-trace.json', import.meta.url), 'utf8');
  const result = {};
  for (const [name, [max, pinned, closed, steps]] of Object.entries(scenarios)) {
    let entry;
    const trace = [];
    for (const [d, h, v] of steps) {
      const at = t0 + d * day + h * 3_600_000;
      const step = stepRatchet(
        entry,
        v,
        max,
        at,
        `landing-${trace.length}`,
        pinned,
        trace.length % 5,
        closed,
      );
      entry = step.entry;
      trace.push({ step, status: ratchetStatus(entry, max, pinned) });
    }
    const changed = stepRatchet(entry, 10, max + 10, t0 + 30 * day, 'changed-max', pinned, 0, closed);
    result[name] = { trace, changed, statusChangedMax: ratchetStatus(entry, max + 10, pinned) };
  }
  assert.equal(JSON.stringify(result, null, 1) + '\n', recorded);
  const steps = Object.values(result).flatMap(r => r.trace.map(t => t.step));
  assert(steps.some(s => s.ratcheted) && steps.some(s => s.undone), 'the fixture reaches both decisions');
});
