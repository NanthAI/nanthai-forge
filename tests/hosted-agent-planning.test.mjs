// SPDX-License-Identifier: Apache-2.0
import { meterReads } from './hosted-read-set.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import {
  executeHostedPlanning,
  plannedIntent,
  markPlanningStarted,
  planningDataNotice,
} from '../dist/hosted-agent-planning.js';
import { hostedAgentCommandSchemas, hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import { z } from 'zod';
import { ConvexError } from 'convex/values';
import { ForgeError } from '../dist/errors.js';
import { namedPaths, suggestSchedule } from '../dist/work-schedule.js';
import { speedBudgets } from '../dist/speed-budgets.js';
import { judgeCosts } from '../dist/cost-budgets.js';

/** Judge planning write costs against the ledger (src/speed-budgets.json, flip 5): any rise fails. */
const withinLedger = measured =>
  assert.deepEqual(
    judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'planning-fixture', measured)
      .filter(v => v.metric in measured && v.status !== 'pass')
      .map(v => v.message),
    [],
  );

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const actionsV8 = await import(moduleUrl('../convex/projectWorkActionsV8.ts'));
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const planningModule = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The agent's port over the real Convex handlers; Intent states are the one stub (tested with
 * the Convex lanes fixture). Counts every Convex call the agent makes. The real handlers keep
 * omitted put fields, so the port advertises that by default, as the transport does after discovery. */
function port(s, states = new Map(), serverFeatures = [...hostedContractFeatures]) {
  const searches = installPlanningSearch(s);
  const calls = [],
    frictions = new Map();
  let intercept;
  const invoke = async (name, args) => {
    calls.push(name);
    // The friction record lookup (6d815aa9) is stubbed; its own query is tested with the friction handlers.
    if (name === 'projectHostedFriction:lookup')
      return JSON.stringify(
        frictions.has(args.id) ? { found: true, ...frictions.get(args.id) } : { found: false },
      );
    if (name === 'projectHostedPlanning:intentStates')
      return JSON.stringify(
        Object.fromEntries(args.ids.filter(id => states.has(id)).map(id => [id, states.get(id)])),
      );
    const [module, fn] = name.split(':');
    if (name === 'projectWorkActionsV8:command' && intercept) await intercept(args);
    const handler = {
      projectWorkIndex: index,
      projectWorkActions: actions,
      projectWorkActionsV8: actionsV8,
      projectWorkCommand: commands,
      projectHostedPlanningSearch: search,
      projectHostedPlanning: planningModule,
    }[module][fn];
    const value = await handler._handler(s.ctx, args);
    // A server before flip 5 S4 (no planning-put-mutation) still sends the live revision on its workspace.
    if (
      name === 'projectWorkIndex:workspace' &&
      value &&
      !result.serverFeatures.includes('planning-put-mutation')
    ) {
      const revision = await index.revision._handler(s.ctx, { projectId: args.projectId });
      return JSON.stringify({ ...JSON.parse(value), revision });
    }
    return value;
  };
  const reference = ref => getFunctionName(ref);
  const result = {
    calls,
    searches,
    states,
    frictions,
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
    mutation: async (name, args) => {
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
  // That server predates the revision-free put (flip 5 S5) too.
  p.serverFeatures = p.serverFeatures.filter(name => name !== 'planning-put-mutation');
  const seen = [];
  p.intercept(async args => {
    const command = JSON.parse(args.command);
    seen.push(command);
    if (command.action !== 'put-planning-item') return;
    const parsed = previousServerPut.safeParse(command);
    if (!parsed.success)
      throw new ConvexError({
        code: 'BAD_ARGUMENT',
        message: 'Invalid planning command.',
      });
    args.command = JSON.stringify({
      ...parsed.data,
      initiativeId: parsed.data.initiativeId ?? null,
    });
  });
  return seen;
}
const run = (p, action, input, operationId) =>
  executeHostedPlanning(p, 'owner', action, hostedAgentCommandSchemas[action].parse(input), operationId);
const put = (p, input) => run(p, 'put-planning-item', input);
const list = (p, input = {}) => run(p, 'planning', input).then(response => response.result);

test('a server without the V8 command receives the same original operation on the Node command', async t => {
  const s = await setup(t),
    p = port(
      s,
      new Map(),
      hostedContractFeatures.filter(name => name !== 'planning-put-mutation'),
    );
  const invoke = p.exchange.client.action;
  const names = [];
  p.exchange.client.action = async (ref, args) => {
    names.push(getFunctionName(ref));
    if (getFunctionName(ref) === 'projectWorkActionsV8:command')
      throw new Error(
        '[Request ID: x] Server Error Could not find public function for projectWorkActionsV8:command',
      );
    return invoke(ref, args);
  };
  const operationId = randomUUID();
  const created = (
    await run(p, 'put-planning-item', { kind: 'issue', title: 'Older server', status: 'open' }, operationId)
  ).result;
  assert.equal(created.version, 1);
  assert.deepEqual(
    names.filter(name => name.includes(':command')),
    ['projectWorkActionsV8:command', 'projectWorkActions:command'],
  );
  // A refusal from a server that does have the function is not retried elsewhere.
  names.length = 0;
  p.exchange.client.action = async (ref, args) => {
    names.push(getFunctionName(ref));
    throw new ConvexError({
      code: 'WORK_STALE',
      message: 'Hosted Work changed.',
    });
  };
  await assert.rejects(put(p, { kind: 'issue', title: 'Refused', status: 'open' }));
  assert.equal(names.filter(name => name.includes(':command')).length >= 1, true);
  assert(!names.includes('projectWorkActions:command'));
});

// Flip 5 S0: 21 of 55 retried planning writes were comments refused by an unrelated write moving the
// project revision. A comment now reads no revision: one mutation, and a replay keeps one comment.
test('an agent comment is one revision-free mutation and its replay adds no second comment (flip 5 S0)', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Discussed' })).result;
  p.calls.length = 0;
  const operationId = randomUUID();
  const first = await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'Why' }, operationId);
  assert.deepEqual(p.calls, ['projectWorkCommand:command']);
  withinLedger({ planningCommentCalls: p.calls.length });
  // An unrelated write moves the project revision; the replay still reconciles to the original.
  await put(p, { kind: 'issue', title: 'Unrelated' });
  const again = await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'Why' }, operationId);
  assert.deepEqual(again, first);
  assert.equal(first.result.commentId, operationId);
  const read = await list(p, { id: issue.itemId, reconcile: false });
  assert.deepEqual(
    read.comments.map(comment => comment.text),
    ['Why'],
  );
});

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

