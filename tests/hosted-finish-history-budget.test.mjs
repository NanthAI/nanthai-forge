// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { semanticPayload } from '../dist/semantic-payload.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const { recordLandingObservation } = await import(moduleUrl('../convex/projectHostedLandingEvents.ts'));

test('twenty retained events read only public pending state at current and 10x history', async t => {
  const costs = [];
  for (const history of [1000, 10000]) {
    for (const privatePaths of [0, 500]) {
      const f = await landingFixture();
      const state = await f.enqueue();
      const pending = {
        id: randomUUID(),
        parentAttemptId: state.attemptId,
        number: 1,
        at: state.at,
        main: state.request.expectedMain,
        operations: { compose: randomUUID(), check: randomUUID(), accept: randomUUID() },
        precompose: {
          peerLanes: [],
          paths: Array.from({ length: privatePaths }, (_, n) => `synthetic-path-${n}`),
          runnable: false,
        },
      };
      await f.call(
        'historyFinish',
        {
          _handler: ctx =>
            ctx.db.insert('projectHostedFinishes', {
              projectId: f.projectId,
              submissionId: state.id,
              composeOperationId: null,
              parentSubmissionId: null,
              waiting: false,
              wake: null,
              value: JSON.stringify({ pending }),
            }),
        },
        {},
      );
      for (let version = 1; version <= 20; version++)
        await f.call(
          'historyEvent',
          {
            _handler: ctx => recordLandingObservation(ctx, { ...state, version }, pending),
          },
          {},
        );
      const request = [...f.tables.projectHostedLandingRequests.values()].find(
        r => r.submissionId === state.id,
      );
      f.patch('projectHostedLandingRequests', request._id, {
        value: JSON.stringify({ ...state, version: 20 }),
      });
      for (let n = 0; n < history; n++)
        f.insert('projectHostedLandingObservations', {
          projectId: f.projectId,
          submissionId: randomUUID(),
          version: 0,
          value: '{}',
        });
      const retained = [...f.tables.projectHostedLandingObservations.values()].filter(
        r => r.submissionId === state.id && r.version > 0,
      );
      assert.equal(retained.length, 20);
      assert(retained.every(r => !('precompose' in JSON.parse(r.value).pendingAttempt)));
      const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === state.id);
      assert.equal(
        JSON.parse(finish.value).pending.precompose.paths.length,
        privatePaths,
        'canonical controller metadata is preserved',
      );
      const calls = f.counts.length,
        scheduled = f.metrics.scheduled;
      const response = JSON.parse(
        await f.call('observerBudgetPage', observe.page, {
          projectId: f.projectId,
          operationId: state.operationId,
          nextVersion: 1,
        }),
      );
      const meter = f.counts.at(-1);
      assert.equal(f.counts.length - calls, 1, 'one page call with no nested functions');
      assert.equal(meter.writes, 0);
      assert.equal(f.metrics.scheduled, scheduled);
      assert.equal(response.events.length, 20);
      assert.deepEqual(
        response.events.map(e => e.submission.version),
        Array.from({ length: 20 }, (_, n) => n + 1),
      );
      assert(response.events.every(e => !('precompose' in e.pendingAttempt)));
      assert(meter.documents <= 28, 'one bounded twenty-version page');
      assert(meter.readBytes <= 50000, 'no private controller payloads in history reads');
      // The old retained format remains readable. Compare identical events in
      // the same fixture, with only its formerly retained private field added.
      for (const row of retained)
        f.tables.projectHostedLandingObservations.set(row._id, {
          ...row,
          value: semanticPayload({ ...JSON.parse(row.value), pendingAttempt: pending }),
        });
      const legacy = JSON.parse(
        await f.call('observerBudgetPage', observe.page, {
          projectId: f.projectId,
          operationId: state.operationId,
          nextVersion: 1,
        }),
      );
      const baseline = f.counts.at(-1);
      assert.deepEqual(legacy, response, 'all legacy progress and pending notices are preserved');
      if (privatePaths) assert(meter.readBytes <= baseline.readBytes / 2);
      costs.push({
        history,
        privatePaths,
        calls: 1,
        documents: meter.documents,
        sourceBytes: baseline.readBytes,
        readBytes: meter.readBytes,
      });
    }
  }
  assert(costs.every(c => c.documents === costs[0].documents));
  assert(costs.every(c => c.readBytes === costs[0].readBytes));
  t.diagnostic(JSON.stringify(costs));
});
