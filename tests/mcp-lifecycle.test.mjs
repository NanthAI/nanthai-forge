// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { mcpProcess, processes, eventually } from './mcp-lifecycle-fixture.mjs';

function owner(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-mcp-lifecycle-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const synthetic = 1;\n');
  initNative(root);
  return { root, directory: join(root, '.forge', 'work') };
}
async function watcher(directory, label = 'one watcher process') {
  return eventually(
    label,
    () => {
      try {
        const lease = JSON.parse(readFileSync(join(directory, 'local-watcher.json'), 'utf8'));
        const rows = processes(directory);
        return rows.length === 1 && rows[0].pid === lease.pid ? lease : null;
      } catch {
        return null;
      }
    },
    lease => lease !== null,
  );
}
const exit = async m => {
  const result = await Promise.race([
    m.exited,
    new Promise((_, reject) => {
      const guard = setTimeout(() => reject(new Error('MCP failed to exit on disconnect')), 5000);
      m.exited.finally(() => clearTimeout(guard));
    }),
  ]);
  assert.deepEqual(result, [0, null], m.stderr());
};

test(
  'ten concurrent MCP clients share one owner helper, survive one client crash, and all exit on EOF',
  { timeout: 20000 },
  async t => {
    const { root, directory } = owner(t);
    const clients = Array.from({ length: 10 }, () => mcpProcess(t, root));
    await Promise.all(clients.map(m => m.ready()));
    const lease = await watcher(directory);
    assert.equal(processes(directory)[0].pid, lease.pid);
    clients[0].child.kill('SIGKILL');
    await clients[0].exited;
    await clients[1].request('ping');
    assert.equal(processes(directory).length, 1);
    assert.equal(processes(directory)[0].pid, lease.pid);
    for (const client of clients.slice(1)) client.child.stdin.end();
    await Promise.all(clients.slice(1).map(exit));
    await eventually(
      'no watcher after last disconnect',
      () => processes(directory).length,
      count => count === 0,
    );
  },
);

test('an idle MCP exits on the shortened deadline and releases its helper', { timeout: 15000 }, async t => {
  const { root, directory } = owner(t);
  const m = mcpProcess(t, root, { idleMs: 500 });
  await m.ready();
  await exit(m);
  await eventually(
    'idle helper exit',
    () => processes(directory).length,
    count => count === 0,
  );
});

test(
  'a dead helper lease is safely taken over by concurrent new MCP clients',
  { timeout: 20000 },
  async t => {
    const { root, directory } = owner(t);
    const first = mcpProcess(t, root);
    await first.ready();
    const previous = await watcher(directory, 'first helper');
    process.kill(previous.pid, 'SIGKILL');
    first.child.stdin.end();
    await exit(first);
    await eventually(
      'dead helper exit',
      () => processes(directory).length,
      count => count === 0,
    );
    const next = Array.from({ length: 4 }, () => mcpProcess(t, root));
    await Promise.all(next.map(m => m.ready()));
    const current = await watcher(directory, 'one replacement');
    assert.notEqual(current.pid, previous.pid);
    for (const client of next) client.child.stdin.end();
    await Promise.all(next.map(exit));
    await eventually(
      'replacement exits',
      () => processes(directory).length,
      count => count === 0,
    );
  },
);

test(
  'a reused live PID with a different kernel start identity cannot keep a dead lease alive',
  { timeout: 15000 },
  async t => {
    const { root, directory } = owner(t);
    writeFileSync(
      join(directory, 'local-watcher.json'),
      JSON.stringify({
        pid: process.pid,
        startTime: 'synthetic obsolete process identity',
        socket: join(root, 'never-created-socket'),
      }),
    );
    const m = mcpProcess(t, root);
    await m.ready();
    const lease = await watcher(directory, 'PID-reuse takeover');
    assert.notEqual(lease.pid, process.pid);
    m.child.stdin.end();
    await exit(m);
    await eventually(
      'PID-reuse helper exits',
      () => processes(directory).length,
      count => count === 0,
    );
  },
);
