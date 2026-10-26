// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, processes } from './mcp-lifecycle-fixture.mjs';

function watching(t, path, args = []) {
  const child = fork(
    fileURLToPath(new URL('./local-watcher-client-fixture.mjs', import.meta.url)),
    [path, ...args],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    },
  );
  const messages = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('message', value => messages.push(value));
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, messages, exited, stderr: () => stderr };
}

test(
  'processes share native events and probes; closing one subscription preserves other clients',
  { timeout: 15000 },
  async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-shared-watch-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, '.forge', 'work');
    mkdirSync(directory, { recursive: true });
    const clients = Array.from({ length: 5 }, () => watching(t, root));
    await eventually(
      'all shared probes healthy',
      () => clients.map(client => client.messages.find(m => m.health)?.health),
      values => values.every(value => value?.status === 'healthy'),
    );
    for (const client of clients) {
      const ready = client.messages.find(message => message.health);
      assert.deepEqual(ready.scopes, [directory], 'missing paths use the same owner transport');
      assert.deepEqual(ready.missingHealth, { status: 'degraded', code: 'ENOENT' });
    }
    const lease = JSON.parse(readFileSync(join(directory, 'local-watcher.json'), 'utf8'));
    assert.deepEqual(
      processes(directory).map(row => row.pid),
      [lease.pid],
    );
    // Reopening before native close acknowledges must retain the new route.
    const rawPath = join(root, 'raw');
    mkdirSync(rawPath);
    const socket = createConnection(lease.socket),
      messages = [];
    t.after(() => socket.destroy());
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        messages.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    await once(socket, 'connect');
    const open = { id: 1, type: 'open', path: rawPath, recursive: false };
    socket.write(JSON.stringify(open) + '\n');
    await eventually(
      'raw target opened',
      () => messages.filter(m => m.type === 'opened').length,
      count => count === 1,
    );
    socket.write(JSON.stringify({ id: 1, type: 'close' }) + '\n' + JSON.stringify(open) + '\n');
    await eventually(
      'old close and new open acknowledged',
      () => messages.some(m => m.type === 'closed') && messages.filter(m => m.type === 'opened').length === 2,
      Boolean,
    );
    writeFileSync(join(rawPath, 'reopened.ts'), 'export const reopened = true;\n');
    await eventually(
      'reopened route still receives events',
      () => messages.some(m => m.type === 'event' && m.name === 'reopened.ts'),
      Boolean,
    );
    socket.write(JSON.stringify({ id: 1, type: 'release' }) + '\n');
    socket.destroy();
    clients[0].child.send('close');
    assert.deepEqual(await clients[0].exited, [0, null], clients[0].stderr());
    writeFileSync(join(root, 'shared.ts'), 'export const value = 2;\n');
    await eventually(
      'fanout after one client closes',
      () => clients.slice(1).map(client => client.messages.some(m => m.name === 'shared.ts')),
      values => values.every(Boolean),
    );
    assert.deepEqual(
      processes(directory).map(row => row.pid),
      [lease.pid],
    );
    for (const client of clients.slice(1)) client.child.send('close');
    for (const client of clients.slice(1)) assert.deepEqual(await client.exited, [0, null], client.stderr());
    await eventually(
      'shared helper exits',
      () => processes(directory).length,
      count => count === 0,
    );
  },
);

test('a shared helper never recreates an owner deleted before startup', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-deleted-watch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.forge', 'work');
  mkdirSync(directory, { recursive: true });
  rmSync(root, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../dist/local-watcher-worker.js', import.meta.url)), directory],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.equal(existsSync(root), false);
});

test(
  'a starter closing before its handshake reply cannot kill a helper already serving a peer',
  { timeout: 15000 },
  async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-watch-handshake-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, '.forge', 'work');
    mkdirSync(directory, { recursive: true });
    const prefix = join(root, '.forge', 'handshake');
    const starter = watching(t, root, ['--hold-handshake', prefix]);
    await eventually(
      'starter forked helper',
      () => existsSync(prefix + '.ready') && existsSync(join(directory, 'local-watcher.json')),
      Boolean,
    );
    const peer = watching(t, root);
    await eventually(
      'peer attached before starter handles IPC',
      () => peer.messages.find(m => m.health)?.health.status,
      status => status === 'healthy',
    );
    const lease = JSON.parse(readFileSync(join(directory, 'local-watcher.json'), 'utf8'));
    writeFileSync(prefix + '.release', '');
    assert.deepEqual(await starter.exited, [0, null]);
    writeFileSync(join(root, 'after-starter.ts'), 'export const peerSurvives = true;\n');
    await eventually(
      'peer events survive starter close',
      () => peer.messages.some(m => m.name === 'after-starter.ts'),
      Boolean,
    );
    assert.deepEqual(
      processes(directory).map(row => row.pid),
      [lease.pid],
    );
    peer.child.send('close');
    assert.deepEqual(await peer.exited, [0, null]);
    await eventually(
      'last peer releases helper',
      () => processes(directory).length,
      count => count === 0,
    );
  },
);
