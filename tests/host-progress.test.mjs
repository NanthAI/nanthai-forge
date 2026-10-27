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

test('index progress uses committed records, phase/field, steps, rate and a resume-relative ETA', async () => {
  const events = [],
    progress = hostProgress(event => events.push(event));
  progress.phase('building Work index');
  const update = (done, step, buildPhase = 'summaries', field = 'views') =>
    progress.index(
      JSON.stringify({
        phase: 'index',
        buildPhase,
        field,
        done,
        total: 2167,
        step,
        privateText: 'never report arbitrary server data',
      }),
    );
  update(1000, 500);
  assert.equal(events.at(-1).etaSeconds, null, 'retained progress is not timed as fresh work');
  await new Promise(resolve => setTimeout(resolve, 5));
  update(1010, 501);
  const event = events.at(-1);
  assert.equal(event.objectsDone, 1010);
  assert.equal(event.objectsTotal, 2167);
  assert(event.indexBuild.stepsPerSecond > 0);
  assert(event.etaSeconds > 0);
  assert.match(
    formatHostProgress(event),
    /summaries\/views, 1010\/2167 records, 501 steps, .* steps\/s, ETA \d+s/,
  );
  assert(!JSON.stringify(event).includes('privateText'));
  update(0, 502, 'summaries', 'runs');
  assert.equal(events.at(-1).etaSeconds, null, 'a field change resets its rate');
  const count = events.length;
  progress.index('not JSON');
  progress.index(JSON.stringify({ phase: 'index', step: 1 }));
  progress.index(
    JSON.stringify({
      phase: 'index',
      buildPhase: 'summaries',
      field: 'secret path',
      done: 1,
      total: 2,
      step: 2,
    }),
  );
  assert.equal(events.length, count);
  progress.phase('complete');
  assert.equal(events.at(-1).indexBuild, undefined);
});
