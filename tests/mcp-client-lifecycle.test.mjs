// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { processAlive, processIdentity } from '../dist/local-process.js';
import { eventually } from './mcp-lifecycle-fixture.mjs';
import { mcpTestEnvironment } from './mcp-runtime.mjs';

const serverFixture = `
  import { startMcp } from './dist/mcp.js';
  import { detectedClientProcess } from './dist/agent-client-process.js';
  import { watchLocal } from './dist/local-watcher.js';
  import { writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  await startMcp(process.argv[1]);
  const watcher = watchLocal(process.argv[1], {}, () => {});
  if ((await watcher.probe()).status !== 'healthy') process.exit(1);
  watcher.unref();
  const client = Number(detectedClientProcess()?.split('@', 1)[0]);
  writeFileSync(join(process.argv[1], '.forge', 'watching'), JSON.stringify({ pid: process.pid, ppid: process.ppid, client }));
`;

for (const cause of ['stdin EOF', 'client death with a shell wrapper holding stdio'])
  test(
    `MCP exits and releases its watcher on ${cause}`,
    {
      timeout: 10000,
      skip: cause !== 'stdin EOF' && process.platform === 'win32',
    },
    async t => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-mcp-disconnect-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
      const owner = join(root, '.forge', 'work');
      mkdirSync(owner, { recursive: true });
      const throughShell = cause !== 'stdin EOF';
      const wrapper = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { spawn } from 'node:child_process';
         const argv = ['--input-type=module', '-e', ${JSON.stringify(serverFixture)}, process.argv[1]];
         const child = ${throughShell}
           ? spawn('/bin/sh', ['-c', 'exec 3<&0; "$@" <&3 & wait', 'sh', process.execPath, ...argv], { stdio: 'inherit' })
           : spawn(process.execPath, argv, { stdio: 'inherit' });
         process.send(child.pid);
         child.once('exit', code => { process.exit(code ?? 1); });`,
          root,
        ],
        { env: mcpTestEnvironment(t), stdio: ['pipe', 'pipe', 'ignore', 'ipc'] },
      );
      const wrapperExit = once(wrapper, 'exit');
      const lines = createInterface({ input: wrapper.stdout });
      const helper = processIdentity((await once(wrapper, 'message'))[0]);
      let mcp;
      t.after(async () => {
        lines.close();
        if (mcp && processAlive(mcp)) process.kill(mcp.pid, 'SIGKILL');
        if (processAlive(helper)) process.kill(helper.pid, 'SIGKILL');
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
        await wrapperExit;
      });
      const lease = await eventually(
        'the session owns a native watcher',
        () => {
          if (!existsSync(join(root, '.forge', 'watching'))) return null;
          try {
            return JSON.parse(readFileSync(join(owner, 'local-watcher.json'), 'utf8'));
          } catch {
            return null;
          }
        },
        lease => lease && processAlive(lease),
      );
      const ready = JSON.parse(readFileSync(join(root, '.forge', 'watching'), 'utf8'));
      mcp = processIdentity(ready.pid);
      if (throughShell) {
        assert.equal(ready.ppid, helper.pid);
        assert.equal(ready.client, wrapper.pid);
      }
      // The handshake's reply proves the grandchild has installed the real transport.
      const response = once(lines, 'line');
      wrapper.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'fixture', version: '1' },
          },
        }) + '\n',
      );
      assert.ok(JSON.parse((await response)[0]).result?.serverInfo);
      if (cause === 'stdin EOF') {
        wrapper.stdin.end();
        assert.deepEqual(await wrapperExit, [0, null]);
      } else {
        wrapper.kill('SIGKILL');
        assert.deepEqual(await wrapperExit, [null, 'SIGKILL']);
        assert(processAlive(helper), 'the intermediate shell still holds stdio');
      }
      await eventually(
        'MCP process and its watcher exited',
        () => [mcp, lease].map(processAlive),
        live => live.every(value => !value),
      );
    },
  );
