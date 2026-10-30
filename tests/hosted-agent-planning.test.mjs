// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { executeHostedPlanning, plannedIntent, markPlanningStarted } from '../dist/hosted-agent-planning.js';
import { hostedAgentCommandSchemas, hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The agent's port over the real Convex handlers; Intent states are the one stub (tested with
 * the Convex lanes fixture). Counts every Convex call the agent makes. */
function port(s, states = new Map()) {
  const calls = [];
  let intercept;
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'projectHostedPlanning:intentStates')
      return JSON.stringify(
        Object.fromEntries(args.ids.filter(id => states.has(id)).map(id => [id, states.get(id)])),
      );
    const [module, fn] = name.split(':');
    if (name === 'projectWorkActions:command' && intercept) await intercept(args);
    const handler = { projectWorkIndex: index, projectWorkActions: actions }[module][fn];
    return handler._handler(s.ctx, args);
  };
  const reference = ref => getFunctionName(ref);
  const result = {
    calls,
    states,
    root: join(s.directory, 'checkout'),
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    exchange: {
      client: {
        query: (ref, args) => invoke(reference(ref), args),
        action: (ref, args) => invoke(reference(ref), args),
      },
    },
    query: async (name, args) => {
      const value = await invoke(name, { ...args, projectId: s.projectId });
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    intercept: fn => (intercept = fn),
  };
  return result;
}
const run = (p, action, input, operationId) =>
  executeHostedPlanning(p, 'owner', action, hostedAgentCommandSchemas[action].parse(input), operationId);
const put = (p, input) => run(p, 'put-planning-item', input);
const list = (p, input = {}) => run(p, 'planning', input).then(response => response.result);

test('agents create an Initiative and Issue, comment, and read them filtered and paged', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Phase 6', status: 'open' })).result;
  assert.equal(initiative.version, 1);
  const issue = (
    await put(p, {
      kind: 'issue',
      title: 'Fix X',
      body: 'Why and acceptance',
      initiativeId: initiative.itemId,
    })
  ).result;
  await put(p, { kind: 'issue', title: 'Later', status: 'proposed', initiativeId: initiative.itemId });
  await put(p, { kind: 'issue', title: 'Elsewhere' });
  const comment = await run(p, 'comment-planning-item', {
    itemId: issue.itemId,
    text: 'Decision: use A, because B',
  });
  assert.equal(comment.result.commentId, comment.operationId);

  const all = await list(p);
  assert.equal(all.items.length, 4);
  assert.equal(all.nextCursor, null);
  const open = await list(p, { status: 'open', kind: 'issue' });
  assert.deepEqual(open.items.map(item => item.title).sort(), ['Elsewhere', 'Fix X']);
  const grouped = await list(p, { initiativeId: initiative.itemId });
  assert.deepEqual(grouped.items.map(item => item.title).sort(), ['Fix X', 'Later']);

  const one = await list(p, { id: issue.itemId });
  assert.equal(one.item.body, 'Why and acceptance');
  assert.deepEqual(
    one.comments.map(item => item.text),
    ['Decision: use A, because B'],
  );

  const first = await list(p, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert(first.nextCursor);
  const second = await list(p, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    [...first.items, ...second.items].map(item => item.id).sort(),
    all.items.map(item => item.id).sort(),
  );
  assert.equal(second.nextCursor, null);
  await assert.rejects(list(p, { cursor: 'forged' }), code('BAD_ARGUMENT'));
  // The Planning view reads the same records.
  const work = (await s.read()).data;
  assert.equal(work.planningItems.filter(item => item.kind === 'issue').length, 3);
});

test('a repeated operation replays, a lost reply reconciles, and a stale Work revision retries', async t => {
  const s = await setup(t),
    p = port(s);
  const input = { kind: 'issue', title: 'Replay me' };
  const first = await put(p, input);
  const events = s.tables.projectWorkEvents.size;
  const again = await put(p, input);
  assert.equal(again.operationId, first.operationId);
  assert.deepEqual(again.result.itemId, first.result.itemId);
  assert.equal(s.tables.projectWorkEvents.size, events);
  await assert.rejects(
    run(p, 'put-planning-item', { ...input, title: 'Changed' }, first.operationId),
    code('WORK_OPERATION_CHANGED'),
  );

  // Reply lost after commit: the same call returns the original.
  const lost = { kind: 'issue', title: 'Lost reply' };
  const action = p.exchange.client.action;
  let drop = true;
  p.exchange.client.action = async (...args) => {
    const value = await action(...args);
    if (drop) {
      drop = false;
      throw new Error('lost');
    }
    return value;
  };
  await assert.rejects(put(p, lost));
  p.exchange.client.action = action;
  const before = s.tables.projectWorkEvents.size;
  const recovered = await put(p, lost);
  assert.equal(s.tables.projectWorkEvents.size, before);
  assert.equal(recovered.result.version, 1);

  // Someone else writes between the revision read and the command.
  let raced = false;
  p.intercept(async () => {
    if (raced) return;
    raced = true;
    await s.send(s.item({ title: 'Raced in' }));
  });
  const stale = await put(p, { kind: 'issue', title: 'After race' });
  assert.equal(stale.result.version, 1);
  assert(
    (await s.read()).data.planningItems.some(item => item.title === 'After race') &&
      (await s.read()).data.planningItems.some(item => item.title === 'Raced in'),
  );
});

