// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyPackedResultBatch, resultBatchTargetsSchema } from '../dist/hosted-actions-result-batch.js';

function inbox(count = 2) {
  const target = key => ({
    put: { url: `https://synthetic.invalid/${key}`, headers: { 'if-none-match': '*' } },
    get: `https://synthetic.invalid/${key}`,
    head: `https://synthetic.invalid/${key}`,
  });
  const targets = resultBatchTargetsSchema.parse({
    packed: true,
    slots: Array.from({ length: count }, (_, index) => target(index)),
    coordinator: { put: target('coordinator').put, get: target('coordinator').get },
  });
  const objects = new Map(targets.slots.map((_, index) => [String(index), 'required result']));
  const requests = [];
  let loseReply = false;
  const request = async (url, init = {}) => {
    const key = new URL(url).pathname.slice(1),
      method = init.method ?? 'GET';
    requests.push({ key, method });
    if (method === 'PUT') {
      assert.equal(init.headers['if-none-match'], '*');
      if (objects.has(key)) return new Response(null, { status: 412 });
      objects.set(key, init.body);
      if (loseReply) {
        loseReply = false;
        throw new TypeError('synthetic lost marker PUT reply');
      }
      return new Response(null, { status: 200 });
    }
    assert(['HEAD', 'GET'].includes(method));
    return new Response(method === 'HEAD' ? null : (objects.get(key) ?? null), {
      status: objects.has(key) ? 200 : 404,
    });
  };
  return {
    targets,
    objects,
    requests,
    request,
    loseReply: () => {
      loseReply = true;
    },
  };
}

test('packed election: two required shards that both see all slots send one completion notification', async () => {
  const f = inbox();
  let notifications = 0;
  await Promise.all(
    [0, 1].map(index =>
      notifyPackedResultBatch(f.targets, index, f.request, async () => {
        notifications++;
      }),
    ),
  );
  assert.equal(notifications, 1);
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 2);
  assert.equal(f.requests.filter(r => r.method === 'GET').length, 1, 'only a lost election reads the marker');
  assert.equal(f.requests.filter(r => r.method === 'HEAD').length, 2, 'each shard skips its own slot');
});

test('packed election: a lost marker PUT reply reconciles its owner and preserves a single notification', async () => {
  const f = inbox();
  let notifications = 0;
  const notify = async () => {
    notifications++;
  };
  f.loseReply();
  await assert.rejects(notifyPackedResultBatch(f.targets, 0, f.request, notify), TypeError);
  assert.equal(notifications, 0);
  await notifyPackedResultBatch(f.targets, 1, f.request, notify);
  assert.equal(notifications, 0, 'another shard cannot take a marker whose reply was lost');
  await notifyPackedResultBatch(f.targets, 0, f.request, notify);
  assert.equal(notifications, 1);
  assert.equal(f.objects.get('coordinator'), 'collect:0');
});

test('packed election: a missing required upload does not elect or poll, and optional jobs have no slots', async () => {
  const f = inbox();
  f.objects.delete('1');
  let notifications = 0;
  await notifyPackedResultBatch(f.targets, 0, f.request, async () => {
    notifications++;
  });
  assert.deepEqual(f.requests, [{ key: '1', method: 'HEAD' }]);
  assert.equal(f.objects.has('coordinator'), false);
  assert.equal(notifications, 0);
});

test('packed election: required-slot access or storage failures never authorize completion', async () => {
  for (const status of [403, 500]) {
    const f = inbox();
    let notifications = 0;
    await assert.rejects(
      notifyPackedResultBatch(
        f.targets,
        0,
        async () => new Response(null, { status }),
        async () => {
          notifications++;
        },
      ),
      error => error.code === 'R2_VERIFY_FAILED',
    );
    assert.equal(notifications, 0);
  }
});
