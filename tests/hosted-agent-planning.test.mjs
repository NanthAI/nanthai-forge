// SPDX-License-Identifier: Apache-2.0
import { installPlanningSearch } from './planning-search-fixture.mjs';
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
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import { z } from 'zod';
import { ConvexError } from 'convex/values';

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The agent's port over the real Convex handlers; Intent states are the one stub (tested with
 * the Convex lanes fixture). Counts every Convex call the agent makes. The real handlers keep
 * omitted put fields, so the port advertises that by default, as the transport does after discovery. */
function port(s, states = new Map(), serverFeatures = [...hostedContractFeatures]) {
  installPlanningSearch(s);
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
    const handler = {
      projectWorkIndex: index,
      projectWorkActions: actions,
      projectHostedPlanningSearch: search,
    }[module][fn];
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
    serverFeatures,
  };
  return result;
}

/** The put schema of the server deployed before c0255160 (State 45c971d5), verbatim: kind and
 * title required; an omitted body became "", status open, links [] and group none. */
const previousServerPut = z.object({
  action: z.literal('put-planning-item'),
  operationId: z.string().uuid(),
  itemId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative().default(0),
  kind: z.enum(['issue', 'initiative']),
  title: z.string().trim().min(1),
  body: z.string().default(''),
  status: z.enum(['proposed', 'open', 'in-progress', 'closed', 'abandoned']).default('open'),
  reason: z.string().optional(),
  intentIds: z.array(z.string().uuid()).default([]),
  initiativeId: z.string().uuid().optional(),
});
/** Make the fixture's real handlers apply a put exactly as that previous server did: every field
 * explicit (null group = cleared), or the same schema refusal. Comments are unchanged. */
function previousServer(p) {
  const seen = [];
  p.intercept(async args => {
    const command = JSON.parse(args.command);
    seen.push(command);
    if (command.action !== 'put-planning-item') return;
    const parsed = previousServerPut.safeParse(command);
    if (!parsed.success)
      throw new ConvexError({ code: 'BAD_ARGUMENT', message: 'Invalid planning command.' });
    args.command = JSON.stringify({ ...parsed.data, initiativeId: parsed.data.initiativeId ?? null });
  });
  return seen;
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
  await put(p, {
    kind: 'issue',
    title: 'Later',
    status: 'proposed',
    initiativeId: initiative.itemId,
  });
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

test('a put keeps every stored field it omits; clearing needs an explicit empty value (status-only move kept a body, c0255160)', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Phase 6' })).result;
  const body = 'Found it.\n\nDone when:\n- [ ] the body survives a move';
  const issue = (
    await put(p, {
      kind: 'issue',
      title: 'Keep me',
      body,
      status: 'proposed',
      initiativeId: initiative.itemId,
    })
  ).result;
  const stored = async () => (await list(p, { id: issue.itemId, reconcile: false })).item;
  const before = await stored();
  // The incident: kind, title, status and reason, no body.
  p.calls.length = 0;
  const moved = await put(p, {
    itemId: issue.itemId,
    expectedVersion: 1,
    kind: 'issue',
    title: 'Keep me',
    status: 'open',
    reason: 'triaged',
  });
  assert.deepEqual(p.calls, ['projectWorkIndex:workspace', 'projectWorkActions:command']);
  assert.equal(moved.result.status, 'open');
  let item = await stored();
  assert.equal(item.body, body);
  assert.equal(item.status, 'open');
  assert.equal(item.initiativeId, initiative.itemId);
  assert.equal(item.version, 2);
  // Status-only form: no kind, title or body at all.
  await put(p, {
    itemId: issue.itemId,
    expectedVersion: 2,
    status: 'in-progress',
  });
  item = await stored();
  assert.deepEqual(
    [item.title, item.body, item.initiativeId, item.status, item.version],
    [before.title, body, initiative.itemId, 'in-progress', 3],
  );
  // Replacing one field leaves the rest.
  await put(p, { itemId: issue.itemId, expectedVersion: 3, title: 'Renamed' });
  item = await stored();
  assert.deepEqual([item.title, item.body, item.status], ['Renamed', body, 'in-progress']);
  // Explicit empty values clear.
  await put(p, {
    itemId: issue.itemId,
    expectedVersion: 4,
    initiativeId: null,
  });
  assert.equal((await stored()).initiativeId ?? null, null);
  await put(p, { itemId: issue.itemId, expectedVersion: 5, body: '' });
  item = await stored();
  assert.equal(item.body, '');
  assert.equal(item.title, 'Renamed');
  // Creating still needs kind and title, before any Convex call.
  p.calls.length = 0;
  await assert.rejects(put(p, { body: 'orphan' }), code('BAD_ARGUMENT'));
  assert.deepEqual(p.calls, []);
});

