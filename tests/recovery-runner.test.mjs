// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryRunnerDrill } from './recovery-runner-drill.mjs';

test('clean-machine Route B drill runs a hosted check and cannot accept locally', async t => {
  const result = await recoveryRunnerDrill(t);
  assert.equal(result.role, 'runner-cache');
  assert.equal(result.check, 'passed');
  assert.equal(result.checkForHostedLanding, true);
  assert.equal(result.localAcceptance, false);
  assert.equal(result.metric53.fixtureDroppedLandings, 0);
  assert(result.pendingLandingsPreserved > 0);
  assert(result.completionReceiptsPreserved > 0);
  t.diagnostic(JSON.stringify(result));
});
