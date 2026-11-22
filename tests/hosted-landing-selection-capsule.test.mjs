// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { z } from 'zod';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { moduleUrl } from './convex-module.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { finishFixture, code } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { capsuleMaintenanceFixture, storedFastProof } from './landing-capsule-maintenance-fixture.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const cold = await import(moduleUrl('../convex/projectLandingCapsuleRead.ts'));
const { decodeLandingCapsule, encodeLandingCapsule } = await import(
  moduleUrl('../convex/projectLandingCapsuleCodec.ts')
);
const read = (f, selection) =>
  f.tx('landing-selection', api.read, { projectId: f.projectId, ...selection }).then(JSON.parse);
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function earlierCapsuleProof(t, wide) {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request({ agent: false }));
  await f.drain();
  f.moveMain();
  await f.passChecks();
  await f.drain();
  const { currentAttemptId: attemptId } = await read(f, { submissionId: state.id });
  f.moveMain();
  await f.passChecks();
  await f.drain();
  await f.passChecks();
  await f.drain();
  const h = await capsuleMaintenanceFixture(t, { f, state });
  const terminal = await read(f, { submissionId: state.id });
  assert.notEqual(terminal.currentAttemptId, attemptId);
  const row = [...f.tables.projectHostedLandingAttempts.values()].find(row => row.attemptId === attemptId);
  const attempt = JSON.parse(row.value);
  // These legal path names fit the base64 budget but exceed it when serialized as MCP text.
  const paths = wide ? Array.from({ length: 280 }, (_, i) => `src/${i}-${'"'.repeat(64)}.ts`) : [];
  const proof = storedFastProof(attempt, paths);
  if (wide) {
    const encoded = JSON.stringify(proof);
    assert(Buffer.byteLength(encoded) < 42_000);
    assert(Buffer.byteLength(JSON.stringify(encoded)) > 64_000);
  }
  f.patch('projectHostedLandingAttempts', row._id, {
    value: JSON.stringify({ ...attempt, crossHeadProof: proof }),
  });
  const args = { submissionId: state.id, attemptId };
  const cli = agentFixture(t);
  const transport = cli.transport();
  const requests = [];
  let actor = 'owner';
  let beforeRecheck;
  const query = 'projectHostedLandingAttemptHistory:read';
  cli.exchange.client.query = (ref, input) => {
    assert.equal(getFunctionName(ref), query);
    requests.push('query');
    return f.tx('landing-selection', api.read, { ...input, projectId: f.projectId }, actor);
  };
  cli.exchange.client.action = (ref, input) => {
    assert.equal(getFunctionName(ref), 'projectLandingCapsuleRead:history');
    requests.push('action');
    assert.equal(input.query, query);
    const selected = JSON.parse(input.request);
    assert.equal(selected.attemptId, attemptId);
    let queries = 0;
    return cold.history._handler(
      {
        auth: { getUserIdentity: async () => ({ subject: actor }) },
        runQuery: (ref, input) => {
          assert.equal(getFunctionName(ref), query);
          requests.push('authorize');
          if (++queries === 2) beforeRecheck?.();
          return f.tx('landing-selection', api.read, input, actor);
        },
      },
      { ...input, projectId: f.projectId },
    );
  };
  const cliRead = async (selected = args) =>
    slimReceipt(await hostedAgentCli(cli.root, 'queue', selected, cli.address, transport));
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      { registerTool: (name, config, call) => tools.set(name, { ...config, call }) },
      transport,
    ),
  );
  const mcpRead = async selected => {
    const review = tools.get('forge_review');
    return review.call(
      z.object(review.inputSchema).parse({ command: { action: 'queue', ...(selected ?? args) } }),
    );
  };
  return {
    ...h,
    args,
    attempt,
    proof,
    terminal,
    cliRead,
    mcpRead,
    transport,
    query,
    clientRequests: requests,
    actor: value => (actor = value),
    beforeRecheck: hook => (beforeRecheck = hook),
  };
}

for (const wide of [false, true])
  test(`incident replay c7ad22b0: CLI and MCP resolve only the earlier selected attempt's ${wide ? 'bounded proof pins' : 'exact capsule-only proof'}`, async t => {
    const h = await earlierCapsuleProof(t, wide);
    const live = await h.cliRead();
    assert.deepEqual(h.clientRequests.splice(0), ['query']);
    assert.equal(h.requests.length, 0);
    await h.pack();
    assert.equal(
      [...h.f.tables.projectHostedLandingAttempts.values()].some(row => row.attemptId === h.args.attemptId),
      false,
    );
    const legacy = await read(h.f, h.args);
    assert.equal(
      JSON.parse(Buffer.from(legacy.checkReuseBase64, 'base64').toString('utf8')).proofStatus,
      'unavailable',
    );
    const before = h.requests.length;
    const started = performance.now();
    const archived = await h.cliRead();
    const elapsed = performance.now() - started;
    assert.deepEqual(h.requests.slice(before), ['GET']);
    assert.deepEqual(h.clientRequests.splice(0), ['query', 'action', 'authorize', 'authorize']);
    assert.deepEqual(archived.result.checkReuse, live.result.checkReuse);
    assert.equal(archived.result.selection, null);
    if (wide) {
      assert.equal(archived.result.checkReuse.proofStatus, 'byte-omitted');
      assert.equal(archived.result.checkReuse.crossHeadProof, undefined);
      assert.equal(archived.result.checkReuse.proofPins.riskRule, h.proof.riskRule);
    } else {
      assert.equal(archived.result.checkReuse.proofStatus, 'retained');
      assert.deepEqual(archived.result.checkReuse.crossHeadProof, h.proof);
    }
    const costs = h.f.counts.filter(row => row.name === 'landing-selection').slice(-3);
    assert(costs.every(cost => cost.writes === 0 && cost.documents <= 5));
    const mcp = await h.mcpRead();
    assert(!mcp.isError, mcp.content[0].text);
    assert.deepEqual(JSON.parse(mcp.content[0].text), archived.result);
    assert.deepEqual(h.requests.slice(before), ['GET', 'GET']);
    assert.deepEqual(h.clientRequests.splice(0), ['query', 'action', 'authorize', 'authorize']);
    const bytes = Buffer.byteLength(JSON.stringify(archived));
    assert(bytes < 64_000);
    assert(Buffer.byteLength(JSON.stringify(mcp)) < 64_000);
    t.diagnostic(
      `Cold selected proof: ${bytes} CLI bytes, ${costs.map(cost => cost.readBytes).join('/')} DB bytes, ${elapsed.toFixed(1)} ms locally`,
    );
    const terminal = await h.cliRead({ ...h.args, attemptId: h.terminal.currentAttemptId });
    assert.equal(terminal.result.checkReuse.proofStatus, 'unavailable');
    assert.deepEqual(h.clientRequests.splice(0), ['query']);
    assert.deepEqual(h.requests.slice(before), ['GET', 'GET']);
  });

