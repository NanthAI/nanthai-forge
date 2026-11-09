// SPDX-License-Identifier: Apache-2.0
// Issue ec7bd1b5: only a reply that disagrees with this CLI reads as version skew. A request this
// CLI cannot build is its own terminal error, and an older CLI reads a reply with one extra field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { parseHostedResponse, isHostedReplyError } from '../dist/hosted-response.js';
import { protocolMismatchError } from '../dist/hosted-agent-version.js';
import { responseSnapshotPath } from '../scripts/response-compat.mjs';

const released = JSON.parse(readFileSync(new URL(`../${responseSnapshotPath}`, import.meta.url), 'utf8'));
const startReply = {
  schema: 1,
  operationId: randomUUID(),
  intentId: randomUUID(),
  lane: null,
  at: '2026-01-01T00:00:00.000Z',
};

test('a bare start is refused up front: clear message, no hosted call', async t => {
  const s = agentFixture(t);
  for (const operationId of [undefined, randomUUID().toUpperCase()]) {
    const before = s.calls.length;
    await assert.rejects(
      hostedAgentCli(s.root, 'start', { ...(operationId ? { operationId } : {}) }, s.address, s.transport()),
      error => {
        assert.equal(error.code, 'BAD_ARGUMENT');
        assert.match(error.message, /planningItemId.*intentId.*outcome/);
        return true;
      },
    );
    assert.equal(s.calls.length, before, 'refused before any hosted call');
  }
});

test('a replayed operation id that failed locally repeats the same terminal error, not "upgrade"', async t => {
  const s = agentFixture(t);
  const operationId = randomUUID();
  const transport = s.transport(),
    query = transport.query.bind(transport);
  // The start's main read fails with a request-side shape error; capabilities answer normally.
  transport.query = async (name, args) => {
    if (name === 'projectHostedChannels:current') throw new z.ZodError([]);
    return query(name, args);
  };
  const run = () => hostedAgentCli(s.root, 'start', { operationId, outcome: 'x' }, s.address, transport);
  const failures = [];
  for (let i = 0; i < 2; i++)
    failures.push(
      await run().then(
        () => null,
        error => error,
      ),
    );
  for (const error of failures) assert.equal(error?.code, 'HOSTED_PROTOCOL_INVALID');
  assert.equal(failures[0].message, failures[1].message, 'the replay says the same thing');
});

test('only the reply boundary produces the version-skew message', async t => {
  const reply = z.object({ a: z.string() }).strict();
  let boundary;
  try {
    parseHostedResponse(reply, { a: 1 });
  } catch (error) {
    boundary = error;
  }
  assert.equal(isHostedReplyError(boundary), true);
  assert.equal(isHostedReplyError(reply.safeParse({ a: 1 }).error), false);
  assert.equal(isHostedReplyError(new Error('x')), false);

  const s = agentFixture(t);
  const via = async error => {
    const transport = s.transport(),
      query = transport.query.bind(transport);
    transport.query = async (name, args) => {
      if (name === 'projectHostedChannels:current') throw error;
      return query(name, args);
    };
    return hostedAgentCli(s.root, 'start', { outcome: 'x' }, s.address, transport).then(
      () => null,
      failure => failure,
    );
  };
  const skew = await via(boundary);
  assert.equal(skew.code, 'HOSTED_PROTOCOL_INVALID');
  assert.equal(skew.message, protocolMismatchError(['a']).message, 'reply skew keeps its upgrade step');
  assert.match(skew.message, / at a;/, 'and names the failing reply field, never a value');
  const local = await via(reply.safeParse({ a: 1 }).error);
  assert.equal(local.code, 'HOSTED_PROTOCOL_INVALID');
  assert.doesNotMatch(local.message, /Upgrade nforge|retained operation IDs resume/);
  assert.match(local.message, /at a\b/, 'names the failing path, never a value');
});

test('an older-schema CLI reads a start reply with one extra field (top level and nested)', () => {
  const old = z.fromJSONSchema(released.schemas['hosted-lane#hostedStartResultSchema']);
  const extended = {
    ...startReply,
    futureField: { any: 'shape' },
    openLanes: [
      {
        laneId: randomUUID(),
        owner: null,
        yours: true,
        lastActivityAt: startReply.at,
        futureNested: 1,
      },
    ],
  };
  const before = JSON.stringify(extended);
  const parsed = parseHostedResponse(old, extended);
  assert.equal(JSON.stringify(extended), before, 'the input is never mutated');
  assert.equal('futureField' in parsed, false);
  assert.equal('futureNested' in parsed.openLanes[0], false);
  // A changed meaning still fails loudly: a required field gone, or a wrong type.
  const { intentId: _intentId, ...missing } = startReply;
  assert.throws(() => parseHostedResponse(old, missing), z.ZodError);
  assert.throws(() => parseHostedResponse(old, { ...startReply, lane: 'x' }), z.ZodError);
});