test('an Issue whose Intent completed is closed by the next read, with undo named; reconcile:false changes nothing', async t => {
  const s = await setup(t),
    p = port(s);
  const done = (await put(p, { kind: 'issue', title: 'Done work' })).result.itemId;
  const dropped = (await put(p, { kind: 'issue', title: 'Dropped work' })).result.itemId;
  const live = (await put(p, { kind: 'issue', title: 'Still going' })).result.itemId;
  p.states.set(done, 'completed');
  p.states.set(dropped, 'abandoned');
  p.states.set(live, 'active');

  const quiet = await list(p, { reconcile: false });
  assert.equal(quiet.reconciled, undefined);
  assert(quiet.items.every(item => item.status === 'open'));
  assert.equal(quiet.items.find(item => item.id === done).intent, 'completed');

  const read = await list(p);
  assert.equal(read.reconciled.changed.length, 2);
  assert(read.reconciled.changed.every(change => change.undo.includes('put-planning-item')));
  const byId = Object.fromEntries(read.items.map(item => [item.id, item.status]));
  assert.deepEqual(byId, { [done]: 'closed', [dropped]: 'abandoned', [live]: 'open' });
  const persisted = (await s.read()).data.planningItems;
  assert.equal(persisted.filter(item => item.id === done).at(-1).status, 'closed');
  assert.equal(persisted.filter(item => item.id === done).at(-1).reason, 'Intent completed');

  const events = s.tables.projectWorkEvents.size;
  const next = await list(p);
  assert.equal(next.reconciled, undefined);
  assert.equal(s.tables.projectWorkEvents.size, events);
  assert.deepEqual(Object.fromEntries(next.items.map(item => [item.id, item.status])), {
    [done]: 'closed',
    [dropped]: 'abandoned',
    [live]: 'open',
  });
});

test('start from an Issue: planned Intent shares the Issue id, the Issue becomes in-progress once', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Group' })).result.itemId;
  const issue = (
    await put(p, { kind: 'issue', title: 'Build it', body: 'Constraints here', initiativeId: initiative })
  ).result.itemId;
  const planned = await plannedIntent(p, issue);
  assert.deepEqual(planned, {
    kind: 'planned',
    intentId: issue,
    outcome: 'Build it',
    constraints: 'Constraints here',
  });
  await assert.rejects(plannedIntent(p, initiative), code('BAD_ARGUMENT'));
  await assert.rejects(plannedIntent(p, randomUUID()), code('NOT_FOUND'));

  const startOperation = randomUUID();
  const marked = await markPlanningStarted(p, issue, startOperation);
  assert.deepEqual(marked, { updated: true, status: 'in-progress', version: 2 });
  const events = s.tables.projectWorkEvents.size;
  assert.deepEqual(await markPlanningStarted(p, issue, startOperation), {
    updated: false,
    status: 'in-progress',
  });
  assert.equal(s.tables.projectWorkEvents.size, events);
  const item = (await list(p, { id: issue })).item;
  assert.equal(item.status, 'in-progress');
  assert.equal(item.initiativeId, initiative);
  // A second Lane on the in-progress Issue is still allowed.
  assert.equal((await plannedIntent(p, issue)).intentId, issue);

  // A failed link never fails the start; it says how to retry.
  const broken = await markPlanningStarted(
    {
      ...p,
      query: async () => {
        throw new Error('offline');
      },
    },
    issue,
    randomUUID(),
  );
  assert.equal(broken.updated, false);
  assert(broken.retry);

  // Closed Issues must be reopened first.
  const closed = (await put(p, { kind: 'issue', title: 'Finished', status: 'closed' })).result.itemId;
  await assert.rejects(plannedIntent(p, closed), code('INTENT_CLOSED'));
});

test('a 100-item backlog reads in three Convex calls and idle reads nothing', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Backlog' })).result.itemId;
  for (let i = 0; i < 99; i++)
    await s.send(
      s.item({ title: `Issue ${i}`, initiativeId: initiative, status: i % 3 ? 'open' : 'proposed' }),
    );
  p.calls.length = 0;
  const page = await list(p, { limit: 100 });
  assert.equal(page.items.length, 100);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:records',
    'projectHostedPlanning:intentStates',
  ]);
  const cost = JSON.stringify(page).length;
  assert(cost < 60_000, `page bytes ${cost}`);
  const idle = p.calls.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(p.calls.length, idle);
});