// Issue aa9fb5b1 part 3: a suggested schedule from the files each Issue names. Advice only.
test('the files an Issue names group open Issues into stacks and parallel work, with reasons', () => {
  assert.deepEqual(
    namedPaths(
      'Fix src/a.ts:12-30 and `convex/b.ts`; see https://example.com/c/d.ts, docs/x.md, `forge.json`, Node.js and ./src/a.ts again.',
    ),
    ['src/a.ts', 'convex/b.ts', 'docs/x.md', 'forge.json'],
  );
  const issue = (id, status, at, ...paths) => ({ id, title: id, status, at, paths });
  const schedule = suggestSchedule(
    [
      issue('old', 'open', '2026-01-01', 'src/a.ts'),
      issue('busy', 'in-progress', '2026-01-03', 'src/a.ts', 'docs/status.md'),
      issue('docs', 'open', '2026-01-02', 'docs/status.md'),
      issue('alone', 'open', '2026-01-02', 'src/c.ts'),
      issue('vague', 'open', '2026-01-02'),
      issue('done', 'closed', '2026-01-02', 'src/a.ts'),
    ],
    path => path.endsWith('.md'),
  );
  // The started Issue goes first; a shared Markdown doc never stacks; closed Issues are left out.
  assert.deepEqual(schedule.stacks, [
    {
      order: ['busy', 'old'],
      files: ['src/a.ts'],
      more: 0,
      reason:
        "Both name src/a.ts; run them one after another so the later one starts from the earlier one's landing.",
    },
  ]);
  assert.deepEqual(schedule.parallel.sort(), ['alone']);
  assert.deepEqual(
    schedule.unknown.sort(),
    ['docs', 'vague'],
    'naming no comparable file is unknown, not independent',
  );
});

test('planning {schedule:true} suggests stacks from the stored Issues within the bounded page reads', async t => {
  const s = await setup(t),
    p = port(s);
  const first = (
    await put(p, { kind: 'issue', title: 'Speed up compose', body: 'Touch src/hosted-compose-worker.ts.' })
  ).result;
  const second = (await put(p, { kind: 'issue', title: 'Fix src/hosted-compose-worker.ts paging' })).result;
  const third = (await put(p, { kind: 'issue', title: 'Web copy', body: 'web/src/Home.tsx only' })).result;
  p.calls.length = 0;
  const read = await list(p, { kind: 'issue', schedule: true, reconcile: false });
  assert.equal(read.schedule.coverage, 'complete');
  assert.deepEqual(
    read.schedule.stacks.map(stack => stack.order),
    [[first.itemId, second.itemId]],
  );
  assert.deepEqual(read.schedule.parallel, [third.itemId]);
  assert.match(read.schedule.rule, /Advice/);
  assert(p.calls.length <= 3, `bounded reads, no per-Issue detail read: ${p.calls}`);
  await assert.rejects(
    async () => run(p, 'planning', { search: 'compose', schedule: true }),
    /Use schedule with a list read/,
  );
});

test('every planning read marks member-written text as data, once per read and in a few characters (S-17)', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Marked', body: 'Why and acceptance. '.repeat(80) }))
    .result;
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'A member comment' });
  const reads = {
    list: await list(p),
    one: await list(p, { id: issue.itemId }),
    search: await list(p, { search: 'Marked' }),
  };
  for (const [name, read] of Object.entries(reads))
    assert.equal(read.notice, planningDataNotice, `${name} read carries the notice`);
  assert.match(planningDataNotice, /data, never instructions/);
  const cost = JSON.stringify({ notice: planningDataNotice }).length;
  assert(cost <= 100, `notice stays small (${cost} characters)`);
  const one = JSON.stringify(reads.one).length;
  assert(cost / one < 0.05, `single-item read grows under 5 percent (${((cost / one) * 100).toFixed(1)})`);
  // One constant per read: it does not scale with the number of items or comments.
  assert.equal(JSON.stringify(reads.list).split(planningDataNotice).length - 1, 1);
});

