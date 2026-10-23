// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { presign as nodePresign } from './presign-node-reference.mjs';
const { presign } = await import(moduleUrl('../convex/presign.ts'));

test('V8 presigner matches the AWS SigV4 query-string reference vector', async () => {
  const url = await presign({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    expires: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('V8 presigner equals the Node reference for R2-shaped requests', async () => {
  const base = {
    host: 'forge.0123456789abcdef.r2.cloudflarestorage.com',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret/with+chars',
    now: new Date('2026-10-19T12:34:56.789Z'),
  };
  const cases = [
    { method: 'GET', path: '/v1/p/abc/o/' + 'a'.repeat(64) },
    {
      method: 'PUT',
      path: "/v1/p/abc/o/with space&(odd)*!'chars",
      expires: 900,
      headers: { 'Content-Length': '1234', 'If-None-Match': '*' },
    },
    { method: 'HEAD', path: '/x', query: { 'response-content-type': 'text/plain', b: '2', a: '1' } },
  ];
  for (const c of cases) {
    const input = { ...base, ...c };
    assert.equal(await presign(input), nodePresign(input));
  }
});

test('the signature binds the method, key and signed headers', async () => {
  const input = {
    method: 'PUT',
    host: 'h.example',
    path: '/a',
    accessKeyId: 'k',
    secretAccessKey: 's',
    now: new Date('2026-01-01T00:00:00Z'),
    headers: { 'if-none-match': '*' },
  };
  const sig = u => new URL(u).searchParams.get('X-Amz-Signature');
  const one = sig(await presign(input));
  assert.notEqual(one, sig(await presign({ ...input, method: 'GET' })));
  assert.notEqual(one, sig(await presign({ ...input, path: '/b' })));
  assert.notEqual(one, sig(await presign({ ...input, headers: {} })));
  assert.equal(new URL(await presign(input)).searchParams.get('X-Amz-SignedHeaders'), 'host;if-none-match');
});
