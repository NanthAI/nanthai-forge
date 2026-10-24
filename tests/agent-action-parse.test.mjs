// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentAction } from '../dist/agent-action-parse.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { agentCli } from '../dist/agent-cli.js';

const id = '00000000-0000-4000-8000-000000000001';
const review = { action: 'review', kind: 'lane', id };

test('dispatch reports missing review pins and malformed full digests before reading Work', async () => {
  // Validation must complete before any store or filesystem access.
  const workflow = Object.create(AgentWorkflow.prototype);
  await assert.rejects(
    workflow.dispatch(review),
    error => error.code === 'BAD_ARGUMENT' && /expectedHead/.test(error.message),
  );
  for (const expectedHead of ['abcdef', 'private-input-value']) {
    assert.throws(
      () => parseAgentAction({ ...review, expectedHead }),
      error =>
        error.code === 'BAD_ARGUMENT' &&
        /expectedHead: use a full source digest/.test(error.message) &&
        !error.message.includes(expectedHead),
    );
  }
  assert.equal(parseAgentAction({ ...review, expectedHead: 'a'.repeat(64) }).expectedHead, 'a'.repeat(64));
  assert.equal(parseAgentAction({ ...review, expectedHead: null }).expectedHead, null);
});

test('validation identifies nested fields and existing bounds without echoing unknown values or keys', () => {
  assert.throws(() => parseAgentAction({ action: 'status', limit: 101 }), /limit:.*100/);
  assert.throws(
    () =>
      parseAgentAction({
        action: 'compose',
        operationId: id,
        intentId: id,
        inputs: [{ laneId: 'invalid-private-value', head: 'a'.repeat(64) }],
      }),
    error => /inputs.0.laneId/.test(error.message) && !error.message.includes('invalid-private-value'),
  );
  assert.throws(
    () => parseAgentAction({ ...review, expectedHead: null, 'private-field': 'private-value' }),
    error =>
      /unrecognized fields/.test(error.message) &&
      !error.message.includes('private-field') &&
      !error.message.includes('private-value'),
  );
  assert.throws(
    () => parseAgentAction({ action: 'private-action' }),
    error => error.code === 'BAD_ARGUMENT' && !error.message.includes('private-action'),
  );
});

test('action help explains review budgets, link selectors, run observation and peer answers', async () => {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    output += chunk;
    return true;
  };
  try {
    for (const action of ['review', 'link', 'observe', 'log', 'cancel', 'peer-ack'])
      await agentCli(['unused-root', action, '--help']);
  } finally {
    process.stdout.write = original;
  }
  assert.match(output, /maxBytes 1024\.\.48000/);
  assert.match(output, /full 40- or 64-character/);
  assert.match(output, /exactly one laneId, viewId or save/);
  assert.equal((output.match(/nested check run operation ID/g) ?? []).length, 3);
  assert.match(output, /choice is accept-order, swap or split/);
});

test('save normalizes to checkpoint with identical pins and validation', async () => {
  const command = { laneId: id, operationId: id, message: 'Saved', expectedHead: 'a'.repeat(64) };
  assert.deepEqual(
    parseAgentAction({ action: 'save', ...command }),
    parseAgentAction({ action: 'checkpoint', ...command }),
  );
  assert.throws(() => parseAgentAction({ action: 'save', laneId: id }), /message/);
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = chunk => {
    output += chunk;
    return true;
  };
  try {
    await agentCli(['unused', 'save', '--help']);
  } finally {
    process.stdout.write = write;
  }
  assert.match(output, /checkpoint/);
});