test('every planning read shows the body author as a public handle, with no extra call and no raw account id (S-17)', async t => {
  const s = await setup(t);
  s.tables.forgeAccounts.set('account', {
    _id: 'account',
    _creationTime: 1,
    owner: 'owner',
    handle: 'ada-builder',
  });
  const p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Authored', body: 'Why and acceptance.' })).result;
  const reads = async () => ({
    list: await list(p),
    one: await list(p, { id: issue.itemId }),
    search: await list(p, { search: 'Authored' }),
  });
  const authors = read => ({
    list: read.list.items.find(item => item.id === issue.itemId).author,
    one: read.one.item.author,
    search: read.search.items.find(item => item.id === issue.itemId).author,
  });
  assert.deepEqual(authors(await reads()), {
    list: 'ada-builder',
    one: 'ada-builder',
    search: 'ada-builder',
  });
  // A move that keeps the body keeps the author; the account id never appears in any read.
  await put(p, { itemId: issue.itemId, expectedVersion: 1, status: 'proposed' });
  const after = await reads();
  assert.deepEqual(authors(after), { list: 'ada-builder', one: 'ada-builder', search: 'ada-builder' });
  assert.equal(after.one.item.version, 2);
  assert.doesNotMatch(JSON.stringify(after), /"author":"owner"|\\"author\\":\\"owner/);
  // The author is on the row already: the list read makes the same calls as before the field existed
  // (workspace, one records page, Intent states), and a one-item read adds none.
  p.calls.length = 0;
  await list(p);
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:records',
    'projectHostedPlanning:intentStates',
  ]);
  // Token cost per item: the handle adds one short field.
  const item = JSON.stringify(after.list.items.find(entry => entry.id === issue.itemId));
  const field = JSON.stringify({ author: 'ada-builder' });
  assert(field.length / item.length < 0.15, `author field is ${field.length} of ${item.length} characters`);
  // Anything that is not handle-shaped is dropped before an agent sees it, whatever the server sent.
  const rawId = 'user_AbCdEf123456';
  const raw = value => JSON.parse(JSON.stringify(value).replaceAll('ada-builder', rawId));
  const wrapped = {
    ...p,
    exchange: { client: { query: async (ref, args) => raw(await p.exchange.client.query(ref, args)) } },
    query: async (name, args) => raw(await p.query(name, args)),
  };
  const leaked = {
    list: await list(wrapped),
    one: await list(wrapped, { id: issue.itemId }),
    search: await list(wrapped, { search: 'Authored' }),
  };
  assert.doesNotMatch(JSON.stringify(leaked), /user_AbCdEf123456/);
  assert.equal(leaked.one.item.author, undefined);
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
  // Flip 5 S5: one revision-free mutation, no workspace read first.
  assert.deepEqual(p.calls, ['projectWorkCommand:command']);
  withinLedger({ planningPutCalls: p.calls.length });
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
    (
      await put(seed, {
        kind: 'issue',
        title,
        body,
        status: 'proposed',
        initiativeId: initiative,
      })
    ).result.itemId;
  const stored = async id => (await list(seed, { id, reconcile: false })).item;

  // The gap the Issue describes: a CLI that assumes the new semantics against the previous server.
  const assuming = port(s);
  previousServer(assuming);
  const wiped = await created('Assumed');
  await assert.rejects(
    put(assuming, { itemId: wiped, expectedVersion: 1, status: 'open' }),
    code('BAD_ARGUMENT'),
  );
  await put(assuming, {
    itemId: wiped,
    expectedVersion: 1,
    kind: 'issue',
    title: 'Assumed',
    status: 'open',
  });
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
  const moved = await put(p, {
    itemId: issue,
    expectedVersion: 1,
    status: 'open',
    reason: 'triaged',
  });
  assert.equal(moved.result.status, 'open');
  // One detail read more than the new server, on this path only.
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:detail',
    'projectWorkIndex:workspace',
    'projectWorkActionsV8:command',
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
  await assert.rejects(put(p, { itemId: issue, expectedVersion: 2, status: 'closed' }), code('ITEM_CHANGED'));
  assert.equal(sent.length, before);
  // Start and reconcile already hold the stored item: same calls as on the new server, body kept.
  const started = await created('Started');
  p.calls.length = 0;
  assert.equal((await markPlanningStarted(p, started, randomUUID())).updated, true);
  assert.deepEqual(p.calls, [
    'projectWorkIndex:workspace',
    'projectWorkIndex:detail',
    'projectWorkIndex:workspace',
    'projectWorkActionsV8:command',
  ]);
  item = await stored(started);
  assert.deepEqual([item.status, item.body, item.initiativeId], ['in-progress', body, initiative]);
  // Creating needs no stored read.
  p.calls.length = 0;
  await put(p, { kind: 'issue', title: 'New', initiativeId: null });
  assert.deepEqual(p.calls, ['projectWorkIndex:workspace', 'projectWorkActionsV8:command']);
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

test('on a server before planning-put-mutation a repeated operation replays, a lost reply reconciles, and a stale Work revision retries', async t => {
  const s = await setup(t),
    p = port(
      s,
      new Map(),
      hostedContractFeatures.filter(name => name !== 'planning-put-mutation'),
    );
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
    // The hold wrote its marker once (version + 1) after the comment.
    expectedVersion: unmet.version + 1,
    title: 'Unmet',
    body: body(['x', 'x', 'x']),
    status: 'open',
  });
  const after = await list(p);
  assert.equal(after.items.find(item => item.id === unmet.itemId).status, 'closed');
  assert.equal(after.reconciled.held, undefined);
});

