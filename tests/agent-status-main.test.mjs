// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Why main failed, for agents (Item ae068e0c): `status {"main":true}` and `status {"main":N}` read the
// same answer as the web's Main broke view (projectMainRed:read) in one query, and main mixed with another selector
// is refused before any server call. Before this, a lead could not look up a red without Convex access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';

test('status main reads the red the Main broke row names, in one query, and refuses mixed selectors', async t => {
  const s = agentFixture(t);
  const answer = {
    red: { sequence: 41, head: 'a'.repeat(64) },
    culprit: { receiptId: 'r1' },
    end: { how: 'red' },
  };
  const query = s.exchange.client.query;
  s.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectMainRed:read'
      ? (s.calls.push({ name: 'projectMainRed:read', args }), Promise.resolve(canonicalPayload(answer)))
      : query(ref, args);
  const before = s.calls.length;
  const status = await s.transport().dispatch('status', { main: 41 });
  assert.deepEqual(status.result.red, answer.red);
  assert.deepEqual(status.result.culprit, answer.culprit);
  const reads = s.calls.slice(before).filter(call => call.name === 'projectMainRed:read');
  assert.deepEqual(
    reads.map(call => call.args.sequence),
    [41],
    'one read, for that red',
  );
  await s.transport().dispatch('status', { main: true });
  assert.equal(s.calls.at(-1).args.sequence, undefined, 'main:true reads the newest red');
  const mixed = s.calls.length;
  await assert.rejects(
    s.transport().dispatch('status', { main: true, runId: '00000000-0000-4000-8000-000000000000' }),
    {
      code: 'BAD_ARGUMENT',
    },
  );
  assert.equal(
    s.calls.slice(mixed).filter(call => call.name === 'projectMainRed:read').length,
    0,
    'a mixed selector never reads',
  );
  assert.equal(hostedAgentCommandSchemas.status.safeParse({ main: -1 }).success, false);
});
