// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadCheckReports } from '../dist/check-report-upload.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { checkPin } from '../dist/hosted-check.js';
const target = {
  put: { url: 'https://storage.example/immutable', headers: { 'if-none-match': '*' } },
  get: 'https://storage.example/original',
};
const reports = { 'tests/a.test.mjs': { failed: true, firstError: 'exact failure' } };

test('fenced report upload hashes exactly the bytes sent and adds one PUT on the healthy path', async () => {
  const calls = [];
  const pin = await uploadCheckReports(target, reports, async (url, init) => {
    calls.push(url);
    assert.equal(init.method, 'PUT');
    assert.deepEqual(init.headers, target.put.headers);
    assert.equal(new TextDecoder().decode(init.body), canonicalPayload(reports));
    return new Response(null, { status: 200 });
  });
  assert.equal(pin, checkPin(reports));
  assert.deepEqual(calls, [target.put.url]);
});

test('an unknown immutable PUT outcome reconciles identical bytes and rejects changed retry bytes', async () => {
  for (const same of [true, false]) {
    let calls = 0;
    const request = async url => {
      calls++;
      return url === target.put.url
        ? new Response(null, { status: 412 })
        : new Response(canonicalPayload(same ? reports : {}));
    };
    if (same) assert.equal(await uploadCheckReports(target, reports, request), checkPin(reports));
    else
      await assert.rejects(
        uploadCheckReports(target, reports, request),
        error => error.code === 'EVIDENCE_CHANGED',
      );
    assert.equal(calls, 2);
  }
  await assert.rejects(
    uploadCheckReports(target, reports, async () => new Response(null, { status: 503 })),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
});

test('a lost report PUT reply retries the same fenced bytes before reconciling the existing object', async () => {
  let puts = 0;
  const pin = await uploadCheckReports(target, reports, async (url, init) => {
    if (init?.method === 'PUT') {
      puts++;
      assert.equal(url, target.put.url);
      assert.equal(new TextDecoder().decode(init.body), canonicalPayload(reports));
      if (puts === 1) throw new TypeError('synthetic lost reply');
      return new Response(null, { status: 412 });
    }
    return new Response(canonicalPayload(reports));
  });
  assert.equal(pin, checkPin(reports));
  assert.equal(puts, 2);
});