test('a completed Intent holds an Issue with unticked or untickable Done-when lines, comments once, and a replay adds nothing (8b4bfd78)', async t => {
  const s = await setup(t),
    p = port(s);
  const bodies = {
    boxes: 'Why\n\nDone when:\n- [x] a\n- [ ] b\n1. [ ] c',
    bullets:
      'Core-claim incident.\n\nDone when:\n- the root cause is fixed;\n- the live queue drains;\n\nOwner: x.',
    prose: 'Intro\n\n**Done when**\nThe budget is met on both harnesses.\n\nFits Phase 6.',
    allTicked: 'Done when:\n- [x] a\n- [X] b',
    none: 'Just words, no section',
  };
  const ids = {};
  for (const [name, body] of Object.entries(bodies))
    ids[name] = (await put(p, { kind: 'issue', title: name, body })).result.itemId;
  for (const id of Object.values(ids)) p.states.set(id, 'completed');
  const read = await list(p);
  const status = Object.fromEntries(
    Object.entries(ids).map(([n, id]) => [n, read.items.find(i => i.id === id).status]),
  );
  assert.deepEqual(status, {
    boxes: 'open',
    bullets: 'open',
    prose: 'open',
    allTicked: 'closed',
    none: 'closed',
  });
  assert.deepEqual(Object.fromEntries(read.reconciled.held.map(h => [h.id, h.openLines])), {
    [ids.boxes]: 2,
    [ids.bullets]: 2,
    [ids.prose]: 1,
  });
  const commentsOf = async id => (await list(p, { id, reconcile: false })).comments.map(c => c.text);
  for (const name of ['boxes', 'bullets', 'prose']) {
    const comments = await commentsOf(ids[name]);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /^Intent completed; \d Done-when line\(s\) still open/);
  }
  assert.deepEqual(await commentsOf(ids.allTicked), []);
  // The end state is clear (d56dfe49 replay): the comment and the held entry name the open lines and the
  // one close command with the version the reason write leaves behind; ticked lines are not listed.
  const boxesItem = (await list(p, { id: ids.boxes, reconcile: false })).item;
  const boxesComment = (await commentsOf(ids.boxes))[0];
  assert.match(boxesComment, /Open: "b"; "c"\./);
  assert(!boxesComment.includes('"a"'));
  assert(
    boxesComment.includes(
      `put-planning-item '{"itemId":"${ids.boxes}","expectedVersion":${boxesItem.version},"status":"closed"`,
    ),
  );
  const heldBoxes = read.reconciled.held.find(h => h.id === ids.boxes);
  assert.deepEqual(heldBoxes.lines, ['b', 'c']);
  assert.match(heldBoxes.close, /"expectedVersion":\d+,"status":"closed"/);
  assert.match(
    (await commentsOf(ids.bullets))[0],
    /Open: "the root cause is fixed;"; "the live queue drains;"\./,
  );
  assert.match((await commentsOf(ids.prose))[0], /Open: "The budget is met on both harnesses\."/);
  // Replays and later reads: still held, no second comment, no further write (reads only).
  p.calls.length = 0;
  const again = await list(p);
  assert.equal(again.reconciled.held.length, 3);
  assert(!p.calls.some(name => name.includes(':command')));
  for (const name of ['boxes', 'bullets', 'prose']) assert.equal((await commentsOf(ids[name])).length, 1);
  // A person's explicit close stays allowed.
  const held = await list(p, { id: ids.bullets, reconcile: false });
  await put(p, {
    itemId: ids.bullets,
    expectedVersion: held.item.version,
    status: 'closed',
    reason: 'verified',
  });
  assert.equal((await list(p, { id: ids.bullets, reconcile: false })).item.status, 'closed');
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
  await assert.rejects(plannedIntent(p, closed), error => {
    assert.equal(error.code, 'INTENT_CLOSED');
    // The error names the one command that reopens it and the plain-outcome start (e4a71127).
    assert.match(error.message, /put-planning-item/);
    assert.match(error.message, new RegExp(`"itemId":"${closed}"`));
    assert.deepEqual(error.recovery.reopen.input.status, 'open');
    assert.equal(error.recovery.reopen.input.expectedVersion, 1);
    assert.equal(error.recovery.plainStart.input.outcome, 'Finished');
    return true;
  });
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
  const p = port(s, new Map(), features || []),
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

test('a paused or refused agent write keeps structured retryable and retryAt in the CLI error (72d50375)', async t => {
  const s = await setup(t);
  const { p, transport: agent } = transport(s, { planning: true });
  const at = Date.now() + 10 * 60_000;
  const invoke = p.exchange.client.action;
  p.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':command'))
      throw new ConvexError({
        code: 'LEGACY_STORAGE_WRITES_PAUSED',
        message: 'Dev writes are temporarily paused for approved storage maintenance.',
        retryAt: at,
      });
    return invoke(ref, args);
  };
  const operationId = randomUUID();
  await assert.rejects(
    agent.dispatch('put-planning-item', { kind: 'issue', title: 'During a pause', operationId }),
    error => {
      assert.equal(error.code, 'LEGACY_STORAGE_WRITES_PAUSED');
      assert.equal(error.retryAt, at);
      assert.deepEqual(error.recovery, { retryable: true, retryAt: new Date(at).toISOString() });
      assert.match(error.message, /nothing was changed/);
      assert.match(
        error.message,
        new RegExp(`after ${new Date(at).toISOString()} \\(operation ${operationId}\\)`),
      );
      return true;
    },
  );
  // A platform 503 refusal (Retry-After past the in-process wait) is reported, not slept
  // through: its continuation keeps the retry fields and the refusal evidence.
  p.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':command'))
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'Command returned HTTP 503.', at, {
        httpStatus: 503,
        outcome: 'refused',
      });
    return invoke(ref, args);
  };
  const pending = await agent.dispatch('put-planning-item', {
    kind: 'issue',
    title: 'During an outage',
    operationId: randomUUID(),
  });
  assert.equal(pending.result.phase, 'transport');
  assert.deepEqual(pending.result.error.recovery, {
    httpStatus: 503,
    outcome: 'refused',
    retryable: true,
    retryAt: new Date(at).toISOString(),
  });
  // An unknown outcome is not called refused and gains no retry claim here.
  p.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':command'))
      throw new ConvexError({ code: 'WORK_STALE', message: 'Hosted Work changed.' });
    return invoke(ref, args);
  };
  await assert.rejects(
    agent.dispatch('put-planning-item', { kind: 'issue', title: 'Stale', operationId: randomUUID() }),
    error => error.code === 'WORK_STALE' && error.recovery === undefined,
  );
});

