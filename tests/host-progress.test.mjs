// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostProgress, formatHostProgress } from '../dist/host-progress.js';
test('hosting progress reports phase totals, throughput, ETA and heartbeat without source data', async () => {
  const events = [],
    progress = hostProgress(event => events.push(event));
  progress.phase('history backfilling', 4, 400);
  await new Promise(resolve => setTimeout(resolve, 5));
  progress.advance(2, 200);
  progress.emit();
  const event = events.at(-1);
  assert.equal(event.type, 'host-progress');
  assert.equal(event.objectsDone, 2);
  assert.equal(event.objectsTotal, 4);
  assert.equal(event.bytesTotal, 400);
  assert(event.bytesPerSecond > 0);
  assert(event.etaSeconds > 0);
  assert.match(formatHostProgress(event), /history backfilling: 2\/4 objects.*MB\/s, ETA \d+s/);
  progress.advance(2, 200);
  assert.equal(events.at(-1).etaSeconds, 0);
  progress.phase('complete');
  assert.equal(events.at(-1).bytesDone, 0);
  assert.equal(events.at(-1).etaSeconds, null);
});
