// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { conflictTrio, drainReady } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
for (const earlyResolve of [undefined, 'automatic', 'on', 'off'])
  test(`8c9b84fc D6: ${earlyResolve ?? 'absent'} policy ignores retired samples and only off waits`, async t => {
    const samples = [false, false, false, true].map(passed => [randomUUID(), passed, 75000, 225000]);
    const { f, advice } = await conflictTrio(t, { earlyResolve, samples });
    assert.equal(advice.resolution.early, earlyResolve !== 'off');
    assert(
      !/failure rate|wait saved|break-even/i.test(advice.next),
      'advice contains an exact action, not retired sampling clauses',
    );
    const before = [...f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples;
    for (let n = 0; n < 12; n++) {
      const run = f.runs().find(r => r.status === 'queued' && !r.cancelRequested);
      if (!run) break;
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await drainReady(f);
    }
    assert.equal(
      [...f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples,
      before,
      'predecessor outcomes never write the retired sample window',
    );
  });
