// SPDX-License-Identifier: Apache-2.0
// edcb0fc8: the machine-local record of landed operations the CLI canary's wait step uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  landedOperations,
  landedOperationsPath,
  rememberLandedOperations,
} from '../dist/landed-operations.js';

const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function stateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-landed-'));
  const previous = { state: process.env.XDG_STATE_HOME, canary: process.env.FORGE_CLI_CANARY };
  process.env.XDG_STATE_HOME = directory;
  delete process.env.FORGE_CLI_CANARY;
  t.after(() => {
    for (const [name, value] of [
      ['XDG_STATE_HOME', previous.state],
      ['FORGE_CLI_CANARY', previous.canary],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('landed operations are kept newest first, five per project, and only valid ids', t => {
  const home = stateHome(t);
  for (let n = 1; n <= 7; n++) rememberLandedOperations('p1', [id(n)]);
  rememberLandedOperations('p1', ['not-a-uuid', id(6)]);
  rememberLandedOperations('p2', [id(9)]);
  assert.deepEqual(landedOperations('p1', home), [id(6), id(7), id(5), id(4), id(3)]);
  assert.deepEqual(landedOperations('p2'), [id(9)]);
  assert.deepEqual(landedOperations('unknown', home), []);
  assert.equal(landedOperationsPath(home), join(home, 'forge', 'landed-operations.json'));
});

test('a canary child never writes the record; a missing or corrupt file reads as empty', t => {
  const home = stateHome(t);
  process.env.FORGE_CLI_CANARY = 'a'.repeat(64);
  rememberLandedOperations('p1', [id(1)]);
  assert.equal(existsSync(landedOperationsPath(home)), false);
  assert.deepEqual(landedOperations('p1', home), []);
});
