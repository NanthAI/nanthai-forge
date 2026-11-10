// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { overlapRegions } from '../dist/agent-overlap-alerts.js';

test('separate overlapping regions and symbols keep independent notice identities', () => {
  const item = {
    lane: 'b',
    head: 'head',
    file: 'file',
    risk: 'high',
    reason: 'regions',
    mine: [
      { start: 10, lines: 2 },
      { start: 90, lines: 2 },
    ],
    peer: [
      { start: 12, lines: 1 },
      { start: 92, lines: 1 },
    ],
    first: 'a',
    orderReason: 'smaller',
  };
  const regions = overlapRegions(item);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0].mine, [item.mine[0]]);
  assert.deepEqual(regions[1].peer, [item.peer[1]]);
  assert.deepEqual(
    overlapRegions({ ...item, symbols: ['One', 'Two'] }).map(region => region.symbols),
    [['One'], ['Two']],
  );
});
