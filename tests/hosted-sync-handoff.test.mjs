// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';

for (const overlap of [false, true])
  test(`an interrupted sync hands off its exact ${overlap ? 'conflict draft' : 'merged pins'} to the next land`, async t => {
    const s = await resolutionFixture(t, { overlap }),
      f = s.f;
    await s.transport().dispatch('open', { laneId: f.lane.laneId });
    f.moveMain({ overlap });
    s.eagerSource(false);
    const controller = new AbortController();
    controller.abort();
    const pending = await s.transport().dispatch('sync', { laneId: f.lane.laneId }, controller.signal);
    assert.equal(pending.result.status, 'submitted');
    s.eagerSource(true);
    await s.exchange.client.mutation(makeFunctionReference('projectHostedSyncJobs:submit'), {
      projectId: f.projectId,
      operationId: pending.operationId,
    });
    const before = s.calls.length;
    const next = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
    assert.equal(s.calls.slice(before).filter(c => c.name === 'projectHostedSync:progress').length, 1);
    if (overlap) {
      assert.equal(next.result.phase, 'conflict');
      const { action, ...command } = next.result.recovery.next;
      const recovered = await s.transport().dispatch(action, command);
      assert.equal(recovered.operationId, pending.operationId);
      assert(recovered.result.conflict.root);
      assert.notEqual(recovered.result.conflict.laneId, f.lane.laneId);
    } else {
      assert.equal(readHostedLaneCheckout(s.root).selection.head, (await f.readLane(f.lane.laneId)).head);
      await f.drain();
      await f.passChecks();
      await f.drain();
      assert.equal((await f.current(next.result.submission.id)).submission.phase, 'landed');
    }
  });
