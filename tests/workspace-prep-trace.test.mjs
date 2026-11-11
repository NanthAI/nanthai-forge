// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('the preparation trace keeps first-network clocks and methods without URLs, credentials or bodies', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-trace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.json');
  const module = new URL('../scripts/workspace-prep-trace.mjs', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      globalThis.fetch = async () => new Response('synthetic response');
      await import(${JSON.stringify(module)});
      await (await fetch('https://private.invalid/secret-url', {
        method: 'PUT', headers: { authorization: 'secret-credential' }, body: 'secret-body'
      })).text();
      await (await fetch('https://private.invalid/api/query', {
        method: 'POST', body: JSON.stringify({ path: 'projectExample:read', args: { secret: 'secret-argument' } })
      })).text();
    `,
    ],
    { env: { ...process.env, FORGE_PREP_TRACE: path }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const text = readFileSync(path, 'utf8');
  for (const secret of [
    'private.invalid',
    'secret-url',
    'secret-credential',
    'secret-body',
    'secret-argument',
    'synthetic response',
  ])
    assert.ok(!text.includes(secret), `trace must exclude ${secret}`);
  const trace = JSON.parse(text);
  assert.ok(Number.isFinite(trace.firstNetwork.atMs));
  for (const value of Object.values(trace.firstNetwork.cpu)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.deepEqual(
    trace.calls.map(row => [row.name, row.rpc, row.method]),
    [
      ['source', false, 'PUT'],
      ['projectExample:read', true, 'POST'],
    ],
  );
  assert.deepEqual(
    trace.calls.map(row => row.responseBytes),
    [18, 18],
  );
});