test('new CLI vs previous server through the transport: the capability read drops only `features`, and a status-only put keeps the body (a83b6fd5)', async t => {
  const s = await setup(t);
  const body = 'Body that must survive';
  const created = await transport(s, {
    planning: true,
    features: ['planning-put-keeps-omitted'],
  }).transport.dispatch('put-planning-item', {
    kind: 'issue',
    title: 'Gap',
    body,
  });
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
  const read = await old.transport.dispatch('planning', {
    id: itemId,
    reconcile: false,
  });
  assert.deepEqual([read.result.item.body, read.result.item.status], [body, 'open']);
  // Current server: it advertises the feature, so the put names only what changes, in one read.
  const current = transport(s, {
    planning: true,
    features: ['planning-put-keeps-omitted'],
  });
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
    (
      await current.transport.dispatch('planning', {
        id: itemId,
        reconcile: false,
      })
    ).result.item.body,
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
    assert.equal(getFunctionName(ref), 'projectWorkActionsV8:command');
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

// e4a71127: an open Issue whose first Intent landed starts a follow-up Intent (the server answers with a
// different Intent id); the start says so, and the Issue (full or short id) is still marked in progress.
test('a start on an Issue whose earlier Intent landed reports the follow-up Intent and marks the Issue in progress', async t => {
  const { s, item, starts } = plannedStartFixture(t);
  const followId = randomUUID(),
    mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const value = await mutation(ref, args);
    if (getFunctionName(ref) !== 'projectHostedStart:start') return value;
    return JSON.stringify({ ...JSON.parse(value), intentId: followId });
  };
  s.exchange.client.query = (
    query => async (ref, args) =>
      getFunctionName(ref) === 'projectHostedPlanning:resolveId'
        ? JSON.stringify({ ids: [item.id], more: false })
        : query(ref, args)
  )(s.exchange.client.query);
  const writes = [];
  s.exchange.client.action = async (ref, args) => (writes.push(args.command), { revision: 6 });
  const started = await s.transport().dispatch('start', { planningItemId: item.id.slice(0, 8) });
  assert.equal(starts().length, 1);
  assert.equal(starts()[0].args.intent.intentId, item.id, 'the start asks for the Issue, not the follow-up');
  assert.equal(started.result.intentId, followId);
  assert.equal(started.result.continued.issueId, item.id);
  assert.equal(started.result.continued.intentId, followId);
  assert.match(started.result.continued.note, /continues Issue/);
  // The Issue (resolved from its short id, not the follow-up Intent id) moves to in-progress.
  assert.equal(started.result.planning.updated, true);
  assert.equal(JSON.parse(writes.at(-1)).itemId, item.id);
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

// Follow-up 3676f3e1: native subagents of one client share its session id. No per-subagent identity
// is exposed to the CLI, so the client process narrows the scope: two processes with one session id
// open their own Lanes, and a same-process retry (another shell of that client) still replays.
test('two client processes sharing one session id each get their own Lane; a same-process retry replays', async t => {
  const { s, item, starts } = plannedStartFixture(t);
  const created = new Map(),
    mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const value = await mutation(ref, args);
    if (getFunctionName(ref) !== 'projectHostedStart:start') return value;
    if (!created.has(args.operationId)) created.set(args.operationId, randomUUID());
    const result = JSON.parse(value);
    result.lane.laneId = created.get(args.operationId);
    return JSON.stringify(result);
  };
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'shared-client-session';
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous;
  });
  // The session id comes from the environment (agentSession undefined); the process is detected or declared.
  const process_ = agentProcess => Object.assign(s.transport(), { agentSession: undefined, agentProcess });
  const a = await process_('100@Thu Nov  5 10:00:00 2026').dispatch('start', {
    planningItemId: item.id,
  });
  const b = await process_('200@Thu Nov  5 10:00:01 2026').dispatch('start', {
    planningItemId: item.id,
  });
  assert.notEqual(b.operationId, a.operationId, 'another process never replays this start');
  assert.notEqual(b.result.lane.laneId, a.result.lane.laneId);
  assert.equal(starts().length, 2);
  for (const [client, original] of [
    ['100@Thu Nov  5 10:00:00 2026', a],
    ['200@Thu Nov  5 10:00:01 2026', b],
  ]) {
    const retry = await process_(client).dispatch('start', {
      planningItemId: item.id,
    });
    assert.equal(retry.operationId, original.operationId);
    assert.equal(retry.result.lane.laneId, original.result.lane.laneId);
  }
  assert.equal(created.size, 2, 'same-process retries opened no Lane');
  // No readable client process: the session id alone still scopes, as before.
  const c = await process_(null).dispatch('start', { planningItemId: item.id });
  const d = await process_(null).dispatch('start', { planningItemId: item.id });
  assert.equal(d.operationId, c.operationId);
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
  p.searches.length = 0;
  const input = { kind: 'issue', title: 'Sync failure diagnostics' };
  const filed = await put(p, input);
  assert(filed.result.likelyDuplicates.items.some(item => item.id === prior.itemId));
  // The duplicates read stays for a creation only; the put itself is one mutation (flip 5 S5).
  assert.deepEqual(p.calls, ['projectWorkIndex:workspace', 'projectWorkCommand:command']);
  // Each index search is billed at the whole search-index size (a02991a7): one per filing.
  withinLedger({ planningIndexSearches: p.searches.length });
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
  p.searches.length = 0;
  const found = await list(p, { search: 'sync' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].initiativeId, null);
  assert.equal(found.items[0].hasDoneWhen, true);
  assert.deepEqual(p.calls, ['projectHostedPlanningSearch:search']);
  // One billed index search per CLI search; no per-result search (a02991a7).
  withinLedger({ planningIndexSearches: p.searches.length });
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

test('a unique 8+ character id prefix resolves in the same call; full ids stay byte-for-byte unchanged and add no call (ce863deb)', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (
    await put(p, {
      kind: 'issue',
      title: 'Short ids',
      body: 'Done when:\n- [ ] x',
    })
  ).result;
  await run(p, 'comment-planning-item', {
    itemId: issue.itemId,
    text: 'first note',
  });
  p.calls.length = 0;
  const full = await list(p, { id: issue.itemId, reconcile: false });
  const fullCalls = [...p.calls];
  assert(!fullCalls.includes('projectHostedPlanning:resolveId'));
  p.calls.length = 0;
  const short = await list(p, {
    id: issue.itemId.slice(0, 8),
    reconcile: false,
  });
  assert.equal(JSON.stringify(short), JSON.stringify(full));
  assert.deepEqual(
    p.calls.filter(name => name !== 'projectHostedPlanning:resolveId'),
    fullCalls,
  );
  assert.equal(p.calls.filter(name => name === 'projectHostedPlanning:resolveId').length, 1);
  // Longer prefixes, with or without a dash, and upper case resolve too.
  for (const prefix of [
    issue.itemId.slice(0, 13),
    issue.itemId.slice(0, 12),
    issue.itemId.slice(0, 8).toUpperCase(),
  ])
    assert.equal((await list(p, { id: prefix, reconcile: false })).item.id, issue.itemId);
  // Writes resolve once, act on the full id and echo it.
  p.calls.length = 0;
  const commented = await run(p, 'comment-planning-item', {
    itemId: issue.itemId.slice(0, 8),
    text: 'by prefix',
  });
  assert.equal(commented.result.itemId, issue.itemId);
  assert.equal(p.calls.filter(name => name === 'projectHostedPlanning:resolveId').length, 1);
  const moved = await put(p, {
    itemId: issue.itemId.slice(0, 8),
    expectedVersion: 1,
    status: 'in-progress',
  });
  assert.equal(moved.result.itemId, issue.itemId);
  const after = await list(p, { id: issue.itemId, reconcile: false });
  assert.equal(after.item.status, 'in-progress');
  assert.deepEqual(
    after.comments.map(c => c.text),
    ['first note', 'by prefix'],
  );
  // A full-id write adds no resolve call.
  p.calls.length = 0;
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'full' });
  assert(!p.calls.includes('projectHostedPlanning:resolveId'));
  // Start from a prefix resolves the Issue and returns its full id as the Intent.
  const planned = await plannedIntent(p, issue.itemId.slice(0, 8));
  assert.equal(planned.intentId, issue.itemId);
});