function transport(s, { planning }) {
  const p = port(s),
    seen = [];
  const capabilities = JSON.stringify({
    schema: 1,
    projectId: s.projectId,
    actor: 'owner',
    authority: { mode: 'server', epoch: 1 },
    actions: hostedAgentActions.filter(
      action => planning || !['planning', 'put-planning-item', 'comment-planning-item'].includes(action),
    ),
    mainReady: true,
    sourceWorkerConfigured: true,
    checkCallbackConfigured: false,
    nativeOwnerRequired: false,
    observation: 'finite',
  });
  const query = p.exchange.client.query;
  p.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedAgent:capabilities') {
      seen.push(Object.keys(args));
      // A released server rejects arguments it does not know, one named field at a time.
      if (!planning && 'planningVersion' in args)
        throw new Error('ArgumentValidationError: Object contains extra field `planningVersion`');
      return capabilities;
    }
    return query(ref, args);
  };
  return {
    p,
    seen,
    transport: new HostedAgentTransport(p.root, p.address, {
      projectId: s.projectId,
      client: p.exchange.client,
    }),
  };
}

test('the transport serves planning actions from the advertised capability and tells older servers apart', async t => {
  const s = await setup(t);
  const current = transport(s, { planning: true });
  const created = await current.transport.dispatch('put-planning-item', {
    kind: 'issue',
    title: 'Via transport',
  });
  assert(current.seen[0].includes('planningVersion'));
  assert.equal(created.action, 'put-planning-item');
  assert.equal(created.result.version, 1);
  const read = await current.transport.dispatch('planning', { kind: 'issue' });
  assert.deepEqual(
    read.result.items.map(item => item.title),
    ['Via transport'],
  );
  const same = await current.transport.dispatch('put-planning-item', {
    kind: 'issue',
    title: 'Via transport',
  });
  assert.equal(same.operationId, created.operationId);
  await assert.rejects(current.transport.dispatch('planning', { status: 'nonsense' }), code('BAD_ARGUMENT'));

  const old = transport(s, { planning: false });
  await assert.rejects(old.transport.dispatch('planning', {}), error => {
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    assert.match(error.message, /does not offer hosted action planning/);
    return true;
  });
  // The released server's argument error removed only the new field, and nothing was written.
  assert(old.seen.length === 1 || !old.seen.at(-1).includes('planningVersion'));
});

test('start {planningItemId} starts the Issue as a planned Intent and links it once, with the original operation on replay', async t => {
  const s = agentFixture(t),
    item = {
      id: randomUUID(),
      operationId: randomUUID(),
      request: 'a'.repeat(40),
      version: 1,
      previousVersion: 0,
      kind: 'issue',
      title: 'Planned outcome',
      body: 'Planned constraints',
      status: 'open',
      intentIds: [],
      at: '2026-01-01T00:00:00.000Z',
      provenance: 'user-declared-local',
    },
    commands = [],
    query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectWorkIndex:workspace')
      return JSON.stringify({ generationId: 'g', revision: 5, sourceRevision: 1 });
    if (name === 'projectWorkIndex:detail')
      return { generationId: 'g', revision: 1, value: JSON.stringify(item), editable: true, intentPin: null };
    return query(ref, args);
  };
  s.exchange.client.action = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectWorkActions:command');
    commands.push(JSON.parse(args.command));
    return { revision: 6 };
  };
  const started = await s.transport().dispatch('start', { planningItemId: item.id });
  const request = s.calls.find(call => call.name === 'projectHostedStart:start').args;
  assert.deepEqual(request.intent, {
    kind: 'planned',
    intentId: item.id,
    outcome: 'Planned outcome',
    constraints: 'Planned constraints',
  });
  assert.deepEqual(started.result.planning, { updated: true, status: 'in-progress', version: 2 });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].status, 'in-progress');
  assert.equal(commands[0].expectedVersion, 1);
  assert.equal(commands[0].itemId, item.id);

  const again = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.equal(again.operationId, started.operationId);
  assert.equal(commands.length, 2);
  assert.equal(commands[1].operationId, commands[0].operationId, 'the link replays its original operation');

  await assert.rejects(
    s.transport().dispatch('start', { planningItemId: item.id, outcome: 'Mixed' }),
    code('BAD_ARGUMENT'),
  );
  const old = agentFixture(t);
  old.caps.actions = old.caps.actions.filter(action => action !== 'planning');
  await assert.rejects(old.transport().dispatch('start', { planningItemId: item.id }), error => {
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    return /does not offer hosted action planning/.test(error.message);
  });
});
