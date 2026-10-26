// SPDX-License-Identifier: Apache-2.0
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { mcpTestEnvironment, pollUntil } from './mcp-runtime.mjs';

export function mcpProcess(t, root, { idleMs = 900000, cli = resolve('dist/cli.js') } = {}) {
  const child = spawn(process.execPath, [cli, 'mcp', root, '--agent'], {
    env: { ...mcpTestEnvironment(t), FORGE_MCP_IDLE_MS: String(idleMs) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    buffer = '',
    next = 0;
  const replies = new Map();
  const waiting = new Map();
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) {
        replies.set(message.id, message);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const request = async (method, params = {}) => {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const reply = new Promise(resolve => {
      if (replies.has(id)) resolve(replies.get(id));
      else waiting.set(id, resolve);
    });
    return reply;
  };
  return {
    child,
    exited,
    request,
    stderr: () => stderr,
    async ready() {
      const response = await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic-lifecycle', version: '1' },
      });
      if (response.error) throw new Error(JSON.stringify(response.error));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return request('tools/list');
    },
  };
}
export function processes(directory) {
  return execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), rssKiB: Number(match[2]), command: match[3] }] : [];
    })
    .filter(row => row.command.includes('local-watcher-worker.js') && row.command.endsWith(directory));
}
export const eventually = (label, observe, ready) =>
  pollUntil({ label, observe, ready, describe: value => value, timeout: 5000, interval: 25 });