test('an ambiguous prefix lists at most 5 full candidate ids; an unknown one is NOT_FOUND; creating needs a full id', async t => {
  const s = await setup(t),
    p = port(s);
  const ids = Array.from({ length: 7 }, (_, n) => `deadbeef-000${n}-4000-8000-000000000000`);
  for (const [n, itemId] of ids.entries()) await put(p, { itemId, kind: 'issue', title: `Twin ${n}` });
  await put(p, {
    itemId: 'deadbee0-0000-4000-8000-000000000000',
    kind: 'issue',
    title: 'Near miss',
  });
  const ambiguous = await list(p, { id: 'deadbeef', reconcile: false }).catch(error => error);
  assert.equal(ambiguous.code, 'AMBIGUOUS_ID');
  assert.deepEqual(ambiguous.recovery.candidates, ids.slice(0, 5));
  for (const id of ids.slice(0, 5)) assert.match(ambiguous.message, new RegExp(id));
  assert.doesNotMatch(ambiguous.message, new RegExp(ids[5]));
  // Writes refuse the same way and write nothing.
  await assert.rejects(
    run(p, 'comment-planning-item', { itemId: 'deadbeef', text: 'x' }),
    error => error.code === 'AMBIGUOUS_ID',
  );
  await assert.rejects(
    put(p, { itemId: 'deadbeef', expectedVersion: 1, status: 'closed' }),
    error => error.code === 'AMBIGUOUS_ID',
  );
  // Two candidates are listed in full and a longer prefix picks one.
  assert.equal((await list(p, { id: ids[3].slice(0, 13), reconcile: false })).item.id, ids[3]);
  assert.equal((await list(p, { id: 'deadbee0', reconcile: false })).item.title, 'Near miss');
  await assert.rejects(list(p, { id: 'cafebabe', reconcile: false }), code('NOT_FOUND'));
  await assert.rejects(
    put(p, {
      itemId: 'cafebabe',
      expectedVersion: 0,
      kind: 'issue',
      title: 'new',
    }),
    code('BAD_ARGUMENT'),
  );
});

test('a prefix shorter than 8 characters or not hex is refused by the schema before any call; every planning id field takes the same shape', async t => {
  const s = await setup(t),
    p = port(s);
  for (const bad of ['deadbee', 'deadbeeg', '', 'dead-beef', 'deadbeef--00', 'x'.repeat(40)]) {
    for (const [action, field] of [
      ['planning', 'id'],
      ['comment-planning-item', 'itemId'],
      ['put-planning-item', 'itemId'],
      ['start', 'planningItemId'],
    ]) {
      const extra = action === 'comment-planning-item' ? { text: 'x' } : {};
      const result = hostedAgentCommandSchemas[action].safeParse({
        [field]: bad,
        ...extra,
      });
      assert.equal(result.success, false, `${action}.${field} ${JSON.stringify(bad)}`);
      assert.match(result.error.message, /at least 8 characters/);
    }
  }
  assert.deepEqual(p.calls, []);
  const full = randomUUID();
  for (const [action, field] of [
    ['planning', 'id'],
    ['put-planning-item', 'itemId'],
    ['start', 'planningItemId'],
  ])
    assert.equal(hostedAgentCommandSchemas[action].parse({ [field]: full })[field], full);
  assert.equal(
    hostedAgentCommandSchemas['comment-planning-item'].parse({
      itemId: 'deadbeef',
      text: 'x',
    }).itemId,
    'deadbeef',
  );
});

test('a server without resolveId answers a short id with a typed error that asks for the full id', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Old server' })).result;
  const query = p.query;
  p.query = (name, args) =>
    name === 'projectHostedPlanning:resolveId'
      ? Promise.reject(new Error(`Could not find public function for '${name}'`))
      : query(name, args);
  await assert.rejects(list(p, { id: issue.itemId.slice(0, 8) }), code('HOSTED_ACTION_UNSUPPORTED'));
  assert.equal((await list(p, { id: issue.itemId, reconcile: false })).item.id, issue.itemId);
});

