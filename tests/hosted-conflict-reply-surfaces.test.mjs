// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCli, sourceWaitHooks } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { observationWaitHooks } from '../dist/hosted-agent-observe.js';
import { peerWaitHooks } from '../dist/hosted-board-wait.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { exactConflictNotice } from '../dist/hosted-conflict-notice.js';
import { memberDataNotice } from '../dist/member-data-notice.js';
const conflicts = [
  {
    with: 'main',
    goal: 'main',
    flaggedAt: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'preview.test.ts', mine: [[60, 60]], theirs: [[60, 61]], reason: 'text' }],
  },
];
const board = { messages: [], more: 0, cursor: 1, conflicts };
function mcp(t, transport, subscribe) {
  const calls = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _options, call) {
          calls.set(name, call);
        },
      },
      transport,
      subscribe,
    ),
  );
  return async (name, input) => {
    const result = await calls.get(name)(input, {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: async () => {},
    });
    return JSON.parse(result.content[0].text);
  };
}
for (const client of ['CLI', 'MCP'])
  for (const kind of ['peer', 'run'])
    for (const current of [true, false])
      test(`83e6d0d3: ${client} terminal ${kind} delivers ${current ? 'current' : 'no withdrawn'} conflict without changing the terminal outcome`, async t => {
        const s = agentFixture(t),
          transport = s.transport();
        await transport.dispatch('open', { laneId: s.lane.laneId });
        const exit = process.exitCode;
        t.after(() => {
          process.exitCode = exit;
        });
        const id = randomUUID();
        let subscriptions = 0,
          dispatches = 0;
        const active = { id, projectId: s.address.projectId, status: 'running' };
        const terminal =
          kind === 'run'
            ? { ...active, status: 'passed', ...(current ? { board } : {}) }
            : { peer: { laneId: id, state: 'accepted', terminal: true }, ...(current ? { board } : {}) };
        const fake = {
          root: s.root,
          address: s.address,
          advertisedFeatures: ['run-board-wait'],
          async dispatch() {
            dispatches++;
            return {
              schema: 1,
              transport: 'hosted',
              action: 'observe',
              operationId: null,
              resolved: null,
              result: kind === 'peer' ? { features: ['board-wait'] } : active,
            };
          },
        };
        const subscribe = () => ({
          onUpdate(_ref, _args, next) {
            subscriptions++;
            // A pending notice can be withdrawn before the next terminal update.
            queueMicrotask(() => {
              if (kind === 'run') next({ ...active, board });
              next(terminal);
            });
            return () => {};
          },
          async close() {},
        });
        observationWaitHooks.subscribe = subscribe;
        peerWaitHooks.subscribe = subscribe;
        t.after(() => {
          observationWaitHooks.subscribe = undefined;
          peerWaitHooks.subscribe = undefined;
        });
        const input = kind === 'run' ? { runId: id } : { peer: id };
        const result =
          client === 'CLI'
            ? await hostedAgentCli(s.root, 'wait', input, s.address, fake)
            : await mcp(t, fake, subscribe)('forge_wait', input);
        assert.equal(result.result.status, 'terminal');
        assert.equal(Boolean(result.conflictNotice), current);
        if (current) {
          assert.equal(result.conflictNotice.items[0].file, 'preview.test.ts');
          assert.match(result.conflictNotice.next, /sync/);
        }
        assert.equal(subscriptions, 1);
        assert.equal(dispatches, 1);
        if (client === 'CLI') assert.equal(process.exitCode, 0);
      });

for (const client of ['CLI', 'MCP'])
  for (const exact of [true, false])
    test(`83e6d0d3: ${client} peers promotes ${exact ? 'the exact verdict' : 'no range-only advice'} in its one query`, async t => {
      const s = agentFixture(t),
        transport = s.transport();
      let queries = 0;
      transport.query = async (name, args) => {
        queries++;
        assert.equal(name, 'projectHostedOverlaps:read');
        assert.equal(args.laneId, s.lane.laneId);
        return {
          peerEvidence: { scope: 'saved-paths', items: [{ reason: 'adjacent-or-intersecting-ranges' }] },
          ...(exact ? { conflicts } : {}),
        };
      };
      const input = { laneId: s.lane.laneId, path: 'preview.test.ts' };
      const result =
        client === 'CLI'
          ? await hostedAgentCli(s.root, 'peers', input, s.address, transport)
          : await mcp(t, transport)('forge_review', { command: { action: 'peers', ...input } });
      assert.equal(Boolean(result.conflictNotice), exact);
      if (exact) assert.equal(result.conflictNotice.items[0].file, 'preview.test.ts');
      assert.equal(queries, 1);
    });

test('83e6d0d3: a terminal source wait CLI replay keeps the notice beside the completed operation', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const operationId = randomUUID();
  new HostedAgentJournal(s.root, s.address, 'owner', 'save', { laneId: s.lane.laneId }, operationId);
  const previous = sourceWaitHooks.wait,
    exit = process.exitCode;
  t.after(() => {
    sourceWaitHooks.wait = previous;
    process.exitCode = exit;
  });
  sourceWaitHooks.wait = async () => ({
    outcome: { status: 'completed', result: { saved: true } },
    conflictNotice: exactConflictNotice(s.lane.laneId, conflicts),
    notice: memberDataNotice,
  });
  let replays = 0;
  const transport = {
    root: s.root,
    address: s.address,
    advertisedFeatures: ['source-board-wait'],
    async dispatch() {
      replays++;
      return {
        schema: 1,
        transport: 'hosted',
        action: 'save',
        operationId,
        resolved: { operationId },
        result:
          replays === 1 ? { status: 'submitted', jobId: 'synthetic' } : { outcome: { status: 'completed' } },
      };
    },
  };
  const result = await hostedAgentCli(s.root, 'wait', { operationIds: [operationId] }, s.address, transport);
  assert.equal(result.result.outcome.status, 'completed');
  assert.equal(result.conflictNotice.items[0].file, 'preview.test.ts');
  assert.equal(result.result.status, undefined, 'no extra IN_PROGRESS step after completion');
  assert.equal(replays, 2, 'existing source reconciliation, no extra read for delivery');
});
