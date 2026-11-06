// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalOperationId, canonicalOperationIds } from '../dist/operation-id-case.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';

const UPPER = 'AB310E84-708C-4DA4-9515-C77568C5ADB7';
const LOWER = UPPER.toLowerCase();
const address = { url: 'https://fixture.invalid', projectId: 'project' };
function root(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-opid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'client');
}

test('operation ids are used in one (lower case) spelling, whatever case the caller typed', t => {
  const r = root(t);
  assert.equal(canonicalOperationId(r, UPPER), LOWER);
  assert.equal(canonicalOperationId(r, LOWER), LOWER);
  assert.equal(canonicalOperationId(r, 'not-a-uuid'), 'not-a-uuid');
  const command = {
    operationId: UPPER,
    operationIds: [UPPER, 'ee710bea-f0fa-4738-aed3-649937c5e9f1'],
    composeOperationId: UPPER,
    laneId: UPPER,
    message: UPPER,
  };
  assert.deepEqual(canonicalOperationIds(r, command), {
    ...command,
    operationId: LOWER,
    operationIds: [LOWER, 'ee710bea-f0fa-4738-aed3-649937c5e9f1'],
    composeOperationId: LOWER,
  });
  const same = { operationId: LOWER };
  assert.equal(canonicalOperationIds(r, same), same, 'nothing to change returns the command itself');
});

test('an operation an older CLI journaled under its typed spelling keeps that spelling', t => {
  const r = root(t);
  writeFileSync(join(hostedAgentDirectory(r), `${UPPER}.json`), '{}');
  // Whatever case a later wait or status uses, it names the id the server stored.
  assert.equal(canonicalOperationId(r, LOWER), UPPER);
  assert.equal(canonicalOperationId(r, UPPER), UPPER);
  assert.deepEqual(canonicalOperationIds(r, { operationIds: [LOWER] }), { operationIds: [UPPER] });
});

test('status and wait receive the one spelling of an operation id, with no extra call', async t => {
  const r = root(t);
  const seen = [];
  const transport = {
    dispatch: async (action, command) => {
      seen.push([action, command]);
      return { schema: 1, transport: 'hosted', action, operationId: null, result: {} };
    },
  };
  await hostedAgentCli(r, 'status', { operationId: UPPER }, address, transport);
  await hostedAgentCli(r, 'status', { operationId: LOWER }, address, transport);
  assert.deepEqual(seen, [
    ['status', { operationId: LOWER }],
    ['status', { operationId: LOWER }],
  ]);
});
