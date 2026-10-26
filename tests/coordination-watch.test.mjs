import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCoordinationFeed } from '../dist/coordination-watch.js';
const empty = { page: [], continueCursor: 'cursor-after-known-event', isDone: true };
function subscription(behavior) {
  let closed = 0,
    unsubscribed = 0;
  return {
    client: {
      onUpdate: (_ref, args, next, error) => {
        behavior(args, next, error);
        return () => {
          unsubscribed++;
        };
      },
      close: async () => {
        closed++;
      },
    },
    counts: () => ({ closed, unsubscribed }),
  };
}
test('watch returns existing or newly subscribed events and retains exact continuation cursor', async () => {
  const event = { operationId: 'event' },
    f = subscription((args, next) => {
      assert.equal(args.paginationOpts.cursor, 'original');
      next(empty);
      setTimeout(() => next({ page: [event], continueCursor: 'next', isDone: true }), 5);
    });
  const result = await watchCoordinationFeed(f.client, 'project', {
    cursor: 'original',
    pageSize: 50,
    waitMs: 1000,
  });
  assert.deepEqual(result, { page: [event], continueCursor: 'next', isDone: true, timedOut: false });
  assert.deepEqual(f.counts(), { closed: 1, unsubscribed: 1 });
});
test('watch timeout is successful only after an authorized empty observation', async () => {
  const f = subscription((_args, next) => next(empty));
  assert.deepEqual(
    await watchCoordinationFeed(f.client, 'project', { cursor: 'original', pageSize: 50, waitMs: 5 }),
    { ...empty, timedOut: true },
  );
  assert.deepEqual(f.counts(), { closed: 1, unsubscribed: 1 });
  const unavailable = subscription(() => {});
  await assert.rejects(
    watchCoordinationFeed(unavailable.client, 'project', { cursor: 'original', pageSize: 50, waitMs: 5 }),
    { code: 'COORDINATION_UNAVAILABLE' },
  );
  assert.deepEqual(unavailable.counts(), { closed: 1, unsubscribed: 1 });
});
test('authority loss and subscription failure close the socket and preserve caller cursor', async () => {
  const f = subscription((_args, next, error) => {
    next(empty);
    error(new Error('revoked'));
  });
  await assert.rejects(
    watchCoordinationFeed(f.client, 'project', { cursor: 'original', pageSize: 50, waitMs: 1000 }),
    { code: 'COORDINATION_UNAVAILABLE' },
  );
  assert.deepEqual(f.counts(), { closed: 1, unsubscribed: 1 });
});
