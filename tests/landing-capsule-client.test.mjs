// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { hydrateLandingHistory } from '../dist/landing-capsule-client.js';
const { landingHistoryQuery, watchLandingHistory } = await import(
  moduleUrl('../web/src/lane/landing-history.ts')
);
const name = 'projectHostedLanding:candidate';
const args = { projectId: 'synthetic', candidateId: 'selected' };
const marker = JSON.stringify({ landingCapsule: { protocol: 1 } });
const turn = () => new Promise(resolve => setImmediate(resolve));
test('uncapsuled history takes no action; capsule hydration sends original selection only to the server action', async () => {
  let calls = 0;
  assert.equal(
    await hydrateLandingHistory(name, args, '{"live":true}', () => {
      calls++;
    }),
    '{"live":true}',
  );
  const value = await hydrateLandingHistory(name, args, marker, async (action, request) => {
    calls++;
    assert.equal(action, 'projectLandingCapsuleRead:history');
    assert.deepEqual(request, { query: name, request: JSON.stringify(args) });
    return 'historical';
  });
  assert.equal(value, 'historical');
  assert.equal(calls, 1);
});
test('browser history negotiates only the existing cold-history skew; authorization refusals never retry', async () => {
  let calls = 0;
  const client = {
    query: async (_ref, request) => {
      calls++;
      if (!request.capsuleProtocol) throw new Error('CLI_UPGRADE_REQUIRED');
      return marker;
    },
    action: async (ref, request) => {
      assert.equal(getFunctionName(ref), 'projectLandingCapsuleRead:history');
      assert.equal(request.projectId, args.projectId);
      return '{"request":{"id":"selected"}}';
    },
  };
  assert.deepEqual(await landingHistoryQuery(client, name, args), { request: { id: 'selected' } });
  assert.equal(calls, 2);
  calls = 0;
  client.query = async () => {
    calls++;
    throw new Error('PROJECT_UNAVAILABLE');
  };
  await assert.rejects(landingHistoryQuery(client, name, args), /PROJECT_UNAVAILABLE/);
  assert.equal(calls, 1);
});
test('a superseded browser hydration cannot restore data hidden by a current access failure', async () => {
  let update,
    complete,
    refused = false;
  const values = [],
    errors = [];
  const client = {
    watchQuery: () => ({
      localQueryResult: () => {
        if (refused) throw new Error('PROJECT_UNAVAILABLE');
        return marker;
      },
      onUpdate: callback => {
        update = callback;
        return () => {};
      },
    }),
    action: () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  };
  const stop = watchLandingHistory(
    client,
    name,
    args,
    value => values.push(value),
    error => errors.push(error),
  );
  refused = true;
  update();
  complete('{"private":"older-view"}');
  await turn();
  assert(values.every(value => value === undefined));
  assert.equal(errors.length, 1);
  stop();
});

test('CLI history hydration preserves the successful priority negotiation and existing capability call', async t => {
  const f = agentFixture(t);
  f.caps.features = ['landing-capsules-v1'];
  const transport = f.transport();
  await transport.dispatch('capabilities', {});
  const calls = [];
  const originalQuery = f.exchange.client.query;
  f.exchange.client.query = async (ref, request) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:status') return originalQuery(ref, request);
    calls.push(['query', request]);
    return marker;
  };
  f.exchange.client.action = async (ref, request) => {
    calls.push(['action', request]);
    assert.equal(getFunctionName(ref), 'projectLandingCapsuleRead:history');
    assert.equal(JSON.parse(request.request).priorityInfo, 1);
    assert.equal(JSON.parse(request.request).capsuleProtocol, 1);
    return '{"request":{"id":"same"}}';
  };
  assert.deepEqual(await transport.query('projectHostedLanding:status', { submissionId: 'same' }), {
    request: { id: 'same' },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].capsuleProtocol, 1);
});

test('a browser wait satisfied by the cached live value releases its subscription without an extra read or action', async () => {
  const { landingBrowserIO } = await import(moduleUrl('../web/src/lane/landing-browser-io.ts'));
  let closed = 0;
  const io = landingBrowserIO(
    {
      watchQuery: () => ({
        localQueryResult: () => '{"done":true}',
        onUpdate: () => () => {
          closed++;
        },
      }),
      query: () => assert.fail('no second query'),
      action: () => assert.fail('no cold action'),
    },
    args.projectId,
  );
  assert.deepEqual(await io.wait(name, {}, value => value.done), { done: true });
  assert.equal(closed, 1);
});

test('an archive-aware agent hydrates a structured journal upgrade in its original query without another capability read', async t => {
  const { ConvexError } = await import('convex/values'),
    f = agentFixture(t);
  f.caps.features = ['journal-segments-v1'];
  const transport = f.transport();
  await transport.dispatch('capabilities', {});
  const calls = [];
  f.exchange.client.query = async (_ref, request) => {
    calls.push('query');
    assert(request.request);
    throw new ConvexError({
      code: 'CLI_UPGRADE_REQUIRED',
      message: 'Update the client.',
      journalHistory: true,
      viewVersion: 'owner',
    });
  };
  f.exchange.client.action = async (ref, request) => {
    calls.push('action');
    assert.equal(getFunctionName(ref), 'projectJournalActions:history');
    assert.equal(request.query, 'projectHostedRecordReads:read');
    return JSON.stringify({ record: { id: 'original' } });
  };
  assert.deepEqual(
    await transport.query('projectHostedRecordReads:read', {
      request: JSON.stringify({ collection: 'jobs', id: 'original', version: 0 }),
    }),
    { record: { id: 'original' } },
  );
  assert.deepEqual(calls, ['query', 'action']);
});
test('browser exact-history reads hydrate structured journal upgrades without a redundant protocol retry', async () => {
  const { ConvexError } = await import('convex/values');
  let queries = 0,
    actions = 0;
  const client = {
    query: async () => {
      queries++;
      throw new ConvexError({
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Update the client.',
        journalHistory: true,
        viewVersion: 'owner',
      });
    },
    action: async ref => {
      actions++;
      assert.equal(getFunctionName(ref), 'projectJournalActions:history');
      return '{"record":{"id":"original"}}';
    },
  };
  assert.deepEqual(
    await landingHistoryQuery(client, 'projectHostedLaneHistory:read', {
      projectId: 'project',
      laneId: 'original',
    }),
    { record: { id: 'original' } },
  );
  assert.equal(queries, 1);
  assert.equal(actions, 1);
});