// 6d815aa9: friction records take no comments; a comment on a friction id points at the Issue instead.
test('a comment on a friction id names the Issue it was triaged to; other failures keep their error', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Triaged home', body: 'x' })).result;
  const triaged = randomUUID(),
    untriaged = randomUUID(),
    unknown = randomUUID();
  p.frictions.set(triaged, { status: 'planned', planningItemId: issue.itemId });
  p.frictions.set(untriaged, { status: 'open' });
  await assert.rejects(
    run(p, 'comment-planning-item', { itemId: triaged, text: 'repeat evidence' }),
    error =>
      error.code === 'BAD_ARGUMENT' &&
      /friction record, not an Issue/.test(error.message) &&
      error.message.includes(`itemId ${issue.itemId}`),
  );
  await assert.rejects(
    run(p, 'comment-planning-item', { itemId: untriaged, text: 'repeat evidence' }),
    error => error.code === 'BAD_ARGUMENT' && /friction-triage/.test(error.message),
  );
  // Not a friction record either: the original NOT_FOUND stays.
  await assert.rejects(run(p, 'comment-planning-item', { itemId: unknown, text: 'x' }), code('NOT_FOUND'));
  // A healthy comment makes no friction lookup.
  p.calls.length = 0;
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'fine' });
  assert(!p.calls.includes('projectHostedFriction:lookup'));
});

