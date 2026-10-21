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

test('selective async decoding preserves paths and scalar syntax while releasing consumed records', async () => {
  const text = '{"meta":3,"work":{"items":[{"text":"🙂漢字","nested":[true,null]},7],"empty":[]}}';
  const selected = [];
  for (const width of [1, 7, 65536]) {
    selected.length = 0;
    const result = await parseJsonStream(chunks(text, width), {
      select: path => path[0] === 'work' && path[1] === 'items' && path.length === 3,
      value: async (value, path) => {
        await Promise.resolve();
        selected.push([path, value]);
        return null;
      },
    });
    assert.deepEqual(result, { meta: 3, work: { items: [null, null], empty: [] } });
    assert.deepEqual(selected, [
      [['work', 'items', 0], { text: '🙂漢字', nested: [true, null] }],
      [['work', 'items', 1], 7],
    ]);
  }
});

test('selective decoding stops reading when its durable consumer fails', async () => {
  let consumed = 0;
  async function* source() {
    for (const value of ['[{"id":1},', '{"id":2}]']) {
      consumed++;
      yield Buffer.from(value);
    }
  }
  await assert.rejects(
    parseJsonStream(source(), {
      select: path => path.length === 1,
      value: async () => {
        throw new Error('durable write failed');
      },
    }),
    /durable write failed/,
  );
  assert.equal(consumed, 1);
});
