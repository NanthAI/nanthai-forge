// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { McpStdioTransport, MCP_IDLE_MS } from '../dist/mcp-stdio.js';

async function transport(t, output = new PassThrough(), idleMs = 50) {
  const input = new PassThrough();
  const stdio = new McpStdioTransport(input, output, idleMs);
  let closed = 0;
  stdio.onclose = () => closed++;
  stdio.onmessage = () => {};
  await stdio.start();
  t.after(() => stdio.close());
  return { input, output, stdio, closed: () => closed };
}
for (const event of ['end', 'close'])
  test(`stdio ${event} closes once and detaches its listeners`, async t => {
    const m = await transport(t);
    m.input.emit(event);
    await m.stdio.close();
    assert.equal(m.closed(), 1);
    assert.equal(m.input.listenerCount('data'), 0);
    assert.equal(m.input.listenerCount('end'), 0);
    assert.equal(m.output.listenerCount('error'), 0);
  });

test('EPIPE closes the transport and rejects the write without an uncaught stream error', async t => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error('synthetic closed client'), { code: 'EPIPE' }));
    },
  });
  const m = await transport(t, output);
  await assert.rejects(m.stdio.send({ jsonrpc: '2.0', id: 1, result: {} }), { code: 'EPIPE' });
  assert.equal(m.closed(), 1);
});

test('one idle deadline defaults to fifteen minutes and stays stopped until every response finishes', async t => {
  assert.equal(MCP_IDLE_MS, 7_200_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = await transport(t);
  for (const id of [1, 2]) m.input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
  t.mock.timers.tick(5000);
  assert.equal(m.closed(), 0);
  await m.stdio.send({ jsonrpc: '2.0', id: 1, result: {} });
  t.mock.timers.tick(5000);
  assert.equal(m.closed(), 0);
  await m.stdio.send({ jsonrpc: '2.0', id: 2, result: {} });
  t.mock.timers.tick(49);
  assert.equal(m.closed(), 0);
  t.mock.timers.tick(1);
  assert.equal(m.closed(), 1);
});
