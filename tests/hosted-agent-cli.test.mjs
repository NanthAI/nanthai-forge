// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { agentCli } from '../dist/agent-cli.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
const errorCode = expected => error => error.code === expected;
function http(t, s) {
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(s.address.url), 'No real HTTP calls');
    const body = JSON.parse(init.body),
      args = body.args[0];
    const name = body.path;
    const { makeFunctionReference } = await import('convex/server');
    const ref = makeFunctionReference(name);
    const value = await (String(url).endsWith('/api/query')
      ? s.exchange.client.query(ref, args)
      : s.exchange.client.mutation(ref, args));
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
}
test('the actual agent CLI routes explicit hosted addressing before native owner construction and retains the address', async t => {
  const s = agentFixture(t);
  http(t, s);
  const first = await agentCli([s.root, 'start', JSON.stringify({ ...s.address, outcome: 'CLI synthetic' })]);
  assert.equal(first.transport, 'hosted');
  assert.equal(first.action, 'start');
  assert(!existsSync(s.root));
  const next = await agentCli([s.root, 'start', JSON.stringify({ outcome: 'CLI synthetic' })]);
  assert.equal(next.operationId, first.operationId);
  assert.deepEqual(next.result, first.result);
  const file = join(s.root, '..', 'command.json');
  writeFileSync(file, JSON.stringify({ laneId: s.lane.laneId }));
  assert.equal((await agentCli([s.root, 'status', '--command-file', file])).result.head, s.lane.head);
  const submissionId = randomUUID();
  const cancelled = await agentCli([s.root, 'cancel', JSON.stringify({ submissionId })]);
  assert.equal(cancelled.action, 'cancel');
  assert.equal(cancelled.result.id, submissionId);
  assert.equal(cancelled.result.error.code, 'LANDING_CANCELLED');
  await assert.rejects(agentCli([s.root, 'clean', '{}']), errorCode('HOSTED_ACTION_UNSUPPORTED'));
});
test('incomplete hosted CLI addressing fails without auth, network or a native owner', async t => {
  const s = agentFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network for incomplete addressing'));
  await assert.rejects(
    agentCli([s.root, 'start', JSON.stringify({ projectId: s.address.projectId, outcome: 'Synthetic' })]),
    errorCode('BAD_ARGUMENT'),
  );
  assert(!existsSync(s.root));
});

test('native symlink roots and read-only address detection preserve native routing without creating directories', t => {
  const s = agentFixture(t),
    real = join(s.root, '..', 'native'),
    alias = join(s.root, '..', 'alias');
  mkdirSync(real);
  symlinkSync(real, alias);
  assert.equal(hostedAgentAddress(alias, {}), null);
  const absent = join(s.root, 'missing', 'nested');
  assert.equal(hostedAgentAddress(absent, {}), null);
  assert(!existsSync(s.root));
});

test('hosted CLI forwards urgent finish and retained queued Candidate reprioritisation', async t => {
  const s = agentFixture(t);
  http(t, s);
  const finished = await agentCli([
    s.root,
    'finish',
    JSON.stringify({
      ...s.address,
      candidateId: s.candidate.id,
      composeOperationId: '11111111-1111-4111-8111-111111111111',
      priority: 'urgent',
    }),
  ]);
  assert.equal(finished.result.submission.request.priority, 'urgent');
  assert.equal(finished.result.queuePosition, 1);
  const operationId = randomUUID(),
    command = { submissionId: finished.result.submission.id, priority: 'normal', operationId };
  const changed = await agentCli([s.root, 'prioritize', JSON.stringify(command)]);
  assert.equal(changed.result.priority, 'normal');
  const first = s.calls.find(c => c.name === 'projectHostedLandingPriority:prioritize');
  assert.equal(first.args.expectedVersion, 0);
  assert.equal(
    (await agentCli([s.root, 'prioritize', JSON.stringify(command)])).operationId,
    changed.operationId,
  );
  assert.deepEqual(s.calls.filter(c => c.name === first.name).at(-1).args, first.args);
});
