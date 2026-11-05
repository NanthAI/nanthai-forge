// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { failureFixture, identity } from './convex-source-failure-fixture.mjs';
import { sourceFailureSchema } from '../dist/hosted-source-retry.js';

for (const code of [
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
])
  test('worker receipt retains a safe typed dependency failure: ' + code, async t => {
    const f = await failureFixture(t, 'verify');
    const original = f.ctx.runMutation;
    f.ctx.runMutation = (ref, args) => {
      if (getFunctionName(ref).endsWith(':begin'))
        throw Object.assign(new Error('https://private.invalid/?secret=sentinel'), { code });
      return original(ref, args);
    };
    await assert.rejects(
      f.run(),
      e => e.name === 'SourceIoError' && e.code === code && !e.message.includes('sentinel'),
    );
    const failure = f.calls.find(c => c.name.endsWith(':failed')).args.cause;
    assert.equal(failure.code, code);
    assert.equal(failure.step, identity.step);
    assert.equal(failure.call, 'task-begin');
    assert(!JSON.stringify({ failure, logs: f.logs }).includes('sentinel'));
    assert.deepEqual(sourceFailureSchema.parse(failure), failure);
  });

test('worker canonical diagnostics retain the object and size across nested wrappers', async t => {
  const f = await failureFixture(t, 'calculate');
  f.fault('headers');
  await assert.rejects(f.run(), { name: 'SourceIoError' });
  const failure = f.calls.find(c => c.name.endsWith(':failed')).args.cause;
  assert.equal(failure.step, identity.step);
  assert.equal(failure.call, 'merge-read');
  assert.equal(failure.object, f.object.sha256);
  assert.equal(failure.size, f.object.size);
  assert.equal(failure.objects, f.input.refs.length);
  assert.equal(failure.stage, 'source-headers');
  assert.equal(failure.code, 'SOURCE_RUNTIME_ERROR');
  assert(!JSON.stringify(failure).includes('private'));
});
