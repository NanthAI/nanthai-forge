// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { composeFixture, api as composeApi } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { storageClock } from './storage-clock.mjs';

const { MEMBER_WORK_BUDGET: caps } = await import(moduleUrl('../convex/abuseLimits.ts'));
const checkApi = await import(moduleUrl('../convex/projectHostedChecks.ts'));
const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const day = Date.UTC(2026, 10, 10);
const resetAt = new Date(day + caps.windowMs).toISOString();
const budgetAt = (kind, left) => ({ limit: `member-${kind}`, left, of: caps[kind], resetAt });
const member = (f, kind, left) =>
  f.insert('projectContributors', {
    projectId: f.projectId,
    contributor: 'member',
    workBudget: { day, checks: 0, composes: 0, submissions: 0, [kind]: caps[kind] - left },
  });
const io = ({ ranges, documents, readBytes, writes, writeBytes }) => ({
  ranges,
  documents,
  readBytes,
  writes,
  writeBytes,
});

test('a member check warns strictly below 20% using the existing row, including on replay', async t => {
  storageClock(t);
  const oldKey = process.env.FORGE_HOSTED_CHECK_KEY_ID;
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  t.after(() => {
    if (oldKey === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
    else process.env.FORGE_HOSTED_CHECK_KEY_ID = oldKey;
  });
  const f = await checksFixture();
  const id = member(f, 'checks', 61);
  const enqueue = (fixture, request, memberBudget, actor = 'member') =>
    fixture
      .call(
        'checkEnqueue',
        checkApi.enqueue,
        {
          projectId: fixture.projectId,
          request: JSON.stringify(request),
          ...(memberBudget ? { memberBudget } : {}),
        },
        actor,
      )
      .then(JSON.parse);

  assert.equal((await enqueue(f, f.selection(), true)).budget, undefined, '60 of 300 is exactly 20%');
  const request = f.selection();
  const { budget, ...canonical } = await enqueue(f, request, true);
  assert.deepEqual(budget, budgetAt('checks', 59));
  const freshIO = io(f.counts.at(-1));
  // Compare the same scheduler activity: a project's first check creates its queue rows.
  const legacy = await checksFixture();
  member(legacy, 'checks', 61);
  await enqueue(legacy, legacy.selection(), false);
  assert.equal((await enqueue(legacy, legacy.selection(), false)).budget, undefined);
  assert.deepEqual(freshIO, io(legacy.counts.at(-1)));

  const without = await enqueue(f, request, false);
  const oldIO = io(f.counts.at(-1));
  const replay = await enqueue(f, request, true);
  assert.deepEqual(io(f.counts.at(-1)), oldIO);
  assert.deepEqual(without, canonical);
  assert.deepEqual(replay, { ...canonical, budget });
  assert.equal(f.tables.projectContributors.get(id).workBudget.checks, caps.checks - 59);
  assert(!JSON.parse([...f.tables.projectHostedCheckRuns.values()].at(-1).value).budget);
  const replyBytes = Buffer.byteLength(JSON.stringify(replay)) - Buffer.byteLength(JSON.stringify(without));
  t.diagnostic(
    `Check I/O: fresh ${JSON.stringify(freshIO)}, replay ${JSON.stringify(oldIO)}. Warning adds ${replyBytes} bytes.`,
  );
  assert(replyBytes <= 100);

  assert.equal((await enqueue(f, f.selection(), true, 'owner')).budget, undefined);
  await assert.rejects(enqueue(f, f.selection(), true, 'outsider'), code('PROJECT_UNAVAILABLE'));
  f.patch('projectContributors', id, {
    workBudget: { ...f.tables.projectContributors.get(id).workBudget, day: day - caps.windowMs },
  });
  assert.equal((await enqueue(f, request, true)).budget, undefined, 'yesterday’s counter is expired');
});

test('a compose warning uses the charged compose counter and leaves the retained state canonical', async t => {
  storageClock(t);
  const f = await composeFixture();
  member(f, 'composes', 2);
  const { request } = f.selection([await f.lane(f.baseline)]);
  const prepare = memberBudget =>
    f
      .call(
        'composePrepare',
        composeApi.prepare,
        { projectId: f.projectId, request: JSON.stringify(request), memberBudget },
        'member',
      )
      .then(JSON.parse);
  const { budget, ...canonical } = await prepare(true);
  assert.deepEqual(budget, budgetAt('composes', 1));
  assert.deepEqual(await prepare(false), canonical);
  const oldIO = io(f.counts.at(-1));
  assert.deepEqual(await prepare(true), { ...canonical, budget });
  assert.deepEqual(io(f.counts.at(-1)), oldIO);
});

test('a Candidate landing shows its member’s remaining submissions while legacy requests keep their shape', async t => {
  storageClock(t);
  const f = await acceptanceFixture();
  member(f, 'submissions', 1);
  const { candidate } = await f.makeCandidate([], [], {}, 'member');
  const request = f.request({ agent: false, candidateId: candidate.id, expectedHead: candidate.result.head });
  const enqueue = memberBudget =>
    f
      .transaction(
        'landingEnqueue',
        landingApi.enqueue,
        {
          projectId: f.projectId,
          request: JSON.stringify(request),
          ...(memberBudget ? { memberBudget } : {}),
        },
        'member',
      )
      .then(JSON.parse);
  const { budget, ...canonical } = await enqueue(true);
  assert.deepEqual(budget, budgetAt('submissions', 0));
  assert.deepEqual(await enqueue(false), canonical);
  assert.deepEqual(await enqueue(true), { ...canonical, budget });
  assert(!JSON.parse([...f.tables.projectHostedLandingRequests.values()][0].value).budget);
});

test('MCP negotiates the same member budget as the CLI transport without an accounting call', async t => {
  storageClock(t);
  const s = agentFixture(t);
  const transport = s.transport();
  const server = new McpServer({ name: 'forge-test', version: '1.0.0' });
  const unregister = registerHostedAgentWorkflow(server, transport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [clientLink, serverLink] = InMemoryTransport.createLinkedPair();
  await server.connect(serverLink);
  await client.connect(clientLink);
  t.after(async () => {
    unregister();
    await client.close();
    await server.close();
  });
  const budget = budgetAt('checks', 4);
  const mutation = s.exchange.client.mutation;
  t.mock.method(s.exchange.client, 'mutation', async (ref, args) => {
    const reply = await mutation(ref, args);
    return getFunctionName(ref) === 'projectHostedChecks:enqueue' && args.memberBudget
      ? { ...(typeof reply === 'string' ? JSON.parse(reply) : reply), budget }
      : reply;
  });
  const command = { action: 'check', candidateId: s.candidate.id, checkId: randomUUID() };
  const check = async () => {
    const from = s.calls.length;
    const tool = await client.callTool({
      name: 'forge_check',
      arguments: { command: { ...command, operationId: randomUUID() } },
    });
    assert.equal(tool.isError, undefined, tool.content[0].text);
    return { receipt: JSON.parse(tool.content[0].text), calls: s.calls.slice(from) };
  };
  const older = await check();
  assert.equal(older.receipt.budget, undefined);
  assert.equal(
    older.calls.find(call => call.name === 'projectHostedChecks:enqueue').args.memberBudget,
    undefined,
  );
  s.caps.features = [...(s.caps.features ?? []), 'member-work-budget'];
  const supported = await check();
  assert.deepEqual(supported.receipt.budget, budget);
  assert.equal(
    supported.calls.find(call => call.name === 'projectHostedChecks:enqueue').args.memberBudget,
    true,
  );
  assert.deepEqual(
    supported.calls.map(c => c.name),
    older.calls.map(c => c.name),
  );
});
