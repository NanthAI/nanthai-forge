// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { callTool, mcpTestEnvironment, pollUntil, requestOptions } from './mcp-runtime.mjs';

test('test MCP calls explicitly distinguish check completion from source request deadlines', async () => {
  const calls = [];
  const client = { callTool: async (...args) => calls.push(args) };
  for (const action of ['finish', 'run', 'run-check', 'run-playbook', 'status']) {
    const request = { name: 'forge_task', arguments: { command: { action } } };
    await callTool(client, request);
    assert.deepEqual(calls.at(-1), [
      request,
      undefined,
      { timeout: action === 'status' ? 240_000 : 1_800_000 },
    ]);
  }
  assert.equal(requestOptions('forge_source').timeout, 240_000);
});

test('elapsed-time polling retains its completion predicate and safe last-state diagnostic', async () => {
  let observations = 0,
    elapsed = 0;
  const clock = {
    now: () => elapsed,
    sleep: async ms => {
      elapsed += ms;
    },
  };
  assert.equal(
    await pollUntil({
      ...clock,
      label: 'fixture',
      observe: async () => ++observations,
      ready: value => value === 3,
      describe: value => value,
      interval: 1,
    }),
    3,
  );
  await assert.rejects(
    pollUntil({
      ...clock,
      label: 'fixture completion',
      observe: async () => ({ status: 'running', private: 'do not print' }),
      ready: () => false,
      describe: value => ({ status: value.status }),
      timeout: 5,
      interval: 1,
    }),
    error =>
      /fixture completion timed out after \d+ms; last observed: \{"status":"running"\}/.test(error.message) &&
      !error.message.includes('do not print'),
  );
});

test('SDK child environment selects isolated config over a synthetic home login', t => {
  const env = mcpTestEnvironment(t);
  const inspect = selected => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { hasSavedAuth } from './dist/auth-store.js'; console.log(hasSavedAuth())",
      ],
      { env: selected, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(inspect(env), 'false');
  const { XDG_CONFIG_HOME, ...withoutConfig } = env;
  assert.ok(XDG_CONFIG_HOME);
  assert.equal(inspect(withoutConfig), 'true');
  assert.equal(env.FORGE_CHECK_QUEUE_DIR, process.env.FORGE_CHECK_QUEUE_DIR);
});
