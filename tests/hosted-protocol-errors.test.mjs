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
import { protocolMismatchError, unknownActionError } from '../dist/hosted-agent-version.js';
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

test('a root-level local shape failure names its source, field and issue code, never a value (bb486d05)', async t => {
  const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
  const { localShapeError } = await import('../dist/hosted-agent-version.js');
  const caught = run => {
    try {
      run();
    } catch (error) {
      return error;
    }
    assert.fail('expected a shape error');
  };
  // As an old preflight receipt left it: an undefined field deep in the retained land payload.
  // z.json() is a union, so zod reports it at the root path: once printed as "at parameters".
  const secret = 'value-that-must-not-print';
  const payload = caught(() =>
    canonicalPayload({
      defaults: { preflight: { finish: undefined, reason: secret } },
      files: { 'a/b.ts': 1n },
    }),
  );
  assert.ok(payload instanceof z.ZodError);

  // Through the CLI: the land path surfaces the named field, not "parameters".
  const s = agentFixture(t);
  const transport = s.transport(),
    query = transport.query.bind(transport);
  transport.query = async (name, args) => {
    if (name === 'projectHostedChannels:current') throw payload;
    return query(name, args);
  };
  const failure = await hostedAgentCli(s.root, 'start', { outcome: 'x' }, s.address, transport).then(
    () => null,
    error => error,
  );
  assert.equal(failure?.code, 'HOSTED_PROTOCOL_INVALID');
  assert.match(
    failure.message,
    /canonical JSON payload \(.*\) at defaults\.preflight\.finish \(invalid_type/,
  );

  const message = localShapeError('finish', payload).message;
  assert.doesNotMatch(message, /at parameters/);
  assert.match(message, /in canonical JSON payload/);
  assert.match(message, /defaults\.preflight\.finish \(invalid_type, received undefined\)/);
  assert.match(message, /files\.\[key\] \(invalid_type, received bigint\)/, 'a record key is data: redacted');
  assert.doesNotMatch(message, new RegExp(`${secret}|a/b\\.ts`));

  // Unrecognized keys: their names (field names only), with no source tag.
  const strict = z.object({ laneId: z.string() }).strict();
  const keys = localShapeError(
    'finish',
    strict.safeParse({ laneId: secret, finsh: 1, 'a/b': 2 }).error,
  ).message;
  assert.match(keys, /in an unnamed local record at its root \(unrecognized_keys, keys finsh\)/);
  assert.doesNotMatch(keys, new RegExp(`${secret}|a/b`));

  // A plain union of objects: equally deep branches go to the closer match (fewer issues).
  const either = z.union([
    z.object({ kind: z.literal('a'), x: z.string() }),
    z.object({ kind: z.literal('b'), y: z.string() }),
  ]);
  const tie = localShapeError('finish', either.safeParse({ kind: 'b', y: 1 }).error).message;
  assert.match(tie, /at y \(invalid_type, received number\)/);
  assert.doesNotMatch(tie, /\bx \(/);
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

test('mixed planned-start variants fail before retaining a start operation or making a hosted call', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { validateHostedCliCommand } = await import('../dist/hosted-cli-validation.js');
  const { hostedAgentHelpEntries } = await import('../dist/hosted-agent-help.js');
  const s = agentFixture(t);
  const input = { planningItemId: 'ad80e037-35a3-44c5-9ba2-025519a2c45f', outcome: 'Mixed' };
  assert.throws(
    () => validateHostedCliCommand(s.root, 'start', input),
    error => error.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(s.transport().dispatch('start', input), error => error.code === 'BAD_ARGUMENT');
  assert.equal(s.calls.length, 0);
  assert.match(
    hostedAgentHelpEntries.find(entry => entry.action === 'status').schema.properties.summary.description,
    /Requires runId/,
  );
  assert.match(
    hostedAgentHelpEntries.find(entry => entry.action === 'finish').schema.properties.closes.description,
    /not a list/,
  );
});

test('an unknown intents action names the supported read, lanes (f0d0fdd6, 274859d9)', () => {
  for (const action of ['intents', 'intent']) {
    const error = unknownActionError('/synthetic-root-never-created', action);
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    assert.match(error.message, /Use lanes \{\} for open Lanes with their Intents/);
  }
});

test('status with a list key names the working list call, lanes (f0d0fdd6: a brief documented status {limit})', async () => {
  const { validateHostedCliCommand } = await import('../dist/hosted-cli-validation.js');
  for (const input of [{ limit: 5 }, { view: 'live' }])
    assert.throws(
      () => validateHostedCliCommand('/synthetic-root-never-created', 'status', input),
      error =>
        error.code === 'BAD_ARGUMENT' &&
        error.message.includes(`To list open Lanes, run nforge agent ROOT lanes '{"limit":20}'.`),
    );
  // A status error without a list key keeps its plain text.
  assert.throws(
    () => validateHostedCliCommand('/synthetic-root-never-created', 'status', { waitMs: 'soon' }),
    error => error.code === 'BAD_ARGUMENT' && !error.message.includes('To list open Lanes'),
  );
});