test('new CLI against the previous server (no planning-put-keeps-omitted): a put keeps the body and every stored field (a83b6fd5)', async t => {
  const s = await setup(t);
  const body = 'Found it.\n\nDone when:\n- [ ] the body survives the deploy gap';
  const seed = port(s);
  const initiative = (await put(seed, { kind: 'initiative', title: 'Phase 6' })).result.itemId;
  const created = async title =>
    (await put(seed, { kind: 'issue', title, body, status: 'proposed', initiativeId: initiative })).result
      .itemId;
  const stored = async id => (await list(seed, { id, reconcile: false })).item;

  // The gap the Issue describes: a CLI that assumes the new semantics against the previous server.
  const assuming = port(s);
  previousServer(assuming);
  const wiped = await created('Assumed');
  await assert.rejects(
    put(assuming, { itemId: wiped, expectedVersion: 1, status: 'open' }),
    code('BAD_ARGUMENT'),
  );
  await put(assuming, { itemId: wiped, expectedVersion: 1, kind: 'issue', title: 'Assumed', status: 'open' });
  const lost = await stored(wiped);
  assert.deepEqual(
    [lost.body, lost.initiativeId ?? null],
    ['', null],
    'the previous server wipes what is omitted',
  );

  // The CLI as built: the server did not advertise the feature, so it sends the stored fields.
  const p = port(s, new Map(), []);
  const sent = previousServer(p);
  const issue = await created('Keep me');
  p.calls.length = 0;
  const moved = await put(p, { itemId: issue, expectedVersion: 1, status: 'open', reason: 'triaged' });
  assert.equal(moved.result.status, 'open');
  // One detail read more than the new server, on this path only.
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:detail',
    'projectWorkIndex:workspace',
    'projectWorkActions:command',
  ]);
  assert.deepEqual(
    (({ kind, title, body: sentBody, status, intentIds, initiativeId, reason }) => ({
      kind,
      title,
      sentBody,
      status,
      intentIds,
      initiativeId,
      reason,
    }))(sent.at(-1)),
    {
      kind: 'issue',
      title: 'Keep me',
      sentBody: body,
      status: 'open',
      intentIds: [],
      initiativeId: initiative,
      reason: 'triaged',
    },
  );
  let item = await stored(issue);
  assert.deepEqual(
    [item.title, item.body, item.status, item.initiativeId, item.version],
    ['Keep me', body, 'open', initiative, 2],
  );
  // Title-only and body-only puts keep the rest too; an explicit null group still clears it.
  await put(p, { itemId: issue, expectedVersion: 2, title: 'Renamed' });
  await put(p, { itemId: issue, expectedVersion: 3, initiativeId: null });
  item = await stored(issue);
  assert.deepEqual(
    [item.title, item.body, item.status, item.initiativeId ?? null],
    ['Renamed', body, 'open', null],
  );
  // A stale version is refused before anything is sent.
  const before = sent.length;
  await assert.rejects(
    put(p, { itemId: issue, expectedVersion: 2, status: 'closed' }),
    code('PLANNING_CHANGED'),
  );
  assert.equal(sent.length, before);
  // Start and reconcile already hold the stored item: same calls as on the new server, body kept.
  const started = await created('Started');
  p.calls.length = 0;
  assert.equal((await markPlanningStarted(p, started, randomUUID())).updated, true);
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:detail',
    'projectWorkIndex:workspace',
    'projectWorkActions:command',
  ]);
  item = await stored(started);
  assert.deepEqual([item.status, item.body, item.initiativeId], ['in-progress', body, initiative]);
  // Creating needs no stored read.
  p.calls.length = 0;
  await put(p, { kind: 'issue', title: 'New', initiativeId: null });
  assert.deepEqual(p.calls, ['projectWorkIndex:workspace', 'projectWorkActions:command']);
});

