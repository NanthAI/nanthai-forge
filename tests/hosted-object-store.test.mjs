// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { HostedObjectStore } from '../dist/hosted-object-store.js';
import { digest } from '../dist/hash.js';

test('object store verifies downloaded bytes, batches cold gets, and puts by current content identity', async t => {
  const f = agentFixture(t),
    a = Buffer.from('a'),
    b = Buffer.from('b');
  mkdirSync(f.root);
  f.objects.set(digest(a), a);
  f.objects.set(digest(b), b);
  const objects = new HostedObjectStore(join(f.root, 'test-objects'), f.exchange);
  assert.deepEqual(await Promise.all([objects.get(digest(a)), objects.get(digest(b))]), [a, b]);
  assert.equal(await objects.put(Buffer.from('put')), digest('put'));
  assert.deepEqual(f.objects.get(digest('put')), Buffer.from('put'));
  f.exchange.downloadBatch = async pins => pins.map(() => Buffer.from('corrupt'));
  await assert.rejects(objects.get(f.main.head), e => e.code === 'INVALID_NATIVE_SOURCE');
});
