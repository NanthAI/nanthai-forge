// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';

// Test-only hang guards, separate from production Git/process deadlines.
export const observationTimeout = 240_000;
export function requestOptions(name, args = {}) {
  const action = args.command?.action;
  return { timeout: ['finish', 'run', 'run-check', 'run-playbook'].includes(action) ? 1_800_000 : 240_000 };
}
export const callTool = (client, request) =>
  client.callTool(request, undefined, requestOptions(request.name, request.arguments));

export async function pollUntil({
  label,
  observe,
  ready,
  describe,
  timeout = observationTimeout,
  interval = 100,
  now = () => performance.now(),
  sleep = pause,
}) {
  const started = now();
  let last;
  do {
    last = await observe();
    if (ready(last)) return last;
    const remaining = timeout - (now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
  } while (now() - started < timeout);
  // Callers select safe state fields; never dump source, logs or credential-bearing responses.
  throw new Error(
    `${label} timed out after ${Math.round(now() - started)}ms; last observed: ${JSON.stringify(describe(last))}`,
  );
}

export function mcpTestEnvironment(t) {
  const home = mkdtempSync(join(tmpdir(), 'forge-mcp-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fallback = join(home, '.config', 'forge');
  mkdirSync(fallback, { recursive: true });
  // If XDG_CONFIG_HOME is dropped, this synthetic login changes tool discovery.
  writeFileSync(
    join(fallback, 'auth.json'),
    JSON.stringify({
      deployments: {
        'https://synthetic.example.invalid': {
          token: 'synthetic-only',
          credentialId: 'fixture',
          expiresAt: 4102444800000,
          name: 'fixture',
          scope: 'cli',
        },
      },
    }),
    { mode: 0o600 },
  );
  return {
    ...getDefaultEnvironment(),
    HOME: home,
    USERPROFILE: home,
    ...Object.fromEntries(
      ['XDG_CONFIG_HOME', 'FORGE_CHECK_QUEUE_DIR', 'FORGE_GIT_TIMEOUT_MS']
        .filter(key => process.env[key])
        .map(key => [key, process.env[key]]),
    ),
    FORGE_GIT_TIMEOUT_MS: process.env.FORGE_GIT_TIMEOUT_MS ?? '240000',
  };
}
