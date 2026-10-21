// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonStream } from '../dist/json-stream.js';
async function* chunks(text, width) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width);
}
test('streamed JSON matches JSON.parse across UTF-8, escapes, tokens and object boundaries', async () => {
  const texts = [
    '{"__proto__":{"safe":true},"x":1,"x":2}',
    JSON.stringify({
      text: 'é😀\\"\n\t',
      array: [null, true, false, -1.25e20, {}, [], { nested: 'x'.repeat(70000) }],
    }),
    '  1.25e-2 \n',
    '"scalar"',
    '{}',
    '[]',
    'null',
  ];
  for (const text of texts)
    for (const width of [1, 3, 32768])
      assert.deepEqual(await parseJsonStream(chunks(text, width)), JSON.parse(text));
  assert.equal({}.safe, undefined);
});
test('streamed JSON rejects truncation, trailing tokens, invalid scalars and grammar', async () => {
  for (const text of [
    '',
    '[1,]',
    '{"x":1,}',
    '{x:1}',
    '{"x" 1}',
    '{"x":}',
    '[1 2]',
    'true false',
    '01',
    '1e',
    '"\\x"',
    '"x',
    '[{}',
    '{}[]',
    'null"x"',
    '{"x":1]:2}',
  ])
    for (const width of [1, 8]) await assert.rejects(parseJsonStream(chunks(text, width)), SyntaxError, text);
});