test('filtered planning and one-read Initiative counts charge only matching rows on a 1500-item board (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const initiativeId = randomUUID();
  const statuses = ['open', 'open', 'proposed', 'in-progress', 'abandoned'];
  const items = Array.from({ length: 1500 }, (_, i) => ({
    id: randomUUID(),
    kind: 'issue',
    status: statuses[i] ?? 'closed',
    initiativeId: i < 397 ? initiativeId : randomUUID(),
    version: 1,
    previousVersion: 0,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    at: '2026-01-01T00:00:00.000Z',
    author: 'owner',
    provenance: 'user-declared-local',
    title: `Synthetic item ${String(i).padStart(4, '0')}`,
    body: 'Synthetic retained detail. '.repeat(40),
    intentIds: [],
  }));
  const add = async (item, position) => {
    for (const entry of indexedRecord('planningItems', item.id, '', position, item))
      await s.ctx.db.insert('projectPlanningRecords', { ...entry, projectId: s.projectId, generationId });
    await s.ctx.db.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'issue',
      key: item.id,
      version: 1,
      parent: item.initiativeId ?? '',
      status: item.status,
      recordId: 'retained-record',
      value: JSON.stringify(item),
    });
  };
  for (const [i, item] of items.entries()) await add(item, i);
  const meter = meterReads(s.ctx);
  const filter = { status: 'open', kind: 'issue', initiativeId, limit: 100, reconcile: false };
  const allPages = async (client, input) => {
    const items = [];
    let cursor = null;
    do {
      const page = await list(client, { ...input, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  const beforeClient = port(
    s,
    new Map(),
    p.serverFeatures.filter(f => f !== 'planning-filtered-reads'),
  );
  let beforeRows;
  const before = await meter.cost(async () => {
    beforeRows = await allPages(beforeClient, filter);
  });
  let afterRows;
  const after = await meter.cost(async () => {
    afterRows = await allPages(p, filter);
  });
  assert.deepEqual(afterRows, beforeRows);
  assert.equal(afterRows.length, 2);
  const expected = { proposed: 1, open: 2, 'in-progress': 1, abandoned: 1, closed: 392 };
  const beforeCount = await meter.cost(async () => {
    const rows = await allPages(beforeClient, { status: 'all', initiativeId, limit: 100, reconcile: false });
    assert.equal(rows.length, 397);
  });
  p.calls.length = 0;
  let counted;
  const count = await meter.cost(async () => {
    counted = await list(p, { counts: true, initiativeId });
  });
  assert.deepEqual(counted.counts, expected);
  assert.equal(counted.coverage, 'complete');
  assert.equal(counted.nextCursor, null);
  assert.deepEqual(p.calls, ['projectWorkIndex:records'], 'counts make one read and no reconcile writes');
  // Growth in closed items, including closed members of this Initiative, changes no filtered read bytes.
  for (let i = 0; i < 500; i++) await add({ ...items[100], id: randomUUID() }, 1500 + i);
  assert.deepEqual(await meter.cost(() => allPages(p, filter)), after);
  assert(speedBudgets.costs.some(entry => entry.metric === 'planningFilteredReadBytes'));
  assert(speedBudgets.costs.some(entry => entry.metric === 'planningCountsReadBytes'));
  withinLedger({ planningFilteredReadBytes: after.bytes, planningCountsReadBytes: count.bytes });
  t.diagnostic(
    JSON.stringify({
      board: 1500,
      closedGrowth: 500,
      filteredBefore: before,
      filteredAfter: after,
      countBefore: beforeCount,
      countAfter: count,
    }),
  );
});

test('indexed planning preserves all filter combinations, record-store bodies, paging and reconciliation (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s);
  const initiativeId = (await put(p, { kind: 'initiative', title: 'Group' })).result.itemId;
  const first = (await put(p, { kind: 'issue', title: 'First', initiativeId, body: 'Done when:\n- [x] Met' }))
    .result.itemId;
  await put(p, { kind: 'issue', title: 'Second', initiativeId });
  await put(p, { kind: 'issue', title: 'Elsewhere', status: 'closed' });
  const baseline = await list(p, { reconcile: false });
  for (const kind of [undefined, 'issue', 'initiative'])
    for (const status of [undefined, 'open', 'closed', 'all'])
      for (const group of [undefined, initiativeId]) {
        const input = {
          ...(kind ? { kind } : {}),
          ...(status ? { status } : {}),
          ...(group ? { initiativeId: group } : {}),
          limit: 1,
          reconcile: false,
        };
        const rows = [];
        let cursor = null;
        do {
          const page = await list(p, { ...input, cursor });
          rows.push(...page.items);
          cursor = page.nextCursor;
          if (cursor) assert.match(cursor, /^forge-planning-v1:/);
        } while (cursor);
        assert.deepEqual(
          rows,
          baseline.items.filter(
            item =>
              (!kind || item.kind === kind) &&
              (!status || status === 'all' || item.status === status) &&
              (!group || item.initiativeId === group),
          ),
        );
      }
  const generation = s.tables.projectWorkGenerations.get(
    s.tables.hostedProjects.get(s.projectId).work.generationId,
  );
  generation.planningSearchVersion = 1;
  assert.deepEqual(
    (await list(p, { kind: 'issue', status: 'open', initiativeId, reconcile: false })).items,
    baseline.items.filter(item => item.initiativeId === initiativeId),
  );
  assert.equal((await list(p, { counts: true, initiativeId })).coverage, 'partial-needs-preparation');
  generation.planningSearchVersion = 2;
  s.tables.hostedProjects.get(s.projectId).workStore = 'records';
  // Ordinary puts in dual/records mode retain exact row bodies, including long Done-when text.
  const long = 'x'.repeat(40000) + '\nDone when:\n- [ ] Evidence pending';
  await put(p, { itemId: first, expectedVersion: 1, body: long });
  p.states.set(first, 'completed');
  const read = await list(p, { kind: 'issue', status: 'open', initiativeId });
  assert.equal(read.items.find(item => item.id === first).bodyLength, long.length);
  assert.equal(read.items.find(item => item.id === first).status, 'open');
  assert.equal(read.reconciled.held[0].openLines, 1);
  await put(p, {
    itemId: first,
    expectedVersion: read.reconciled.held[0].version,
    body: 'Done when:\n- [x] Evidence met',
  });
  assert.equal(
    (await list(p, { kind: 'issue', status: 'open', initiativeId })).items.find(item => item.id === first)
      .status,
    'closed',
  );
  assert(
    !(await list(p, { kind: 'issue', status: 'open', initiativeId })).items.some(item => item.id === first),
  );
});

test('planning counts sum every page and refuse stale generations, invalid cursors and old servers (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s);
  const initiativeId = randomUUID();
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  for (let i = 0; i < 1001; i++) {
    const id = randomUUID();
    await s.ctx.db.insert('projectPlanningRecords', {
      projectId: s.projectId,
      generationId,
      collection: 'planningSearch',
      key: id,
      parent: '',
      position: i,
      value: '{}',
      planning: {
        text: '',
        kind: 'issue',
        status: i % 2 ? 'open' : 'closed',
        initiativeId,
        open: i % 2 === 1,
      },
    });
  }
  // Search payload fragments repeat metadata; counts include each root once.
  await s.ctx.db.insert('projectPlanningRecords', {
    projectId: s.projectId,
    generationId,
    collection: 'planningSearch:payload',
    key: 'fragment',
    parent: '',
    position: 0,
    value: '',
    planning: { text: 'fragment', kind: 'issue', status: 'closed', initiativeId, open: false },
  });
  const counted = await list(p, { counts: true, initiativeId });
  assert.deepEqual(counted.counts, { proposed: 0, open: 500, 'in-progress': 0, closed: 501, abandoned: 0 });
  assert.equal(counted.coverage, 'complete');
  assert.equal(counted.nextCursor, null);
  assert.equal(counted.next, undefined);
  assert.equal(p.calls.length, 2, 'one read per page, no workspace, reconciliation or per-item reads');
  await assert.rejects(list(p, { counts: true, cursor: 'bad' }), code('BAD_ARGUMENT'));
  const stale =
    'forge-planning-v1:' +
    Buffer.from(JSON.stringify({ cursor: null, generationId: 'different' })).toString('base64url');
  await assert.rejects(list(p, { counts: true, cursor: stale }), code('WORK_STALE'));

  const query = p.query;
  p.query = async (name, args) => {
    const result = await query(name, args);
    // A source publication replaces the generation between count pages.
    s.tables.hostedProjects.get(s.projectId).work.generationId = 'replaced';
    return result;
  };
  await assert.rejects(list(p, { counts: true, initiativeId }), code('WORK_STALE'));
  s.tables.hostedProjects.get(s.projectId).work.generationId = generationId;
  p.query = query;
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'outsider' });
  await assert.rejects(list(p, { counts: true, initiativeId }), code('PROJECT_UNAVAILABLE'));
  p.serverFeatures = [];
  await assert.rejects(list(p, { counts: true, initiativeId }), code('HOSTED_ACTION_UNSUPPORTED'));
});

test('planning count page cap labels incomplete totals and continues without losing or repeating rows (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s);
  const initiativeId = randomUUID();
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  for (let i = 0; i < 20001; i++)
    await s.ctx.db.insert('projectPlanningRecords', {
      projectId: s.projectId,
      generationId,
      collection: 'planningSearch',
      key: randomUUID(),
      parent: '',
      position: i,
      value: '{}',
      planning: { text: '', kind: 'issue', status: 'closed', initiativeId, open: false },
    });
  const first = await list(p, { counts: true, initiativeId });
  assert.equal(first.coverage, 'partial');
  assert.equal(first.counts.closed, 20000);
  assert.match(first.nextCursor, /^forge-planning-v1:/);
  assert.match(first.next, /counts are incomplete after 20 pages/);
  assert.match(first.next, /same filters and nextCursor as cursor/);
  assert.match(first.next, /add the returned counts/);
  assert.equal(p.calls.length, 20, 'bounded to 20 records reads and no writes');
  const last = await list(p, { counts: true, initiativeId, cursor: first.nextCursor });
  assert.equal(first.counts.closed + last.counts.closed, 20001);
  assert.equal(last.coverage, 'complete');
  assert.equal(last.nextCursor, null);
  assert.equal(last.next, undefined);
});
