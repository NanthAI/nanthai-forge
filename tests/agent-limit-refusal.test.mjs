// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { cliTeachContext } from '../dist/error-teaching.js';
import { describeFailure } from '../dist/system-errors.js';
import { limitRefusal } from '../dist/exchange-retry.js';
import { ForgeError } from '../dist/errors.js';

/** Issue 93907d28: hitting a limit returns its reset time and the exact retry command, never a bare error. */
test('a RATE_LIMITED refusal reaches the agent with its reset time and the exact retry command', async t => {
  const s = agentFixture(t);
  const retryAt = Date.now() + 90_000;
  const inner = s.exchange.client.mutation;
  s.exchange.client.mutation = (ref, args) =>
    getFunctionName(ref) === 'projectBoard:post'
      ? Promise.reject(
          new ConvexError({
            code: 'RATE_LIMITED',
            message: '10 notes per 10 minutes per Lane. Retry after 90 s.',
            retryAt,
          }),
        )
      : inner(ref, args);
  const command = { to: 'project', text: 'Heads up', laneId: s.lane.laneId };
  const error = await s
    .transport()
    .dispatch('board-post', command)
    .then(
      () => assert.fail('the post is refused'),
      error => error,
    );
  const argv = ['agent', s.root, 'board-post', JSON.stringify(command)];
  const failure = describeFailure(error, cliTeachContext(argv));
  const iso = new Date(retryAt).toISOString();
  assert.equal(failure.code, 'RATE_LIMITED');
  assert.deepEqual(failure.recovery, { outcome: 'refused', retryable: true, retryAt: iso });
  assert.match(failure.message, new RegExp(`Nothing was changed\\. Retry the same command after ${iso}`));
  assert.equal(failure.next, `nforge agent ${s.root} board-post '${JSON.stringify(command)}'`);
  assert.equal(failure.learn, `nforge agent ${s.root} help limits`);
});

test('only a limit with a reset gets retry wording; a storage quota has no time-based reset', () => {
  const once = limitRefusal(new ForgeError('RATE_LIMITED', 'limit', Date.now() + 1_000));
  assert.equal(limitRefusal(once), null, 'an already-converted refusal is not wrapped twice');
  assert.equal(limitRefusal(new ForgeError('QUOTA_EXCEEDED', 'full')), null);
  assert.equal(limitRefusal(new ForgeError('RATE_LIMITED', 'no reset named')), null);
  assert.equal(limitRefusal(new ForgeError('WORK_BUSY', 'busy', Date.now() + 1)), null);
});