test('searching by an 8-character id or a full UUID returns that item first, then text mentions', async t => {
  const s = await setup(t),
    p = port(s);
  const target = (await put(p, { kind: 'issue', title: 'Alpha behaviour', body: 'plain' })).result.itemId;
  const id8 = target.slice(0, 8);
  const mention = (
    await put(p, {
      kind: 'issue',
      title: 'Beta follow-up',
      body: `Done when:\n- [ ] depends on ${target}, short ${id8}`,
    })
  ).result.itemId;
  for (const query of [id8, target, id8.toUpperCase()]) {
    p.calls.length = 0;
    const found = await list(p, { search: query });
    assert.deepEqual(p.calls, ['projectHostedPlanningSearch:search']);
    assert.equal(found.items[0].id, target, query);
    assert.equal(found.items[0].matchedBy, 'id');
    assert.deepEqual(
      found.items.map(item => item.id),
      [target, mention],
    );
  }
  // Closed items follow the usual status filter; ordinary words do not look an id up.
  assert.deepEqual(
    (await list(p, { search: 'follow' })).items.map(item => item.id),
    [mention],
  );
  await put(p, { itemId: target, expectedVersion: 1, status: 'closed' });
  assert.deepEqual(
    (await list(p, { search: id8 })).items.map(item => item.id),
    [mention],
  );
  assert.equal((await list(p, { search: id8, status: 'all' })).items[0].id, target);
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

test('a completed Intent closes its Issue only when every Done-when line is ticked; otherwise it holds and says how many are left', async t => {
  const s = await setup(t),
    p = port(s);
  const body = ticks => `Why\n\nDone when:\n${ticks.map(tick => `- [${tick}] line`).join('\n')}`;
  const unmet = (await put(p, { kind: 'issue', title: 'Unmet', body: body(['x', ' ', ' ']) })).result;
  const met = (await put(p, { kind: 'issue', title: 'Met', body: body(['x', 'x']) })).result;
  const plain = (await put(p, { kind: 'issue', title: 'No checklist', body: 'Just words' })).result;
  for (const id of [unmet.itemId, met.itemId, plain.itemId]) p.states.set(id, 'completed');
  const read = await list(p);
  const status = Object.fromEntries(read.items.map(item => [item.id, item.status]));
  assert.deepEqual(status, {
    [unmet.itemId]: 'open',
    [met.itemId]: 'closed',
    [plain.itemId]: 'closed',
  });
  assert.deepEqual(
    read.reconciled.held.map(held => [held.id, held.openLines]),
    [[unmet.itemId, 2]],
  );
  assert.equal(read.reconciled.changed.length, 2);
  // Ticking the lines is the explicit step; the next read closes the Issue (no further Intent change).
  await put(p, {
    kind: 'issue',
    itemId: unmet.itemId,
    expectedVersion: unmet.version,
    title: 'Unmet',
    body: body(['x', 'x', 'x']),
    status: 'open',
  });
  const after = await list(p);
  assert.equal(after.items.find(item => item.id === unmet.itemId).status, 'closed');
  assert.equal(after.reconciled.held, undefined);
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
  assert.deepEqual(byId, {
    [done]: 'closed',
    [dropped]: 'abandoned',
    [live]: 'open',
  });
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
    await put(p, {
      kind: 'issue',
      title: 'Build it',
      body: 'Constraints here',
      initiativeId: initiative,
    })
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
  assert.deepEqual(marked, {
    updated: true,
    status: 'in-progress',
    version: 2,
  });
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
      s.item({
        title: `Issue ${i}`,
        initiativeId: initiative,
        status: i % 3 ? 'open' : 'proposed',
      }),
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

function transport(s, { planning, features = false }) {
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
      if (!features && 'features' in args)
        throw new Error(
          'ArgumentValidationError: Object contains extra field `features` that is not in the validator.',
        );
      return features
        ? JSON.stringify({
            ...JSON.parse(capabilities),
            features: args.features.filter(name => features.includes(name)),
          })
        : capabilities;
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

test('new CLI vs previous server through the transport: the capability read drops only `features`, and a status-only put keeps the body (a83b6fd5)', async t => {
  const s = await setup(t);
  const body = 'Body that must survive';
  const created = await transport(s, {
    planning: true,
    features: ['planning-put-keeps-omitted'],
  }).transport.dispatch('put-planning-item', { kind: 'issue', title: 'Gap', body });
  const itemId = created.result.itemId;
  // Previous server: rejects the features argument and applies puts with the old defaults.
  const old = transport(s, { planning: true });
  const sent = previousServer(old.p);
  const moved = await old.transport.dispatch('put-planning-item', {
    itemId,
    expectedVersion: 1,
    status: 'open',
  });
  assert.equal(moved.result.version, 2);
  assert.equal(old.seen.length, 2, 'one retry on a server that predates features');
  assert(old.seen[0].includes('features'));
  assert.deepEqual(
    old.seen[1],
    old.seen[0].filter(name => name !== 'features'),
    'every other negotiated field is kept',
  );
  assert.equal(sent.at(-1).body, body);
  assert.equal(moved.serverContract, undefined, 'nothing this build needs is missing');
  const read = await old.transport.dispatch('planning', { id: itemId, reconcile: false });
  assert.deepEqual([read.result.item.body, read.result.item.status], [body, 'open']);
  // Current server: it advertises the feature, so the put names only what changes, in one read.
  const current = transport(s, { planning: true, features: ['planning-put-keeps-omitted'] });
  const commands = [];
  current.p.intercept(async args => commands.push(JSON.parse(args.command)));
  await current.transport.dispatch('put-planning-item', {
    itemId,
    expectedVersion: 2,
    status: 'in-progress',
  });
  assert.equal(current.seen.length, 1);
  assert.equal(current.transport.advertisedFeatures.includes('planning-put-keeps-omitted'), true);
  assert.equal('body' in commands.at(-1), false);
  assert.equal(
    (await current.transport.dispatch('planning', { id: itemId, reconcile: false })).result.item.body,
    body,
  );
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
      return JSON.stringify({
        generationId: 'g',
        revision: 5,
        sourceRevision: 1,
      });
    if (name === 'projectWorkIndex:detail')
      return {
        generationId: 'g',
        revision: 1,
        value: JSON.stringify(item),
        editable: true,
        intentPin: null,
      };
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
  assert.deepEqual(started.result.planning, {
    updated: true,
    status: 'in-progress',
    version: 2,
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].status, 'in-progress');
  // This server advertises no contract features: the link carries the stored fields (a83b6fd5).
  assert.equal(commands[0].body, 'Planned constraints');
  assert.equal(commands[0].title, 'Planned outcome');
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

// Issue 75d316dd: `start {planningItemId}` replayed the finished Lane of an Issue that already landed.
function plannedStartFixture(t) {
  const s = agentFixture(t),
    item = {
      id: randomUUID(),
      operationId: randomUUID(),
      request: 'a'.repeat(40),
      version: 1,
      previousVersion: 0,
      kind: 'issue',
      title: 'Follow-up outcome',
      body: 'Done-when lines still open',
      status: 'open',
      intentIds: [],
      at: '2026-01-01T00:00:00.000Z',
      provenance: 'user-declared-local',
    },
    query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectWorkIndex:workspace')
      return JSON.stringify({
        generationId: 'g',
        revision: 5,
        sourceRevision: 1,
      });
    if (name === 'projectWorkIndex:detail')
      return {
        generationId: 'g',
        revision: 1,
        value: JSON.stringify(item),
        editable: true,
        intentPin: null,
      };
    return query(ref, args);
  };
  s.exchange.client.action = async () => ({ revision: 6 });
  const starts = () => s.calls.filter(call => call.name === 'projectHostedStart:start');
  const reads = () => s.calls.filter(call => call.name === 'projectHostedLanes:select');
  return { s, item, starts, reads };
}

test('a follow-up start after the Issue landed opens a new Lane; a first start and an open Lane add no calls', async t => {
  const { s, item, starts, reads } = plannedStartFixture(t);
  const first = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.equal(reads().length, 0, 'a first start reads no Lane');
  assert.equal(first.result.previousLane, undefined);
  // The Lane is still open: the identical start is the idempotent retry and replays it.
  const retry = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.equal(retry.operationId, first.operationId);
  assert.equal(starts().length, 2);
  assert.equal(starts()[0].args.operationId, starts()[1].args.operationId);
  assert.equal(reads().length, 1, 'one Lane read decides the replay');
  assert.equal(retry.result.previousLane, undefined);
  // The Lane landed: the same start now opens a new Lane linked to the same Issue, and says so.
  s.lane.state = 'completed';
  const followUp = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.notEqual(followUp.operationId, first.operationId);
  assert.notEqual(starts()[2].args.operationId, starts()[0].args.operationId);
  assert.deepEqual(starts()[2].args.intent, starts()[0].args.intent, 'same Issue Intent');
  assert.equal(followUp.result.previousLane.laneId, s.lane.laneId);
  assert.equal(followUp.result.previousLane.state, 'completed');
  assert.match(followUp.result.previousLane.note, /completed; this opened a new Lane/);
  // Replaying the original operation explicitly still returns the original result.
  const replay = await s.transport().dispatch('start', {
    planningItemId: item.id,
    operationId: first.operationId,
  });
  assert.equal(replay.operationId, first.operationId);
  assert.equal(starts().at(-1).args.operationId, first.operationId);
  // The new Lane is itself replayable only while open.
  s.lane.state = 'active';
  const again = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.equal(again.operationId, followUp.operationId);
});

// Incident replay 20b91e86 (issue b6ba9219): two builders on one machine with one account and one clone
// root ran the identical `start {planningItemId}`; the second got the first builder's open Lane back.
test('incident replay 20b91e86: an identical start from another agent session opens its own Lane and lists the first', async t => {
  const { s, item, starts, reads } = plannedStartFixture(t);
  s.caps.openLanesVersion = 1;
  // Like the server: each start operation creates its own Lane and, when asked, lists the Issue's other open Lanes.
  const created = new Map(),
    mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const value = await mutation(ref, args);
    if (getFunctionName(ref) !== 'projectHostedStart:start') return value;
    if (!created.has(args.operationId))
      created.set(args.operationId, {
        laneId: randomUUID(),
        openLanes: [...created.values()].map(lane => ({
          laneId: lane.laneId,
          owner: 'builder',
          yours: true,
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        })),
      });
    const lane = created.get(args.operationId),
      result = JSON.parse(value);
    result.lane.laneId = lane.laneId;
    if (args.openLanesVersion === 1 && lane.openLanes.length) result.openLanes = lane.openLanes;
    return JSON.stringify(result);
  };
  const a = await s.transport('agent-a').dispatch('start', { planningItemId: item.id });
  const b = await s.transport('agent-b').dispatch('start', { planningItemId: item.id });
  assert.notEqual(b.operationId, a.operationId, "the second agent never replays the first agent's start");
  assert.notEqual(b.result.lane.laneId, a.result.lane.laneId);
  assert.equal(starts().length, 2);
  assert.equal(starts()[1].args.openLanesVersion, 1);
  assert.deepEqual(
    b.result.openLanes.map(lane => [lane.laneId, lane.owner]),
    [[a.result.lane.laneId, 'builder']],
    'the second agent sees the first Lane in its reply',
  );
  assert.equal(reads().length, 0, 'a first start in each session reads no Lane');
  // The lost-reply retry in the same session still returns its own Lane and opens none.
  for (const [session, original] of [
    ['agent-a', a],
    ['agent-b', b],
  ]) {
    const retry = await s.transport(session).dispatch('start', { planningItemId: item.id });
    assert.equal(retry.operationId, original.operationId);
    assert.equal(retry.result.lane.laneId, original.result.lane.laneId);
    assert.equal(retry.result.previousLane, undefined);
  }
  assert.equal(created.size, 2, 'retries opened no Lane');
  // With no session id, an open Lane another process started is never replayed: a new Lane, and why.
  const anonymous = await s.transport(null).dispatch('start', { planningItemId: item.id });
  const again = await s.transport(null).dispatch('start', { planningItemId: item.id });
  assert.notEqual(again.operationId, anonymous.operationId);
  assert.equal(again.result.previousLane.laneId, anonymous.result.lane.laneId);
  assert.match(again.result.previousLane.note, /No agent session id/);
  assert.equal(again.result.previousLane.unscoped, undefined);
  assert.equal(reads().length, 2, 'only the two same-session retries read their Lane state');
});

test('start reads the local registry first and skips the Lane read when this machine saw the Lane end', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { recordLane } = await import('../dist/lane-registry.js');
  const state = mkdtempSync(join(tmpdir(), 'forge-registry-')),
    prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(state, { recursive: true, force: true });
  });
  const { s, item, reads } = plannedStartFixture(t);
  const first = await s.transport().dispatch('start', { planningItemId: item.id });
  recordLane({ laneId: s.lane.laneId, root: s.root, state: 'abandoned' });
  const followUp = await s.transport().dispatch('start', { planningItemId: item.id });
  assert.notEqual(followUp.operationId, first.operationId);
  assert.equal(followUp.result.previousLane.state, 'abandoned');
  assert.equal(reads().length, 0);
});

test('Issue filing returns candidates without another call and retries retain the original candidate page', async t => {
  const s = await setup(t),
    p = port(s);
  const prior = (
    await put(p, {
      kind: 'issue',
      title: 'Sync worker diagnostics',
      body: 'retain failure cause',
    })
  ).result;
  p.calls.length = 0;
  const input = { kind: 'issue', title: 'Sync failure diagnostics' };
  const filed = await put(p, input);
  assert(filed.result.likelyDuplicates.items.some(item => item.id === prior.itemId));
  assert.deepEqual(p.calls, ['projectWorkIndex:workspace', 'projectWorkActions:command']);
  await s.send(s.item({ title: 'Sync failure diagnostics' }));
  const replay = await run(p, 'put-planning-item', input, filed.operationId);
  assert.deepEqual(replay.result.likelyDuplicates, filed.result.likelyDuplicates);
});

test('CLI planning search forwards one query and summaries need no per-item detail reads', async t => {
  const s = await setup(t),
    p = port(s);
  await put(p, {
    kind: 'issue',
    title: 'Searchable sync',
    body: 'Done when: verified',
  });
  p.calls.length = 0;
  const found = await list(p, { search: 'sync' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].initiativeId, null);
  assert.equal(found.items[0].hasDoneWhen, true);
  assert.deepEqual(p.calls, ['projectHostedPlanningSearch:search']);
});

test('released planning servers keep filing available and name missing search coverage', async t => {
  const s = await setup(t),
    p = port(s);
  const query = p.query;
  p.query = (name, args) => {
    if ('planningDuplicateText' in args)
      throw new Error('ArgumentValidationError: Object contains extra field `planningDuplicateText`');
    if (name === 'projectHostedPlanningSearch:search')
      throw new Error('Could not find public function for projectHostedPlanningSearch:search');
    return query(name, args);
  };
  const filed = await put(p, { kind: 'issue', title: 'Compatible filing' });
  assert.equal(filed.result.version, 1);
  assert.equal(filed.result.likelyDuplicates.coverage, 'unavailable-server-upgrade-required');
  await assert.rejects(list(p, { search: 'Compatible' }), code('HOSTED_ACTION_UNSUPPORTED'));
});

test('hosted planning CLI reads and writes from an explicitly addressed non-Git folder', async t => {
  const s = await setup(t),
    current = transport(s, { planning: true });
  const { mkdirSync, existsSync } = await import('node:fs');
  const { hostedAgentAddress, hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
  mkdirSync(current.p.root);
  const address = hostedAgentAddress(current.p.root, current.p.address);
  const created = await hostedAgentCli(
    current.p.root,
    'put-planning-item',
    { kind: 'issue', title: 'No Git planning' },
    address,
    current.transport,
  );
  const read = await hostedAgentCli(
    current.p.root,
    'planning',
    { reconcile: false },
    address,
    current.transport,
  );
  assert(read.result.items.some(item => item.id === created.result.itemId));
  assert.equal(existsSync(join(current.p.root, '.git')), false);
  assert.equal(existsSync(join(current.p.root, '.forge')), false);
});