test('capsule-only proof refuses changed access and mismatched bytes and reports missing evidence explicitly', async t => {
  const h = await earlierCapsuleProof(t, false);
  await h.pack();
  const before = h.requests.length;
  const query = selected => h.transport.query(h.query, { ...selected, capsuleProtocol: 1 });
  await assert.rejects(query({ ...h.args, submissionId: randomUUID() }), code('NOT_FOUND'));
  h.actor('outsider');
  await assert.rejects(query(h.args), code('PROJECT_UNAVAILABLE'));
  assert.equal(h.requests.length, before);

  const reader = h.f.insert('projectReaders', { projectId: h.f.projectId, reader: 'outsider' });
  const allowed = await h.mcpRead();
  assert(!allowed.isError);
  assert.deepEqual(JSON.parse(allowed.content[0].text).checkReuse.crossHeadProof, h.proof);
  const memberCosts = h.f.counts.filter(row => row.name === 'landing-selection').slice(-3);
  assert(memberCosts.every(cost => cost.writes === 0 && cost.documents <= 8));
  assert.deepEqual(h.requests.slice(before), ['GET']);
  h.beforeRecheck(() => h.f.tables.projectReaders.delete(reader));
  const refused = await h.mcpRead();
  assert(refused.isError);
  assert.match(refused.content[0].text, /PROJECT_UNAVAILABLE/);
  assert.deepEqual(h.requests.slice(before), ['GET', 'GET']);
  h.beforeRecheck(undefined);
  h.actor('owner');

  const [[sha, bytes]] = h.objects;
  h.objects.delete(sha);
  const missing = (await h.cliRead()).result;
  assert.equal(missing.checkReuse.proofStatus, 'unavailable');
  assert.equal(missing.checkReuse.runId, h.proof.runId);
  h.objects.set(sha, bytes);

  const row = [...h.f.tables.projectFinishReadRows.values()].find(
    row => row.kind === 'projectLandingCapsules' && row.submissionId === h.args.submissionId,
  );
  const pointer = JSON.parse(row.value);
  const capsule = decodeLandingCapsule(bytes, pointer, h.f.projectId, h.args.submissionId);
  const replace = (next, pointer) => {
    h.objects.set(next.pointer.sha256, Buffer.from(next.body));
    h.f.patch('projectFinishReadRows', row._id, {
      value: JSON.stringify({ ...next.pointer, summary: pointer.summary }),
    });
  };
  const attempts = capsule.tables.projectHostedLandingAttempts.map(JSON.parse);
  const selected = attempts.find(row => row.attemptId === h.args.attemptId);
  const rewrite = rows =>
    encodeLandingCapsule({
      ...capsule,
      tables: { ...capsule.tables, projectHostedLandingAttempts: rows.map(row => JSON.stringify(row)) },
    });
  replace(rewrite(attempts.filter(row => row !== selected)), pointer);
  assert.deepEqual((await h.cliRead()).result, missing);
  const otherHead = '1'.repeat(64);
  for (const changes of [
    { submissionId: randomUUID() },
    { value: '{' },
    { value: JSON.stringify({ ...h.attempt, projectId: 'other-project', crossHeadProof: h.proof }) },
    {
      value: JSON.stringify({
        ...h.attempt,
        candidate: { ...h.attempt.candidate, head: otherHead },
        crossHeadProof: { ...h.proof, head: otherHead },
      }),
    },
    {
      number: selected.number + 10,
      value: JSON.stringify({ ...h.attempt, number: selected.number + 10, crossHeadProof: h.proof }),
    },
    {
      value: JSON.stringify({
        ...h.attempt,
        crossHeadProof: { ...h.proof, runId: randomUUID() },
      }),
    },
  ]) {
    replace(rewrite(attempts.map(row => (row === selected ? { ...row, ...changes } : row))), pointer);
    await assert.rejects(h.cliRead(), code('EVIDENCE_CHANGED'));
  }
  h.corrupt();
  await assert.rejects(h.cliRead(), code('EVIDENCE_CHANGED'));
});
