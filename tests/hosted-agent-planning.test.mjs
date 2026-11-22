// SPDX-License-Identifier: Apache-2.0
import { meterReads } from './hosted-read-set.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { assertCommandWeight } from '../scripts/agent-weight.mjs';
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
import { capabilityOptions } from '../dist/hosted-capabilities-early.js';
import { hostedAgentCommandSchemas, hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedContractFeatures,
  MAX_CONTRACT_FEATURES,
  planningInitiativeCountsFeature,
  planningHistoryFeature,
  planningWaitingFeature,
} from '../dist/hosted-contract-features.js';
import { printedReceipt } from '../dist/receipt-slim.js';
import { planningIssueArguments } from '../dist/planning-issue-arguments.js';
import { z } from 'zod';
import { ConvexError } from 'convex/values';
import { ForgeError } from '../dist/errors.js';
import { namedPaths, suggestSchedule } from '../dist/work-schedule.js';
import { speedBudgets } from '../dist/speed-budgets.js';
import { judgeCosts } from '../dist/cost-budgets.js';
import { checkArgs } from './convex-args.mjs';
import { withTeaching } from '../dist/error-teaching.js';
import { helpTopicText } from '../dist/help-topics.js';
import { hostedWorkCli } from '../dist/hosted-work-cli.js';
import { hostedWorkRequestSchema } from '../dist/hosted-work-client.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';

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
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const planningBatch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const { move, startMoveOperationId } = await import(moduleUrl('../convex/projectPlanningStart.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The agent's port over the real Convex handlers; Intent states are the one stub (tested with
 * the Convex lanes fixture). Counts every Convex call the agent makes. The real handlers keep
 * omitted put fields, so the port advertises that by default, as the transport does after discovery. */
function port(
  s,
  states = new Map(),
  serverFeatures = [...hostedContractFeatures, planningInitiativeCountsFeature],
  realIntentStates = false,
) {
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
    // The single-Item read takes its Intent state from the Item work read (1c2ab97a); stubbed like intentStates.
    if (name === 'projectItemWork:read' && realIntentStates) return itemWork.read._handler(s.ctx, args);
    if (name === 'projectItemWork:read') {
      const intent = states.get(args.itemId) ?? null;
      return JSON.stringify({
        role: true,
        intent,
        intents: 1,
        lanes: [],
        total: 0,
        atLeast: false,
        nextCursor: null,
      });
    }
    if (name === 'projectHostedPlanning:intentStates' && realIntentStates)
      return planningModule.intentStates._handler(s.ctx, args);
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
      projectPlanningBatch: planningBatch,
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
        mutation: (ref, args) => invoke(reference(ref), args),
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

test('the Closed view status list returns both Done and dropped Items, including in ranked search', async t => {
  const s = await setup(t);
  const p = port(s);
  for (const status of ['open', 'closed', 'abandoned', 'archived', 'deleted']) {
    const row = s.item({ title: `Parser fixture ${status}` });
    await s.send(row);
    if (status !== 'open')
      await s.send(s.item({ itemId: row.itemId, expectedVersion: 1, status, title: row.title }));
  }
  for (const search of [undefined, 'parser']) {
    const result = await list(p, { status: ['closed', 'abandoned'], search, reconcile: false });
    assert.deepEqual(result.items.map(item => item.status).sort(), ['abandoned', 'closed']);
  }
  const first = await list(p, { status: ['closed', 'abandoned'], search: 'parser', limit: 1 });
  assert.ok(first.nextCursor);
  await assert.rejects(
    list(p, { status: ['open', 'closed'], search: 'parser', limit: 1, cursor: first.nextCursor }),
    code('WORK_STALE'),
  );
  const more = await list(p, {
    status: ['abandoned', 'closed'],
    search: 'parser',
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.ok(more.items.every(item => item.status === 'closed' || item.status === 'abandoned'));
});

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

// 593fc2d7: a reviewer's run ended while its GO/NO-GO comment command was still running, and the
// verdict was lost (seen twice on 2026-11-20). The comment is kept on the machine before any call, and
// one a killed process left is posted once by the next planning read.
test('593fc2d7: a comment whose run ended mid-write is posted once by the next planning read', async t => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const state = mkdtempSync(join(tmpdir(), 'forge-outbox-')),
    previous = process.env.XDG_STATE_HOME,
    previousName = process.env.FORGE_AGENT_NAME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    if (previousName === undefined) delete process.env.FORGE_AGENT_NAME;
    else process.env.FORGE_AGENT_NAME = previousName;
    rmSync(state, { recursive: true, force: true });
  });
  const outbox = join(state, 'forge', 'comment-outbox');
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Reviewed' })).result;
  // The write is on disk before the server is called, and gone once the call ends.
  const mutation = p.mutation;
  let kept;
  p.mutation = async (name, args) => {
    kept = readdirSync(outbox).map(name => JSON.parse(readFileSync(join(outbox, name), 'utf8')));
    return mutation(name, args);
  };
  const verdict = 'Opus review of Lane 00000000@00000000: GO';
  const operationId = randomUUID();
  // The reviewer writes; a builder on another model later posts what the reviewer left.
  const reviewer = { agent: 'quiet-fox', agentClient: 'claude-code:reviewer-model' };
  p.commentAgent = () => reviewer;
  process.env.FORGE_AGENT_NAME = 'Reviewer';
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: verdict }, operationId);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].operationId, operationId);
  assert.equal(kept[0].input.text, verdict);
  assert.deepEqual(kept[0].author, { authorLabel: 'Reviewer', ...reviewer });
  assert.deepEqual(readdirSync(outbox), [], 'a finished write leaves nothing behind');
  // A run killed mid-write leaves its entry, with a process that no longer exists.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const lost = {
    ...kept[0],
    operationId: randomUUID(),
    pid: dead,
    input: { ...kept[0].input, text: `${verdict} (lost)` },
  };
  writeFileSync(join(outbox, `${lost.operationId}.json`), JSON.stringify(lost));
  // One from a process still running is its own: left alone.
  const live = { ...lost, operationId: randomUUID(), pid: process.pid };
  writeFileSync(join(outbox, `${live.operationId}.json`), JSON.stringify(live));
  const sent = [];
  p.mutation = async (name, args) => {
    sent.push(JSON.stringify(args));
    return mutation(name, args);
  };
  p.commentAgent = () => ({ agent: 'busy-owl', agentClient: 'claude-code:builder-model' });
  process.env.FORGE_AGENT_NAME = 'Builder';
  const read = await list(p, { id: issue.itemId, reconcile: false });
  assert.deepEqual(read.recoveredComments, [{ itemId: issue.itemId, commentId: lost.operationId }]);
  assert.deepEqual(readdirSync(outbox), [`${live.operationId}.json`]);
  const again = await list(p, { id: issue.itemId, reconcile: false });
  assert.equal(again.recoveredComments, undefined);
  assert.deepEqual(
    again.comments.map(comment => comment.text),
    [verdict, `${verdict} (lost)`],
    'each verdict once',
  );
  // Posted under the run that wrote it, not the run that posted it.
  const write = sent
    .map(args => JSON.parse(JSON.parse(args).command ?? '{}'))
    .find(c => c.text?.endsWith('(lost)'));
  assert.deepEqual(
    { authorLabel: write.authorLabel, agent: write.agent, agentClient: write.agentClient },
    { authorLabel: 'Reviewer', ...reviewer },
  );
  // A passing refusal (rate limit) keeps the entry for the next read; a temp file a cut write left
  // is dropped once it is a day old.
  const limited = {
    ...lost,
    operationId: randomUUID(),
    input: { ...lost.input, text: `${verdict} (limited)` },
  };
  writeFileSync(join(outbox, `${limited.operationId}.json`), JSON.stringify(limited));
  const cut = join(outbox, `${randomUUID()}.json.1.tmp`);
  writeFileSync(cut, '{');
  const { utimesSync } = await import('node:fs');
  utimesSync(cut, new Date(Date.now() - 25 * 3_600_000), new Date(Date.now() - 25 * 3_600_000));
  p.mutation = async () => {
    throw new ForgeError('RATE_LIMITED', 'Slow down.');
  };
  const refused = await list(p, { id: issue.itemId, reconcile: false });
  assert.equal(refused.recoveredComments, undefined);
  assert.deepEqual(
    readdirSync(outbox).sort(),
    [`${limited.operationId}.json`, `${live.operationId}.json`].sort(),
  );
  p.mutation = mutation;
  assert.deepEqual((await list(p, { id: issue.itemId, reconcile: false })).recoveredComments, [
    { itemId: issue.itemId, commentId: limited.operationId },
  ]);
  // One write the server keeps refusing does not hold back newer ones: it stays, the next is posted.
  const stuck = {
    ...lost,
    operationId: randomUUID(),
    at: Date.now() - 60_000,
    input: { ...lost.input, text: 'stuck' },
  };
  const fresh = {
    ...lost,
    operationId: randomUUID(),
    at: Date.now(),
    input: { ...lost.input, text: 'fresh' },
  };
  for (const entry of [stuck, fresh])
    writeFileSync(join(outbox, `${entry.operationId}.json`), JSON.stringify(entry));
  const recent = join(outbox, `${randomUUID()}.json.1.tmp`);
  writeFileSync(recent, '{');
  p.mutation = async (name, args) => {
    if (JSON.stringify(args).includes('stuck')) throw new ForgeError('HOSTED_ACTION_FAILED', 'Try again.');
    return mutation(name, args);
  };
  assert.deepEqual((await list(p, { id: issue.itemId, reconcile: false })).recoveredComments, [
    { itemId: issue.itemId, commentId: fresh.operationId },
  ]);
  assert.deepEqual(
    readdirSync(outbox).sort(),
    [`${stuck.operationId}.json`, `${live.operationId}.json`, recent.split('/').pop()].sort(),
    'the refused write and a temp file under a day old stay',
  );
  // A refused write backs off between reads: five of them fill one read's five resends, then wait, so
  // the next read posts the newer comment behind them and resends none of them.
  const readEntry = entry => JSON.parse(readFileSync(join(outbox, `${entry.operationId}.json`), 'utf8'));
  assert.equal(readEntry(stuck).refused, 1);
  rmSync(join(outbox, `${stuck.operationId}.json`));
  const stuckFive = Array.from({ length: 5 }, (_, index) => ({
    ...lost,
    operationId: randomUUID(),
    at: Date.now() - 60_000 + index,
    input: { ...lost.input, text: `stuck ${index}` },
  }));
  const behind = {
    ...lost,
    operationId: randomUUID(),
    at: Date.now(),
    input: { ...lost.input, text: 'behind' },
  };
  for (const entry of [...stuckFive, behind])
    writeFileSync(join(outbox, `${entry.operationId}.json`), JSON.stringify(entry));
  let stuckSends = 0;
  p.mutation = async (name, args) => {
    if (JSON.stringify(args).includes('stuck')) {
      stuckSends++;
      throw new ForgeError('HOSTED_ACTION_FAILED', 'Try again.');
    }
    return mutation(name, args);
  };
  assert.equal((await list(p, { id: issue.itemId, reconcile: false })).recoveredComments, undefined);
  assert.equal(stuckSends, 5, 'the five oldest fill this read');
  assert.ok(
    stuckFive.every(entry => readEntry(entry).nextAt > Date.now()),
    'each refused write waits',
  );
  stuckSends = 0;
  assert.deepEqual((await list(p, { id: issue.itemId, reconcile: false })).recoveredComments, [
    { itemId: issue.itemId, commentId: behind.operationId },
  ]);
  assert.equal(stuckSends, 0, 'a waiting write is not resent on every read');
  // Once its wait is over, a refused write is resent and posts when the server takes it.
  p.mutation = mutation;
  const due = readEntry(stuckFive[0]);
  writeFileSync(join(outbox, `${due.operationId}.json`), JSON.stringify({ ...due, nextAt: Date.now() - 1 }));
  assert.deepEqual((await list(p, { id: issue.itemId, reconcile: false })).recoveredComments, [
    { itemId: issue.itemId, commentId: due.operationId },
  ]);
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

test('a planning detail past 50 comments continues with commentsCursor, one bounded page per call, every comment once (f0d0fdd6)', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Many comments', body: 'Body' })).result;
  const other = (await put(p, { kind: 'issue', title: 'Other', body: 'Body' })).result;
  for (let i = 0; i < 60; i++)
    await run(p, 'comment-planning-item', { itemId: issue.itemId, text: `comment ${i}` });
  const detail = await list(p, { id: issue.itemId, reconcile: false });
  assert.equal(detail.comments.length, 50);
  assert.equal(detail.commentsMore, true);
  assert.equal(detail.comments.at(-1).text, 'comment 59', 'the detail keeps the newest 50, oldest first');
  p.calls.length = 0;
  const older = await list(p, { id: issue.itemId, cursor: detail.commentsCursor });
  assert(p.calls.filter(name => name === 'projectWorkIndex:records').length === 1, `one page: ${p.calls}`);
  assert(p.calls.length <= 2, `bounded continuation, no item or work read: ${p.calls}`);
  assert.equal(older.commentsMore, undefined);
  assert.deepEqual(
    [...older.comments, ...detail.comments].map(comment => comment.text),
    Array.from({ length: 60 }, (_, i) => `comment ${i}`),
  );
  // The cursor names its Item: another Item's id or a list cursor is refused.
  await assert.rejects(list(p, { id: other.itemId, cursor: detail.commentsCursor }), code('BAD_ARGUMENT'));
  const page = await list(p, { limit: 1 });
  await assert.rejects(list(p, { id: issue.itemId, cursor: page.nextCursor }), code('BAD_ARGUMENT'));
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

test('a start keeps an archived Item archived and a deleted Item deleted: no status write, the reply says how to bring it back (4c9e961e)', async t => {
  const s = await setup(t),
    p = port(s);
  for (const [shelf, from] of [
    ['archived', 'open'],
    ['deleted', 'proposed'],
  ]) {
    const id = (await put(p, { kind: 'issue', title: `On the ${shelf} shelf`, status: from })).result.itemId;
    const before = (await list(p, { id, reconcile: false })).item;
    await put(p, { itemId: id, expectedVersion: before.version, status: shelf });
    const events = s.tables.projectWorkEvents.size;
    const startOperation = randomUUID();
    // With a claim offered: the shelf check runs before the claim, so nobody becomes the owner of a shelved Item.
    const marked = await markPlanningStarted(p, id, startOperation, 'synthetic-owner/amber-fox');
    assert.deepEqual(marked, {
      updated: false,
      status: shelf,
      note: `Still ${shelf}: a start does not bring it back. To show it again, put status "${from}" on it (Unarchive or Restore).`,
    });
    // A replay of the same start is the same no-op.
    assert.deepEqual(await markPlanningStarted(p, id, startOperation, 'synthetic-owner/amber-fox'), marked);
    assert.equal(s.tables.projectWorkEvents.size, events, `${shelf}: nothing written`);
    const item = (await list(p, { id, reconcile: false })).item;
    assert.deepEqual(
      [item.status, item.was, item.version, item.owner],
      [shelf, from, before.version + 1, undefined],
    );
  }
});

test('builders claim the Item they start (d3357f40): an unowned Item takes the starter’s public identity once; a set owner is kept', async t => {
  const s = await setup(t),
    p = port(s);
  const issue = (await put(p, { kind: 'issue', title: 'Nobody owns it' })).result.itemId;
  const first = await markPlanningStarted(p, issue, randomUUID(), 'synthetic-owner/amber-fox');
  assert.deepEqual(first, {
    updated: true,
    status: 'in-progress',
    version: 2,
    owner: '@synthetic-owner/amber-fox',
  });
  assert.equal((await list(p, { id: issue })).item.owner, '@synthetic-owner/amber-fox');
  // A second builder on the same Item keeps the first one's claim, and writes nothing.
  const events = s.tables.projectWorkEvents.size;
  assert.deepEqual(await markPlanningStarted(p, issue, randomUUID(), 'synthetic-owner/ocean-moth'), {
    updated: false,
    status: 'in-progress',
  });
  assert.equal(s.tables.projectWorkEvents.size, events);
  assert.equal((await list(p, { id: issue })).item.owner, '@synthetic-owner/amber-fox');

  // Already in progress with no owner (started before claims existed): one write sets the owner, once.
  const running = (await put(p, { kind: 'issue', title: 'Running, unowned', status: 'in-progress' })).result
    .itemId;
  assert.equal(
    (await markPlanningStarted(p, running, randomUUID(), 'synthetic-owner')).owner,
    '@synthetic-owner',
  );
  assert.equal((await markPlanningStarted(p, running, randomUUID(), 'synthetic-owner')).updated, false);

  // Only a public identity is ever stored: an unmapped account id or a name claims nothing.
  for (const claim of ['user_2AbCdEf', 'Ada Lovelace', 'synthetic-owner/../x', undefined]) {
    const item = (await put(p, { kind: 'issue', title: `Unclaimed ${claim}` })).result.itemId;
    const marked = await markPlanningStarted(p, item, randomUUID(), claim);
    assert.equal(marked.updated, true);
    assert.equal(marked.owner, undefined, String(claim));
    assert.equal((await list(p, { id: item })).item.owner ?? null, null, String(claim));
  }
  // A member who cannot edit the plan (planning writes are the project owner's) starts an Item already in progress:
  // the claim is refused, and the start reports nothing to act on (review 3f84a176). An Item not yet in progress
  // still reports its failed status write, as before.
  const refused = {
    ...p,
    serverFeatures: [...new Set([...p.serverFeatures, 'planning-put-mutation'])],
    mutation: async () => {
      throw new ConvexError({
        code: 'PROJECT_UNAVAILABLE',
        message: 'Project planning is available to its current owner.',
      });
    },
  };
  const theirs = (await put(p, { kind: 'issue', title: 'Started by a contributor', status: 'in-progress' }))
    .result.itemId;
  assert.deepEqual(await markPlanningStarted(refused, theirs, randomUUID(), 'synthetic-owner/amber-fox'), {
    updated: false,
    status: 'in-progress',
    claimed: false,
  });
  assert.equal((await list(p, { id: theirs })).item.owner ?? null, null);
  // An open Item: the member's own write is refused quietly, and the server moves it to in progress after the start
  // (convex/projectPlanningStart.ts, scheduled by the start; lead 2026-11-19). It claims nothing.
  const open = (await put(p, { kind: 'issue', title: 'Open, contributor start' })).result.itemId;
  const startOperationId = randomUUID();
  assert.deepEqual(await markPlanningStarted(refused, open, startOperationId, 'synthetic-owner/amber-fox'), {
    updated: false,
    status: 'in-progress',
    movedBy: 'server',
    claimed: false,
  });
  const serverMove = (itemId, id = startOperationId) =>
    move._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      itemId,
      actor: 'member',
      startOperationId: id,
    });
  await serverMove(open);
  const moved = (await list(p, { id: open, reconcile: false })).item;
  assert.equal(moved.status, 'in-progress');
  assert.equal(moved.owner ?? null, null, 'the server move claims nothing');
  // Once only: a retried move, or a later start's, writes nothing more.
  const writes = s.tables.projectWorkEvents.size;
  await serverMove(open);
  await serverMove(open, randomUUID());
  assert.equal(s.tables.projectWorkEvents.size, writes);
  // A closed Item, or one that does not exist, is never moved.
  const closed = (await put(p, { kind: 'issue', title: 'Done already', status: 'closed' })).result.itemId;
  const before = s.tables.projectWorkEvents.size;
  await serverMove(closed, randomUUID());
  await serverMove(randomUUID(), randomUUID());
  assert.equal((await list(p, { id: closed, reconcile: false })).item.status, 'closed');
  assert.equal(s.tables.projectWorkEvents.size, before);
  // A proposed Item stays proposed for a member: the start says it waits for the owner (lead 2026-11-19).
  const proposal = (await put(p, { kind: 'issue', title: 'Proposed, contributor start', status: 'proposed' }))
    .result.itemId;
  assert.deepEqual(await markPlanningStarted(refused, proposal, randomUUID(), 'synthetic-owner/amber-fox'), {
    updated: false,
    status: 'proposed',
    claimed: false,
    waitsFor: 'owner',
    note: 'Still proposed: it shows as in progress once the project owner approves it.',
  });
  // A server that does not move it (older, without planning-start-move): the refusal is reported as before.
  const unmoved = {
    ...refused,
    serverFeatures: refused.serverFeatures.filter(name => name !== 'planning-start-move'),
  };
  const before4 = (await put(p, { kind: 'issue', title: 'Open, older server' })).result.itemId;
  const reported = await markPlanningStarted(unmoved, before4, randomUUID(), 'synthetic-owner/amber-fox');
  assert.equal(reported.updated, false);
  assert.equal(reported.movedBy, undefined);
  assert.equal(reported.error?.code, 'PROJECT_UNAVAILABLE');
  // The proposed reply is that server's too: an older server moves a proposed Item, so the refusal is reported.
  const proposedOld = (await put(p, { kind: 'issue', title: 'Proposed, older server', status: 'proposed' }))
    .result.itemId;
  const proposedReported = await markPlanningStarted(unmoved, proposedOld, randomUUID(), 'synthetic-owner');
  assert.equal(proposedReported.waitsFor, undefined);
  assert.equal(proposedReported.error?.code, 'PROJECT_UNAVAILABLE');
  // Only the owner-only refusal is quiet: any other PROJECT_UNAVAILABLE (for example an owner's write refused for
  // another reason, which schedules no server move) is reported, for an open and a proposed Item alike.
  const otherRefusal = {
    ...refused,
    mutation: async () => {
      throw new ConvexError({
        code: 'PROJECT_UNAVAILABLE',
        message: 'Project is unavailable with the current account.',
      });
    },
  };
  for (const status of ['open', 'proposed']) {
    const id = (await put(p, { kind: 'issue', title: `Other refusal, ${status}`, status })).result.itemId;
    const result = await markPlanningStarted(otherRefusal, id, randomUUID(), 'synthetic-owner');
    assert.equal(result.movedBy, undefined, status);
    assert.equal(result.waitsFor, undefined, status);
    assert.equal(result.error?.code, 'PROJECT_UNAVAILABLE', status);
  }
  // The server moves an open Issue only: a member's start of a closed or abandoned Issue, or of an Initiative, is
  // reported, not shown as moved.
  for (const fields of [
    { kind: 'issue', status: 'closed' },
    { kind: 'issue', status: 'abandoned' },
    { kind: 'initiative' },
  ]) {
    const id = (await put(p, { ...fields, title: `Not moved ${JSON.stringify(fields)}` })).result.itemId;
    const result = await markPlanningStarted(refused, id, randomUUID(), 'synthetic-owner');
    assert.equal(result.movedBy, undefined, JSON.stringify(fields));
    assert.equal(result.error?.code, 'PROJECT_UNAVAILABLE', JSON.stringify(fields));
  }
  // Any other failure of the status write is still reported.
  const broken = {
    ...refused,
    mutation: async () => {
      throw new ConvexError({ code: 'WORK_STALE', message: 'Hosted Work changed.' });
    },
  };
  const other = (await put(p, { kind: 'issue', title: 'Open, failed write' })).result.itemId;
  const failed = await markPlanningStarted(broken, other, randomUUID(), 'synthetic-owner/amber-fox');
  assert.equal(failed.updated, false);
  assert.ok(failed.error, 'a failed status write is still reported');
  // A server without the planning model would drop the field, so nothing is claimed there.
  const old = { ...p, serverFeatures: p.serverFeatures.filter(name => name !== 'planning-model') };
  const legacy = (await put(p, { kind: 'issue', title: 'Old server' })).result.itemId;
  assert.equal((await markPlanningStarted(old, legacy, randomUUID(), 'synthetic-owner')).owner, undefined);
});

// Review 76a40609 of the server move (receipt f0893386): only an open Issue of this project moves, as the current
// owner, once per start and caller; an Item the owner edits meanwhile is read again, not dropped.
test('the server move after a member start: open Issues only, this project, the current owner, and a racing edit', async t => {
  const s = await setup(t),
    p = port(s);
  const serverMove = (itemId, input = {}) =>
    move._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      itemId,
      actor: 'member',
      startOperationId: randomUUID(),
      ...input,
    });
  const status = async id => (await list(p, { id, reconcile: false })).item.status;
  const events = () => s.tables.projectWorkEvents.size;
  // Proposed waits for the owner; abandoned stays; Archived and Deleted stay on their shelf (4c9e961e); an Initiative
  // (any kind but issue) never moves.
  const proposed = (await put(p, { kind: 'issue', title: 'Proposed', status: 'proposed' })).result.itemId;
  const abandoned = (await put(p, { kind: 'issue', title: 'Dropped', status: 'abandoned' })).result.itemId;
  // An Item is created first, then shelved (a new Item cannot start Archived or Deleted).
  const shelve = async (title, shelf) => {
    const id = (await put(p, { kind: 'issue', title })).result.itemId;
    await put(p, { itemId: id, expectedVersion: 1, status: shelf });
    return id;
  };
  const archived = await shelve('Archived', 'archived');
  const deleted = await shelve('Deleted', 'deleted');
  const initiative = (await put(p, { kind: 'initiative', title: 'Group' })).result.itemId;
  const before = events();
  for (const id of [proposed, abandoned, archived, deleted, initiative]) await serverMove(id);
  assert.deepEqual(
    [
      await status(proposed),
      await status(abandoned),
      await status(archived),
      await status(deleted),
      await status(initiative),
    ],
    ['proposed', 'abandoned', 'archived', 'deleted', 'open'],
  );
  assert.equal(events(), before, 'nothing written');
  // An Item of another project: the lookup is scoped to the start's project, so nothing there is found or written.
  const issue = (await put(p, { kind: 'issue', title: 'Open here' })).result.itemId;
  s.tables.hostedProjects.set('other', {
    ...s.tables.hostedProjects.get(s.projectId),
    _id: 'other',
    key: randomUUID(),
  });
  await serverMove(issue, { projectId: 'other' }).catch(() => undefined);
  assert.equal(await status(issue), 'open');
  assert.equal(events(), before + 1, 'only the put above');
  // The owner changed before the action ran: the write as the old owner is refused, and the Item stays open.
  const owner = s.tables.hostedProjects.get(s.projectId).owner;
  s.tables.hostedProjects.get(s.projectId).owner = 'new-owner';
  await assert.rejects(serverMove(issue), /unavailable with the current account/);
  s.tables.hostedProjects.get(s.projectId).owner = owner;
  assert.equal(await status(issue), 'open');
  // The owner edits the Item between the action's lookup and its write (ITEM_CHANGED): the action reads it again and
  // moves it, keeping the edit.
  const query = s.ctx.runQuery;
  const racing = async (id, edit) => {
    let raced = false;
    s.ctx.runQuery = async (ref, args) => {
      const result = await query(ref, args);
      if (!raced && getFunctionName(ref) === 'projectWorkIndexStore:lookups') {
        raced = true;
        const item = (await list(p, { id, reconcile: false })).item;
        await put(p, { itemId: id, expectedVersion: item.version, ...edit });
      }
      return result;
    };
    try {
      await serverMove(id);
    } finally {
      s.ctx.runQuery = query;
    }
    assert.equal(raced, true);
    return (await list(p, { id, reconcile: false })).item;
  };
  const moved = await racing(issue, { title: 'Edited meanwhile' });
  assert.deepEqual([moved.status, moved.title], ['in-progress', 'Edited meanwhile']);
  // The owner changes the status meanwhile (closes, archives or deletes it, or sends it back to proposed): the
  // read-again sees it, and the move writes nothing over the owner's choice.
  for (const status of ['closed', 'proposed', 'archived', 'deleted']) {
    const id = (await put(p, { kind: 'issue', title: `Raced to ${status}` })).result.itemId;
    const raced = await racing(id, { status });
    assert.equal(raced.status, status);
    assert.equal(raced.version, 2, `${status}: only the owner's edit`);
  }
  // A move scheduled by a server deployed before the actor was passed still validates, and moves the Item.
  const early = (await put(p, { kind: 'issue', title: 'Scheduled before the deploy' })).result.itemId;
  const earlyArgs = { projectId: s.projectId, owner: 'owner', itemId: early, startOperationId: randomUUID() };
  checkArgs(move, earlyArgs, 'projectPlanningStart:move');
  await move._handler(s.ctx, earlyArgs);
  assert.equal(await status(early), 'in-progress');
  // The operation id names the project, the Item and the caller, not only the start's id.
  const base = { projectId: 'project', itemId: issue, actor: 'member', startOperationId: randomUUID() };
  const ids = new Set(
    [
      base,
      { ...base, projectId: 'other' },
      { ...base, itemId: randomUUID() },
      { ...base, actor: 'other-member' },
      { ...base, startOperationId: randomUUID() },
    ].map(startMoveOperationId),
  );
  assert.equal(ids.size, 5);
  assert.equal(startMoveOperationId(base), startMoveOperationId({ ...base }), 'stable across retries');
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

test('a fresh hosted project with no selected index reports an exact repair for planning and the first put', async t => {
  const s = await setup(t, true, undefined, false);
  const { transport: agent } = transport(s, { planning: true, features: hostedContractFeatures });
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, config, call) {
          tools.set(name, call);
        },
      },
      agent,
    ),
  );
  const rebuild = `nforge hosted-work https://fixture.invalid ${s.projectId} '{"action":"rebuild-index"}'`;
  const first = { kind: 'issue', title: 'First Item', status: 'proposed', operationId: randomUUID() };
  for (const [action, fields] of [
    ['planning', { status: 'open' }],
    ['put-planning-item', first],
  ]) {
    await assert.rejects(agent.dispatch(action, fields), error => {
      assert.equal(error.code, 'PROJECT_WORK_INDEX_MISSING');
      assert.equal(withTeaching(error, { surface: 'cli', root: agent.root }).next, rebuild);
      return true;
    });
    const mcp = await tools.get('forge_planning')({ command: { action, ...fields } });
    assert(mcp.isError);
    assert.equal(JSON.parse(mcp.content[0].text).error.next, rebuild);
  }
  const output = [];
  const write = t.mock.method(process.stdout, 'write', chunk => {
    output.push(chunk);
    return true;
  });
  await hostedWorkCli(['--help']);
  write.mock.restore();
  const helpRequest = JSON.parse(/nforge hosted-work ROOT '([^']+)'/.exec(output.join(''))[1]);
  const request = JSON.parse(/'([^']+)'/.exec(rebuild)[1]);
  assert.deepEqual(helpRequest, request);
  assert(helpTopicText('storage').includes(`nforge hosted-work ROOT '${JSON.stringify(request)}'`));
  assert.deepEqual(hostedWorkRequestSchema.parse(request), { action: 'rebuild-index' });

  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.equal((await agent.dispatch('put-planning-item', first)).result.version, 1);
});

test('the empty Plan points CLI and MCP agents to a working first proposal', async t => {
  const s = await setup(t);
  const p = port(s);
  const active = { status: 'active', reconcile: false };
  const empty = await list(p, active);
  assert.deepEqual(empty.items, []);
  assert.match(empty.next, /nforge agent ROOT put-planning-item.*MCP forge_planning/);
  const input = JSON.parse(empty.next.match(/\{.*\}/)[0].replace('TITLE', 'First Item'));
  const { result: created } = await put(p, input);
  const proposed = await list(p, active);
  assert.equal(proposed.items[0].id, created.itemId);
  assert.equal(proposed.items[0].status, 'proposed');
  assert.equal(proposed.next, undefined);
  const filtered = await list(p, { status: 'open', reconcile: false });
  assert.deepEqual(filtered.items, []);
  assert.equal(filtered.next, undefined);
});

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

// Item d9e1ac62 (real case: Item 1dd4e095): a start beside an open resolution Lane and the open Lane it resolves names
// both and the one abandon command, as advice only; it asks for the field only from a server that offers it.
test('d9e1ac62: start names the Lane an open resolution Lane replaces, with the abandon command, and keeps it compact', async t => {
  const origin = randomUUID(),
    resolution = randomUUID();
  for (const offered of [false, true]) {
    const { s, item, starts } = plannedStartFixture(t);
    s.caps.openLanesVersion = 1;
    if (offered) s.caps.features = ['start-open-lanes-resolves'];
    const mutation = s.exchange.client.mutation;
    s.exchange.client.mutation = async (ref, args) => {
      const value = await mutation(ref, args);
      if (getFunctionName(ref) !== 'projectHostedStart:start') return value;
      const result = JSON.parse(value);
      // Like the server: `resolves` only for version 2.
      result.openLanes = [
        { laneId: resolution, owner: 'lead', yours: true, lastActivityAt: '2026-01-01T00:00:00.000Z' },
        { laneId: origin, owner: 'lead', yours: true, lastActivityAt: '2026-01-01T00:00:00.000Z' },
      ];
      if (args.openLanesVersion === 2) result.openLanes[0].resolves = origin;
      return JSON.stringify(result);
    };
    const started = await s.transport('agent-a').dispatch('start', { planningItemId: item.id });
    assert.equal(starts()[0].args.openLanesVersion, offered ? 2 : 1);
    if (!offered) {
      assert.equal(started.result.replaced, undefined, 'an older server: no hint, nothing guessed');
      continue;
    }
    const hint = {
      laneId: origin,
      replacedBy: resolution,
      note: `Lane ${origin} continues in its resolution Lane ${resolution}. Once its work is confirmed there, abandon it.`,
      next: `nforge agent ROOT abandon {"laneId":"${origin}","reason":"Replaced by Lane ${resolution}"}`,
    };
    assert.deepEqual(started.result.replaced, [hint]);
    assert.equal(s.calls.filter(call => call.name.endsWith(':abandon')).length, 0, 'advice only');
    const printed = printedReceipt(started, { agent: true, detail: false, landChild: false });
    assert.deepEqual(printed.result.replaced, [hint], 'the compact reply keeps the hint');
  }
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
  const previousExplicit = process.env.FORGE_AGENT_SESSION;
  process.env.CLAUDE_CODE_SESSION_ID = 'shared-client-session';
  process.env.FORGE_AGENT_SESSION = 'shared-client-session';
  t.after(() => {
    if (previousExplicit === undefined) delete process.env.FORGE_AGENT_SESSION;
    else process.env.FORGE_AGENT_SESSION = previousExplicit;
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

test('an agent comment from the CLI carries the model its session declared, single and in a batch (Item 2fb69177)', async t => {
  const s = await setup(t),
    p = port(s);
  // A device sign-in, as the CLI uses; the server keeps a declared model only beside a device's agent slug.
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'credential-1',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
    scope: 'cli',
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'credential-1' });
  p.commentAgent = () => ({ agent: 'keen-impala', agentClient: 'claude-code:synthetic-model-1' });
  const issue = (await put(p, { kind: 'issue', title: 'Bylines', body: 'Done when:\n- [ ] x' })).result;
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'single' });
  await put(p, {
    batch: [{ action: 'comment-planning-item', itemId: issue.itemId, text: 'batched' }],
  });
  // A session that declared no model still reads as an agent, with "model not declared".
  p.commentAgent = () => ({ agent: 'amber-fox' });
  await run(p, 'comment-planning-item', { itemId: issue.itemId, text: 'undeclared' });
  const rows = Object.fromEntries(
    (await list(p, { id: issue.itemId, reconcile: false })).comments.map(row => [row.text, row]),
  );
  for (const text of ['single', 'batched']) {
    assert.equal(rows[text].agent, 'keen-impala', text);
    assert.equal(
      rows[text].agentClient,
      'claude-code:synthetic-model-1',
      `${text}: the declared model is stored`,
    );
  }
  assert.equal(rows.undeclared.agent, 'amber-fox');
  assert.equal(rows.undeclared.agentClient, undefined);
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

const planCounterRow = (s, generationId) =>
  [...s.tables.projectWorkDataRecords.values()].find(
    row => row.generationId === generationId && row.collection === '_workStorePlanCounts',
  );

test('filtered planning and one-read Initiative counts charge only matching rows on a 1500-item board (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s, new Map(), [...hostedContractFeatures], true);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  // This fixture loads legacy roots directly, before the counter's writer existed.
  await s.ctx.db.delete(planCounterRow(s, generationId)._id);
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
    true,
  );
  let beforeRows;
  const before = await meter.cost(async () => {
    beforeRows = await allPages(beforeClient, filter);
  });
  let afterRows;
  const filteredCallStart = p.calls.length;
  const after = await meter.cost(async () => {
    afterRows = await allPages(p, filter);
  });
  t.diagnostic(
    JSON.stringify({
      planningFilteredCalls: p.calls.slice(filteredCallStart),
      planningFilteredReads: after.documents,
    }),
  );
  assertCommandWeight('planningFiltered', {
    calls: p.calls.length - filteredCallStart,
    reads: after.documents,
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
  assertCommandWeight('planningCounts', { calls: p.calls.length, reads: count.documents });
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

test('Initiative progress agrees across Plan, CLI and MCP after status and scope moves (b7a0dff1)', async t => {
  const s = await setup(t);
  const p = port(s);
  const { transport: agent } = transport(s, { planning: true, features: p.serverFeatures });
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _config, call) {
          tools.set(name, call);
        },
      },
      agent,
    ),
  );
  const webRead = await import(moduleUrl('../convex/projectPlanView.ts'));
  const { planView, groupBreakdown } = await import(moduleUrl('../web/src/app/plan/model.ts'));
  const { workRecordWriter, finishWorkRecordWrites } = await import(
    moduleUrl('../convex/projectWorkRecordWriter.ts')
  );
  const projectId = s.projectId;
  const group = async title => (await put(p, { kind: 'initiative', title })).result.itemId;
  const initiativeId = await group('First Initiative');
  const other = await group('Second Initiative');
  const item = async (title, status, extra = {}) =>
    (await put(p, { kind: 'issue', initiativeId, title, status, ...extra })).result.itemId;
  const update = async (itemId, changes) => {
    const { item: current } = await list(p, { id: itemId, reconcile: false });
    await put(p, { itemId, expectedVersion: current.version, ...changes });
  };
  const parentId = await item('Parent', 'open');
  const child = await item('Child', 'proposed', { fields: { parentId } });
  const moving = await item('Moving', 'in-progress');
  await item('Done', 'closed');
  await item('Dropped', 'abandoned');
  const archived = await item('Archived', 'open');
  await update(archived, { status: 'archived' });
  const deleted = await item('Deleted', 'open');
  await update(deleted, { status: 'deleted' });

  const check = async (id, expected, from = p) => {
    const board = planView(await webRead.read._handler(s.ctx, { projectId }));
    const group = board.initiativeGroups.get(id);
    const { proposed, open, inProgress, done, dropped, total } = group;
    assert.equal(groupBreakdown(group).atLeast, false);
    const selection = { counts: true, initiativeId: id };
    from.calls.length = 0;
    const cli = await list(from, selection);
    assert.deepEqual(from.calls, ['projectWorkIndex:records']);
    assert.deepEqual(cli.counts, expected);
    assert.deepEqual(cli.counts, {
      proposed,
      open,
      'in-progress': inProgress,
      closed: done,
      abandoned: dropped,
    });
    assert.equal(cli.total, total);
    assert.equal(
      cli.total,
      Object.values(cli.counts).reduce((sum, count) => sum + count, 0),
    );
    assert.equal(cli.coverage, 'complete');
    assert.equal(cli.nextCursor, null);

    const mcp = await tools.get('forge_planning')({ command: { action: 'planning', ...selection } });
    assert.ok(!mcp.isError, JSON.stringify(mcp.content));
    assert.deepEqual(JSON.parse(mcp.content[0].text).result, cli);
    return board;
  };
  const initial = { proposed: 1, open: 1, 'in-progress': 1, closed: 1, abandoned: 1 };
  await check(initiativeId, initial);
  const olderServer = port(
    s,
    new Map(),
    p.serverFeatures.filter(f => f !== planningInitiativeCountsFeature),
  );
  await check(initiativeId, initial, olderServer);
  const shelves = await list(p, { counts: true, initiativeId, status: 'all' });
  assert.equal(shelves.counts.archived, 1);
  assert.equal(shelves.counts.deleted, 1);
  assert.equal(shelves.total, undefined);

  await update(moving, { status: 'closed' });
  await update(child, { status: 'open' });
  await update(moving, { initiativeId: other });
  await check(initiativeId, { proposed: 0, open: 2, 'in-progress': 0, closed: 1, abandoned: 1 });
  await check(other, { proposed: 0, open: 0, 'in-progress': 0, closed: 1, abandoned: 0 });

  await update(parentId, { fields: { hidden: true } });
  await check(initiativeId, { proposed: 0, open: 2, 'in-progress': 0, closed: 1, abandoned: 1 });
  await update(parentId, { fields: { hidden: false } });

  const settledOnly = (await put(p, { kind: 'initiative', title: 'Shipped', status: 'closed' })).result
    .itemId;
  await item('Shipped step', 'closed', { initiativeId: settledOnly });
  const generationId = s.tables.hostedProjects.get(projectId).work.generationId;
  const writer = workRecordWriter(s.ctx);
  let position = 10_000;
  const addRoot = async (status, initiativeId, parentId) => {
    const id = randomUUID();
    await writer.db.insert('projectPlanningRecords', {
      projectId,
      generationId,
      collection: 'planningSearch',
      key: id,
      parent: '',
      position: position++,
      value: JSON.stringify({ id, kind: 'issue', title: 'Synthetic step', status, initiativeId, parentId }),
      planning: { text: 'Synthetic step', kind: 'issue', status, initiativeId, open: status === 'open' },
    });
    return id;
  };
  for (let i = 0; i < webRead.PLAN_LIVE_LIMIT; i++) await addRoot('open', initiativeId);
  const beyond = await addRoot('open', other, parentId);
  for (let i = 0; i <= webRead.PLAN_SETTLED_LIMIT; i++) await addRoot('closed', initiativeId);
  await finishWorkRecordWrites(writer);

  const board = await check(initiativeId, {
    proposed: 0,
    open: webRead.PLAN_LIVE_LIMIT + 2,
    'in-progress': 0,
    closed: webRead.PLAN_SETTLED_LIMIT + 2,
    abandoned: 1,
  });
  assert.equal(board.more, true);
  assert.equal(board.byId.has(beyond), false, 'the foreign sub-item is beyond the live display window');
  assert.equal(board.initiativeGroups.get(initiativeId).lines.length, webRead.PLAN_LIVE_LIMIT);
  const otherBoard = await check(other, { proposed: 0, open: 1, 'in-progress': 0, closed: 1, abandoned: 0 });
  assert.equal(otherBoard.initiativeGroups.get(other).lines.length, 0);
  const detail = await check(settledOnly, {
    proposed: 0,
    open: 0,
    'in-progress': 0,
    closed: 1,
    abandoned: 0,
  });
  assert.equal(
    detail.groups.some(group => group.initiative?.id === settledOnly),
    false,
  );
  assert.equal(detail.initiativeGroups.get(settledOnly).done, 1);

  // An older projected header can omit search coverage even when the indexed roots are complete.
  const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
  const headers = finishReadWriter(s.ctx);
  await headers.db.patch(generationId, { planRowsVersion: undefined });
  const generationHeader = [...s.tables.projectFinishReadRows.values()].find(
    row => row.kind === 'projectWorkGenerations' && row.sourceId === generationId,
  );
  const { planningSearchVersion, ...oldHeader } = JSON.parse(generationHeader.value);
  assert.equal(planningSearchVersion, 2);
  await s.ctx.db.patch(generationHeader._id, { value: JSON.stringify(oldHeader) });
  await check(settledOnly, { proposed: 0, open: 0, 'in-progress': 0, closed: 1, abandoned: 0 });
  await headers.db.patch(generationId, { planRowsVersion: 1 });

  // The existing counter folds hidden members into one bucket. Bound the read when it cannot prove membership.
  await update(parentId, { fields: { hidden: true } });
  const fallback = planView(await webRead.read._handler(s.ctx, { projectId })).initiativeGroups.get(
    initiativeId,
  );
  assert.equal(fallback.open, webRead.PLAN_LIVE_LIMIT);
  assert.equal(fallback.done, webRead.PLAN_SETTLED_LIMIT);
  const parts = groupBreakdown(fallback).parts;
  for (const key of ['open', 'done']) assert.equal(parts.find(part => part.key === key).atLeast, true);
});

test('maintained Initiative counts use one bounded read at current and doubled board scale (b7a0dff1)', async t => {
  const s = await setup(t);
  const p = port(s);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const initiativeId = (await put(p, { kind: 'initiative', title: 'Group' })).result.itemId;
  const { workRecordWriter, finishWorkRecordWrites } = await import(
    moduleUrl('../convex/projectWorkRecordWriter.ts')
  );
  const selection = { counts: true, initiativeId };
  const legacy = port(
    s,
    new Map(),
    p.serverFeatures.filter(f => f !== planningInitiativeCountsFeature),
  );
  const meter = meterReads(s.ctx);
  t.after(() => meter.restore());

  for (const scale of [352, 704]) {
    const writer = workRecordWriter(s.ctx);
    for (let position = scale - 352; position < scale; position++) {
      const id = randomUUID();
      await writer.db.insert('projectPlanningRecords', {
        projectId: s.projectId,
        generationId,
        collection: 'planningSearch',
        key: id,
        parent: '',
        position: position + 1,
        value: JSON.stringify({
          id,
          kind: 'issue',
          status: 'closed',
          initiativeId,
          title: 'Retained detail',
        }),
        planning: {
          text: 'Retained detail. '.repeat(100),
          kind: 'issue',
          status: 'closed',
          initiativeId,
          open: false,
        },
      });
    }
    await finishWorkRecordWrites(writer);
    let result;
    const measure = async client => {
      client.calls.length = 0;
      const start = performance.now();
      const read = await meter.cost(async () => {
        result = await list(client, selection);
      });
      const milliseconds = performance.now() - start;
      assert.equal(result.total, scale);
      assert.equal(result.counts.closed, scale);
      assert.equal(result.coverage, 'complete');
      return { ...read, calls: client.calls.length, milliseconds: +milliseconds.toFixed(2) };
    };
    const indexed = await measure(legacy);
    const maintained = await measure(p);
    assert.equal(maintained.calls, 1);
    assert.ok(maintained.documents <= 5, JSON.stringify(maintained));
    assert.ok(maintained.bytes < 10_000, JSON.stringify(maintained));
    assert.ok(maintained.bytes < indexed.bytes);
    t.diagnostic(JSON.stringify({ scale, indexed, maintained }));
  }
});

test('planning detail, list and search distinguish the latest close from later edits, with one bounded Initiative read', async t => {
  const { features } = capabilityOptions('.', false, false, 'planning', {});
  assert.ok(features.includes(planningHistoryFeature));
  assert.ok(features.length <= MAX_CONTRACT_FEATURES);
  const first = Date.parse('2026-11-09T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const s = await setup(t);
  await s.ctx.db.patch(s.projectId, { workStore: 'records', workStoreWriters: ['planning'] });
  const p = port(s, new Map(), [
    ...hostedContractFeatures,
    planningInitiativeCountsFeature,
    planningHistoryFeature,
  ]);
  const original = (await put(p, { kind: 'initiative', title: 'Original group' })).result.itemId;
  const destination = (await put(p, { kind: 'initiative', title: 'Destination group' })).result.itemId;
  const issue = (await put(p, { kind: 'issue', title: 'Reopenable test issue', initiativeId: original }))
    .result.itemId;

  t.mock.timers.setTime(Date.parse('2026-11-10T23:59:59Z'));
  await put(p, { itemId: issue, expectedVersion: 1, status: 'closed' });
  t.mock.timers.setTime(Date.parse('2026-11-11T00:00:01Z'));
  await put(p, { itemId: issue, expectedVersion: 2, initiativeId: destination, status: 'closed' });
  const reads = await Promise.all([
    list(p, { id: issue, reconcile: false }).then(r => r.item),
    list(p, { initiativeId: destination, reconcile: false }).then(r => r.items[0]),
    list(p, { search: 'Reopenable', status: 'all', reconcile: false }).then(r => r.items[0]),
  ]);
  for (const item of reads.slice(0, 2)) assert.equal(item.at, '2026-11-11T00:00:01.000Z');
  for (const item of reads) {
    assert.equal(item.closedAt, '2026-11-10T23:59:59.000Z');
    assert.equal(item.lastStatusChangeAt, item.closedAt);
  }

  t.mock.timers.setTime(Date.parse('2026-11-12T09:00:00Z'));
  await put(p, { itemId: issue, expectedVersion: 3, status: 'open' });
  const { item } = await list(p, { id: issue, reconcile: false });
  assert.equal(item.closedAt, null);
  assert.equal(item.lastStatusChangeAt, '2026-11-12T09:00:00.000Z');
  await put(p, { itemId: issue, expectedVersion: 4, status: 'closed' });
  const reclosed = (await list(p, { search: 'Reopenable', status: 'all', reconcile: false })).items[0];
  assert.equal(reclosed.closedAt, '2026-11-12T09:00:00.000Z');
  const reclosedAt = reclosed.closedAt;
  t.mock.timers.setTime(Date.parse('2026-11-13T09:00:00Z'));
  await put(p, { itemId: issue, expectedVersion: 5, status: 'archived' });
  await put(p, { itemId: issue, expectedVersion: 6, status: 'deleted' });
  await put(p, { itemId: issue, expectedVersion: 7, status: 'closed' });
  const restored = (await list(p, { id: issue, reconcile: false })).item;
  assert.equal(restored.closedAt, reclosedAt);
  assert.equal(restored.lastStatusChangeAt, '2026-11-13T09:00:00.000Z');
  t.mock.timers.setTime(Date.parse('2026-11-22T12:00:00Z'));
  for (const [initiativeId, date] of [
    [original, '2026-11-10'],
    [destination, '2026-11-12'],
  ]) {
    p.calls.length = 0;
    const { history } = await list(p, { initiativeId, counts: true, history: true });
    assert.deepEqual(p.calls, ['projectWorkIndex:records']);
    assert.equal(history.coverage, 'complete');
    assert.equal(history.unresolved, 0);
    assert.equal(history.closedByDay.length, 14);
    assert.equal(history.closedByDay[0].day, '2026-11-09');
    assert.equal(history.closedByDay.at(-1).day, '2026-11-22');
    assert.deepEqual(
      history.closedByDay.filter(row => row.count),
      [{ day: date, count: 1 }],
    );
  }
});

test('planning history leaves missing legacy predecessors unknown and preserves ordinary legacy reads', async t => {
  const s = await setup(t);
  const p = port(s, new Map(), [
    ...hostedContractFeatures,
    planningInitiativeCountsFeature,
    planningHistoryFeature,
  ]);
  const initiativeId = (await put(p, { kind: 'initiative', title: 'Legacy group' })).result.itemId;
  const itemId = (await put(p, { kind: 'issue', title: 'Legacy issue', initiativeId })).result.itemId;
  const initial = (await list(p, { id: itemId, reconcile: false })).item;
  assert.equal(initial.lastStatusChangeAt, initial.at);
  await put(p, { itemId, expectedVersion: 1, status: 'closed' });
  const legacy = (await list(p, { id: itemId, reconcile: false })).item;
  assert.equal(legacy.closedAt, legacy.at);
  for (const [key, row] of s.tables.projectPlanningRecords) {
    if (row.collection === 'planningVersions' && row.parent === itemId && JSON.parse(row.value).version === 1)
      s.tables.projectPlanningRecords.delete(key);
  }
  const unknown = (await list(p, { id: itemId, reconcile: false })).item;
  assert.equal(unknown.closedAt, null);
  assert.equal(unknown.lastStatusChangeAt, null);
  const result = await list(p, { initiativeId, counts: true, history: true });
  assert.equal(result.counts.closed, 1);
  assert.equal(result.history.coverage, 'unavailable');
  assert.equal((await list(port(s), { id: itemId, reconcile: false })).item.closedAt, undefined);
  await assert.rejects(
    list(port(s), { initiativeId, counts: true, history: true }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
});

test('planning counts sum every page and refuse stale generations, invalid cursors and old servers (5a85cb5f)', async t => {
  const s = await setup(t),
    p = port(s);
  const initiativeId = randomUUID();
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  // This fixture loads legacy roots directly, before the counter's writer existed.
  await s.ctx.db.delete(planCounterRow(s, generationId)._id);
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
  const oldPage = await index.records._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'planningItems',
    planningFilter: { initiativeId },
    counts: true,
    paginationOpts: { cursor: null, numItems: 1000 },
  });
  const oldCursor =
    'forge-planning-v1:' +
    Buffer.from(JSON.stringify({ cursor: oldPage.continueCursor, generationId })).toString('base64url');
  const queryWithCursor = p.query;
  p.query = (name, args) => {
    // Convex's cursor is opaque and tied to this exact indexed selection.
    assert.deepEqual(args.planningFilter, { initiativeId });
    return queryWithCursor(name, args);
  };
  assert.equal((await list(p, { counts: true, initiativeId, cursor: oldCursor })).total, 1);
  p.query = queryWithCursor;
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
  // This fixture loads legacy roots directly, before the counter's writer existed.
  await s.ctx.db.delete(planCounterRow(s, generationId)._id);
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
  assert.equal(first.total, 20000);
  assert.match(first.nextCursor, /^forge-planning-v1:/);
  assert.match(first.next, /counts are incomplete after 20 pages/);
  assert.match(first.next, /same filters and nextCursor as cursor/);
  assert.match(first.next, /add the returned counts/);
  assert.equal(p.calls.length, 20, 'bounded to 20 records reads and no writes');
  const last = await list(p, { counts: true, initiativeId, cursor: first.nextCursor });
  assert.equal(first.counts.closed + last.counts.closed, 20001);
  assert.equal(first.total + last.total, 20001);
  assert.equal(last.coverage, 'complete');
  assert.equal(last.nextCursor, null);
  assert.equal(last.next, undefined);
});

test('incident 1018d0f8: alert refresh preserves every outstanding Done-when line and reconciliation holds it open', async t => {
  const s = await setup(t),
    p = port(s);
  const { write } = await import(moduleUrl('../convex/projectLandingSpeedIssue.ts'));
  const { speedBudgetIssue } = await import('../dist/landing-speed-alerts.js');
  const event = {
    kind: 'broken',
    budget: speedBudgets.budgets.find(b => b.metric === 'runnerDiscarded'),
    value: 60,
    landing: 'first',
    since: '2026-11-04T12:00:00.000Z',
  };
  const issue = speedBudgetIssue(event, s.projectId, speedBudgets);
  const send = issue =>
    write._handler(s.ctx, { projectId: s.projectId, owner: 'owner', issue: JSON.stringify(issue) });
  await send(issue);
  const body =
    'Owner diagnosis\n\nDone when:\n- [x] Root cause fixed\n- [ ] Measured on the next smoke and dogfood\n1. [ ] Compare discarded runner minutes\n[ ] Independent measurement still pending';
  const original = (await list(p, { id: issue.itemId, reconcile: false })).item;
  await put(p, { itemId: issue.itemId, expectedVersion: original.version, body });
  await send(speedBudgetIssue({ ...event, landing: 'second' }, s.projectId, speedBudgets));
  await send(speedBudgetIssue({ ...event, kind: 'recovered', landing: 'second' }, s.projectId, speedBudgets));
  assert.equal((await list(p, { id: issue.itemId, reconcile: false })).item.body, body);
  p.states.set(issue.itemId, 'completed');
  const read = await list(p, { id: issue.itemId });
  assert.equal(read.item.status, 'open');
  assert.equal(read.reconciled.held[0].openLines, 3);
  // Any writer can supply a body with a bare unchecked line; ticked lists must not hide it.
  await put(p, {
    itemId: issue.itemId,
    expectedVersion: read.item.version,
    body: 'Done when:\n- [x] Code fixed\n[ ] Evidence pending',
  });
  const held = await list(p, { id: issue.itemId });
  assert.equal(held.item.status, 'open');
  assert.deepEqual(held.reconciled.held[0].lines, ['Evidence pending']);
});

// Planning model contract (d3357f40, docs/planning.md): the model fields round-trip through the real handlers.
test('planning model fields (order, type, parent, owner, relations, hidden) store, read back, keep and clear', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Release', fields: { hidden: true } }))
    .result;
  const parent = (
    await put(
      p,
      planningIssueArguments('put-planning-item', {
        kind: 'item',
        title: 'Parent',
        initiativeId: initiative.itemId,
      }),
    )
  ).result;
  const blocker = (await put(p, { kind: 'issue', title: 'Blocker', body: '- [x] one\n- [ ] two\n' })).result;
  const fields = {
    parentId: parent.itemId,
    order: 'AV',
    type: 'bug',
    owner: 'mara/amber-fox',
    relations: [{ kind: 'depends-on', id: blocker.itemId }],
  };
  const child = (await put(p, { kind: 'issue', title: 'Child', fields })).result;
  const row = (await list(p)).items.find(item => item.id === child.itemId);
  assert.deepEqual(
    { order: row.order, type: row.type, parentId: row.parentId, owner: row.owner, relations: row.relations },
    fields,
  );
  assert.equal((await list(p)).items.find(item => item.id === initiative.itemId).hidden, true);
  // `item` is stored as the replay-stable kind `issue`.
  assert.equal((await list(p, { id: parent.itemId })).item.kind, 'issue');
  // A status move keeps every model field; null and [] clear them.
  await put(p, { itemId: child.itemId, expectedVersion: 1, status: 'in-progress' });
  assert.equal((await list(p, { id: child.itemId })).item.owner, 'mara/amber-fox');
  await put(p, {
    itemId: child.itemId,
    expectedVersion: 2,
    fields: { owner: null, relations: [], order: null },
  });
  const cleared = (await list(p, { id: child.itemId })).item;
  assert.deepEqual(
    [cleared.owner, cleared.relations, cleared.order, cleared.type],
    [undefined, undefined, undefined, 'bug'],
  );
  await put(p, { itemId: initiative.itemId, expectedVersion: 1, fields: { hidden: false } });
  assert.equal((await list(p, { id: initiative.itemId })).item.hidden, undefined);
  // Planning rows carry the Done-when count of the full body.
  assert.deepEqual((await list(p)).items.find(item => item.id === blocker.itemId).doneWhen, [1, 2]);
  await assert.rejects(
    put(p, {
      itemId: child.itemId,
      expectedVersion: 3,
      fields: { relations: [{ kind: 'related', id: child.itemId }] },
    }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    put(p, { kind: 'initiative', title: 'Nested', fields: { parentId: parent.itemId } }),
    code('BAD_ARGUMENT'),
  );
  // Agents name model fields only inside `fields`; the flat names stay refused.
  assert.equal(hostedAgentCommandSchemas['put-planning-item'].safeParse({ order: 'AV' }).success, false);
});

test('the CLI refuses planning model fields, with zero calls, on a server that does not advertise planning-model', async t => {
  const s = await setup(t),
    p = port(
      s,
      new Map(),
      hostedContractFeatures.filter(name => name !== 'planning-model'),
    );
  p.calls.length = 0;
  await assert.rejects(
    put(p, { kind: 'issue', title: 'Ordered', fields: { order: 'AV' } }),
    /does not store order/,
  );
  assert.deepEqual(p.calls, []);
  // Writes without model fields still go through on that server.
  assert.equal((await put(p, { kind: 'issue', title: 'Plain' })).result.version, 1);
});

test('waiting reasons compose with planning selectors and page without text search or reading unrelated Items', async t => {
  const s = await setup(t);
  const p = port(s, new Map(), [...hostedContractFeatures, planningWaitingFeature]);
  const initiativeId = (await put(p, { kind: 'initiative', title: 'Release' })).result.itemId;
  const waitingOn = { kind: 'evidence', reason: 'Read live volume on Monday' };
  const make = (title, fields = {}, group = initiativeId) =>
    put(p, { kind: 'issue', title: `Synthetic ${title}`, initiativeId: group, fields }).then(
      reply => reply.result.itemId,
    );
  const legacy = await make('legacy');
  const fields = { waitingOn, type: 'bug', owner: 'mara/amber-fox' };
  const first = await make('first', fields);
  const second = await make('second', fields);
  await make('other type', { ...fields, type: 'task' });
  await make('other wait', { ...fields, waitingOn: { kind: 'owner', reason: 'Choose scope' } });
  await make('ungrouped', fields, null);
  const filter = {
    kind: 'issue',
    status: 'open',
    initiativeId,
    waitingOn: 'evidence',
    type: 'bug',
    owner: 'mara',
    relation: 'none',
    reconcile: false,
    limit: 1,
  };
  const meter = meterReads(s.ctx);
  const readBoth = async () => {
    const result = await list(p, filter);
    assert.ok(result.nextCursor);
    assert.deepEqual(
      result.items.map(item => item.waitingOn),
      [waitingOn],
    );
    const next = await list(p, { ...filter, cursor: result.nextCursor });
    assert.deepEqual(
      new Set([...result.items, ...next.items].map(item => item.id)),
      new Set([first, second]),
    );
    return result.nextCursor;
  };
  let cursor;
  p.calls.length = 0;
  const before = await meter.cost(async () => {
    cursor = await readBoth();
  });
  const pageCalls = [...p.calls];
  assert.ok(pageCalls.length <= 8);
  assert.ok(
    pageCalls.every(name =>
      [
        'projectWorkIndex:workspace',
        'projectWorkIndex:records',
        'projectHostedPlanning:intentStates',
      ].includes(name),
    ),
  );
  await assert.rejects(list(p, { ...filter, waitingOn: 'owner', cursor }), code('WORK_STALE'));
  await assert.rejects(list(p, { ...filter, waitingOn: undefined, cursor }), code('WORK_STALE'));
  await assert.rejects(list(p, { ...filter, owner: 'someone-else', cursor }), code('WORK_STALE'));

  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  for (let i = 0; i < 1500; i++)
    await s.ctx.db.insert('projectPlanningRecords', {
      generationId,
      projectId: s.projectId,
      collection: 'planningSearch',
      key: randomUUID(),
      parent: '',
      position: i + 100,
      value: '{}',
      planning: { text: 'Unrelated', kind: 'issue', status: 'closed', initiativeId: '', open: false },
    });
  p.calls.length = 0;
  assert.deepEqual(await meter.cost(readBoth), before);
  assert.deepEqual(p.calls, pageCalls);
  t.diagnostic(JSON.stringify({ waitingPages: 2, calls: pageCalls.length, ...before }));
  meter.restore();

  const search = await list(p, { search: 'synthetic', waitingOn: 'evidence', status: 'open' });
  assert.ok(search.items.some(item => item.id === first));
  assert.ok(search.items.every(item => item.waitingOn.kind === 'evidence'));
  const count = await list(p, { counts: true, kind: 'issue', initiativeId, waitingOn: 'evidence' });
  assert.equal(count.counts.open, 3);
  assert.equal(count.coverage, 'complete');
  const clear = { itemId: first, expectedVersion: 1, fields: { waitingOn: null } };
  await put(p, { itemId: first, expectedVersion: 1, title: 'Synthetic renamed' });
  assert.deepEqual((await list(p, { id: first, reconcile: false })).item.waitingOn, waitingOn);
  await assert.rejects(put(p, clear), code('ITEM_CHANGED'));
  await put(p, { ...clear, expectedVersion: 2 });
  const free = await list(p, { kind: 'issue', initiativeId, waitingOn: 'none', reconcile: false });
  assert.deepEqual(new Set(free.items.map(item => item.id)), new Set([first, legacy]));
  assert.ok(free.items.every(item => !Object.hasOwn(item, 'waitingOn')));

  s.tables.projectWorkGenerations.get(generationId).planningSearchVersion = 1;
  await assert.rejects(list(p, { ...filter, cursor }), code('WORK_STALE'));
  const beforePreparation = await list(p, {
    kind: 'issue',
    initiativeId,
    waitingOn: 'none',
    reconcile: false,
  });
  assert.deepEqual(new Set(beforePreparation.items.map(item => item.id)), new Set([first, legacy]));
  const recordedWait = await list(p, filter);
  assert.deepEqual(
    recordedWait.items.map(item => item.id),
    [second],
  );
});

test('forge_planning sets and clears wait reasons, and old servers refuse them without a planning call', async t => {
  const s = await setup(t);
  const { transport: agent } = transport(s, {
    planning: true,
    features: [...hostedContractFeatures, planningWaitingFeature],
  });
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _config, call) {
          tools.set(name, call);
        },
      },
      agent,
    ),
  );
  const mcp = async command => {
    const result = await tools.get('forge_planning')({ command });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text).result;
  };
  const waitingOn = { kind: 'item', reason: 'The related Item owns the prototype' };
  const { itemId } = await mcp({
    action: 'put-planning-item',
    kind: 'issue',
    title: 'Prototype user',
    fields: { waitingOn },
  });
  const { items } = await mcp({ action: 'planning', waitingOn: 'item', reconcile: false });
  assert.deepEqual(
    items.map(item => [item.id, item.waitingOn]),
    [[itemId, waitingOn]],
  );
  await mcp({
    action: 'put-planning-item',
    planningItemId: itemId,
    expectedVersion: 1,
    fields: { waitingOn: null },
  });
  assert.equal((await mcp({ action: 'planning', waitingOn: 'none', reconcile: false })).items[0].id, itemId);

  const older = port(s);
  await assert.rejects(list(older, { waitingOn: 'none' }), code('HOSTED_ACTION_UNSUPPORTED'));
  await assert.rejects(
    put(older, { itemId, expectedVersion: 2, fields: { waitingOn } }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  assert.deepEqual(older.calls, []);
});

test('3fa3187d: the stored counter and the CLI count the same Issues past 1,000, live, mid-backfill and after it', async t => {
  const s = await setup(t),
    p = port(s);
  const counts = await import(moduleUrl('../convex/projectPlanCounts.ts'));
  const { workRecordWriter, finishWorkRecordWrites } = await import(
    moduleUrl('../convex/projectWorkRecordWriter.ts')
  );
  const { progressOf } = await import(moduleUrl('../web/src/app/progress.ts'));
  const projectId = s.projectId;
  const generationId = s.tables.hostedProjects.get(projectId).work.generationId;
  const counter = () =>
    [...s.tables.projectWorkDataRecords.values()].find(
      row => row.generationId === generationId && row.collection === '_workStorePlanCounts',
    );
  assert.equal(JSON.parse(counter().value).done, true, 'a new partition counts from birth');
  const read = () => counts.read._handler(s.ctx, { projectId });
  const cli = async () => {
    const result = await list(p, { counts: true, kind: 'issue' });
    assert.equal(result.coverage, 'complete');
    const all = { proposed: 0, open: 0, 'in-progress': 0, closed: 0, abandoned: 0, ...result.counts };
    // The read names in-progress `inProgress` (validator fields are identifiers); the figures are the CLI's.
    return {
      proposed: all.proposed,
      open: all.open,
      inProgress: all['in-progress'],
      closed: all.closed,
      abandoned: all.abandoned,
    };
  };
  // Live: Items written through the planning command move the counter in the same transaction.
  const made = [];
  for (const status of ['open', 'open', 'in-progress', 'proposed']) {
    const itemId = randomUUID();
    await put(p, { itemId, kind: 'issue', title: `Synthetic ${status}`, status });
    made.push(itemId);
  }
  const first = (await list(p, { id: made[0], reconcile: false })).item;
  await put(p, { itemId: made[0], expectedVersion: first.version, status: 'closed' });
  const live = await read();
  assert.equal(live.exact, true);
  assert.deepEqual(live.issue, await cli());
  assert.equal(live.closedToday?.n, 1);
  // A partition from before the counter: 1,201 more roots, written without the planning writer.
  const statuses = ['open', 'in-progress', 'closed', 'proposed', 'abandoned'];
  const roots = [];
  for (let i = 0; i < 1201; i++) {
    const key = randomUUID();
    const status = statuses[i % statuses.length];
    const id = await s.ctx.db.insert('projectPlanningRecords', {
      projectId,
      generationId,
      collection: 'planningSearch',
      key,
      parent: '',
      position: 10_000 + i,
      value: JSON.stringify({ id: key, kind: 'issue', title: `Synthetic ${i}`, status }),
      planning: { text: '', kind: 'issue', status, initiativeId: '', open: status !== 'closed' },
    });
    roots.push({ id, key, status });
  }
  await s.ctx.db.delete(counter()._id);
  const capped = await read();
  assert.equal(capped.exact, false, 'without a counter the read is a capped page, marked not exact');
  assert.equal(progressOf(capped).atLeast, true, 'so every figure reads N+');
  const total = Object.values(await cli()).reduce((sum, n) => sum + n, 0);
  assert.ok(total > 1000);
  // One backfill step, then a status move behind its cursor and one ahead of it, then the rest.
  let step = await counts.backfill._handler(s.ctx, { projectId });
  assert.deepEqual(step, { done: false, counted: counts.PLAN_COUNTS_PAGE });
  const after = JSON.parse(counter().value).after;
  const behind = roots.find(root => root.key <= after && root.status === 'open');
  const ahead = roots.find(root => root.key > after && root.status === 'open');
  for (const root of [behind, ahead]) {
    const writer = workRecordWriter(s.ctx);
    const row = s.tables.projectPlanningRecords.get(root.id);
    await writer.db.patch(root.id, {
      value: JSON.stringify({ ...JSON.parse(row.value), status: 'closed' }),
      planning: { ...row.planning, status: 'closed', open: false },
    });
    await finishWorkRecordWrites(writer);
  }
  for (let guard = 0; !step.done && guard < 20; guard++)
    step = await counts.backfill._handler(s.ctx, { projectId });
  assert.equal(step.done, true);
  assert.deepEqual(await counts.backfill._handler(s.ctx, { projectId }), { done: true, counted: 0 });
  const exact = await read();
  assert.equal(exact.exact, true);
  const fromCli = await cli();
  assert.deepEqual(exact.issue, fromCli, 'the web read and the CLI agree past 1,000 Items');
  assert.equal(progressOf(exact).done, fromCli.closed);
  // A title edit moves no count and writes nothing to the counter.
  const before = counter().value;
  const item = (await list(p, { id: made[1], reconcile: false })).item;
  await put(p, { itemId: made[1], expectedVersion: item.version, title: 'Renamed synthetic Item' });
  assert.equal(counter().value, before);
});

test('2026-11-18 lead: every Item id field of a put and the initiativeId filter take a unique 8-character prefix; an ambiguous one is refused', async t => {
  const s = await setup(t),
    p = port(s);
  const initiative = (await put(p, { kind: 'initiative', title: 'Group' })).result.itemId;
  const parent = (await put(p, { kind: 'issue', title: 'Parent' })).result.itemId;
  const blocker = (await put(p, { kind: 'issue', title: 'Blocker' })).result.itemId;
  const short = id => id.slice(0, 8);
  const child = (
    await put(p, {
      kind: 'issue',
      title: 'Child',
      initiativeId: short(initiative),
      fields: { parentId: short(parent), relations: [{ kind: 'depends-on', id: short(blocker) }] },
    })
  ).result.itemId;
  const stored = (await list(p, { id: child, reconcile: false })).item;
  assert.equal(stored.initiativeId, initiative, 'stored as the full id');
  assert.equal(stored.parentId, parent);
  assert.deepEqual(stored.relations, [{ kind: 'depends-on', id: blocker }]);
  const filtered = await list(p, { initiativeId: short(initiative) });
  assert.deepEqual(
    filtered.items.map(item => item.id),
    [child],
  );
  // Full ids add no resolve call.
  p.calls.length = 0;
  await put(p, { itemId: child, expectedVersion: 1, initiativeId: initiative });
  assert(!p.calls.includes('projectHostedPlanning:resolveId'));
  // An ambiguous prefix is refused with its candidates and writes nothing.
  for (const n of [1, 2])
    await put(p, { itemId: `feedface-000${n}-4000-8000-000000000000`, kind: 'issue', title: `Twin ${n}` });
  await assert.rejects(
    put(p, { itemId: child, expectedVersion: 2, fields: { parentId: 'feedface' } }),
    error => error.code === 'AMBIGUOUS_ID' && /feedface-0001/.test(error.message),
  );
  assert.equal((await list(p, { id: child, reconcile: false })).item.version, 2);
});

// Item 66667155: one call ticks a Done-when line and posts its evidence.
const tickBody = [
  'Why.',
  '',
  'Done-when:',
  '- [ ] One call ticks a line',
  '- [ ] A clear error on no match',
  '- [x] Docs show the way',
  '- [ ] Test: two concurrent ticks survive',
].join('\n');
const tickIssue = async p =>
  (await put(p, { kind: 'issue', title: 'Tickable', body: tickBody })).result.itemId;
const tick = (p, input, operationId) => run(p, 'tick-planning-item', input, operationId);
const stored = async (p, itemId) => (await list(p, { id: itemId, reconcile: false })).item;

test('tick-planning-item ticks the line by position or text prefix and posts the evidence as a decision comment (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = await tickIssue(p);
  p.calls.length = 0;
  const first = await tick(p, { planningItemId: itemId, line: 2, evidence: 'Evidence two' });
  assert.deepEqual(first.result.ticked, { line: 2, text: 'A clear error on no match' });
  assert.equal(first.result.openLines, 2);
  // One planning write and one comment (plus the reads that fetch the stored body).
  assert.equal(p.calls.filter(name => name === 'projectWorkCommand:command').length, 2);
  const byPrefix = await tick(p, {
    planningItemId: itemId.slice(0, 8),
    line: 'test: two concurrent',
    evidence: 'Evidence four',
  });
  assert.equal(byPrefix.result.ticked.line, 4);
  const item = await stored(p, itemId);
  assert.match(item.body, /- \[ \] One call ticks a line/);
  assert.match(item.body, /- \[x\] A clear error on no match/);
  assert.match(item.body, /- \[x\] Test: two concurrent ticks survive/);
  const read = await list(p, { id: itemId, reconcile: false });
  assert.deepEqual(
    read.comments.map(comment => comment.text),
    ['Evidence two', 'Evidence four'],
  );
});

test('tick-planning-item refuses zero or several matches and lists the candidates (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = (
    await put(p, {
      kind: 'issue',
      title: 'Twins',
      body: `${tickBody}\n- [ ] Test: both candidates are listed`,
    })
  ).result.itemId;
  const before = await stored(p, itemId);
  const refused = async line =>
    await tick(p, { planningItemId: itemId, line, evidence: 'x' }).then(
      () => assert.fail('must refuse'),
      error => error,
    );
  const none = await refused('nothing like this');
  assert.equal(none.code, 'BAD_ARGUMENT');
  assert.match(none.message, /no Done-when checkbox/);
  assert.match(
    none.message,
    /1\. One call ticks a line \| 2\. A clear error on no match \| 4\. Test: two[^|]*\| 5\. Test: both/,
  );
  const several = await refused('test:');
  assert.match(several.message, /matches 2 checkboxes/);
  assert.match(several.message, /4\. Test: two concurrent/);
  assert.match(several.message, /5\. Test: both candidates/);
  assert.match((await refused(9)).message, /no Done-when checkbox/);
  // Nothing was written or commented.
  const after = await list(p, { id: itemId, reconcile: false });
  assert.equal(after.item.version, before.version);
  assert.deepEqual(after.comments, []);
});

test('tick-planning-item on a ticked line writes nothing but still posts the evidence; a replay adds nothing (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = await tickIssue(p);
  const operationId = randomUUID();
  const done = await tick(p, { planningItemId: itemId, line: 3, evidence: 'Already there' }, operationId);
  assert.equal(done.result.ticked.alreadyTicked, true);
  const version = (await stored(p, itemId)).version;
  const replay = await tick(p, { planningItemId: itemId, line: 3, evidence: 'Already there' }, operationId);
  assert.equal((await stored(p, itemId)).version, version);
  assert.equal(replay.result.comment.commentId, done.result.comment.commentId);
  assert.equal((await list(p, { id: itemId, reconcile: false })).comments.length, 1);
  // A real tick replays once too.
  const id = randomUUID();
  await tick(p, { planningItemId: itemId, line: 1, evidence: 'One' }, id);
  await tick(p, { planningItemId: itemId, line: 1, evidence: 'One' }, id);
  const read = await list(p, { id: itemId, reconcile: false });
  assert.deepEqual(read.comments.map(comment => comment.text).sort(), ['Already there', 'One']);
});

test('tick-planning-item retries a version race and re-applies only its own line, keeping the other edit (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = await tickIssue(p);
  let raced = false;
  const mutation = p.mutation;
  p.mutation = async (name, args) => {
    const command = JSON.parse(args.command);
    if (!raced && command.action === 'put-planning-item') {
      raced = true;
      // Another writer ticks line 4 and retitles the Item between this tick's read and its write.
      const operationId = randomUUID();
      await mutation(name, {
        operationId,
        command: JSON.stringify({
          action: 'put-planning-item',
          operationId,
          itemId,
          expectedVersion: command.expectedVersion,
          title: 'Retitled',
          body: tickBody.replace('- [ ] Test:', '- [x] Test:'),
        }),
      });
    }
    return mutation(name, args);
  };
  const result = await tick(p, { planningItemId: itemId, line: 1, evidence: 'Mine' });
  assert.equal(result.result.retries, 1);
  const item = await stored(p, itemId);
  assert.equal(item.title, 'Retitled');
  assert.match(item.body, /- \[x\] One call ticks a line/);
  assert.match(item.body, /- \[x\] Test: two concurrent ticks survive/);
  assert.match(item.body, /- \[ \] A clear error on no match/);
});

test('tick-planning-item: two concurrent ticks on different lines both survive (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = await tickIssue(p);
  // Convex runs each mutation as one serializable transaction; the fixture's handlers do not, so serialize them here.
  let queue = Promise.resolve();
  const mutation = p.mutation;
  p.mutation = (name, args) => {
    const run = queue.then(() => mutation(name, args));
    queue = run.catch(() => {});
    return run;
  };
  const results = await Promise.all([
    tick(p, { planningItemId: itemId, line: 1, evidence: 'Evidence one' }),
    tick(p, { planningItemId: itemId, line: 'A clear error', evidence: 'Evidence two' }),
    tick(p, { planningItemId: itemId, line: 4, evidence: 'Evidence four' }),
  ]);
  assert.deepEqual(results.map(result => result.result.ticked.line).sort(), [1, 2, 4]);
  const read = await list(p, { id: itemId, reconcile: false });
  assert.equal(read.item.body.match(/- \[x\]/g).length, 4);
  assert.doesNotMatch(read.item.body, /- \[ \]/);
  assert.deepEqual(read.comments.map(comment => comment.text).sort(), [
    'Evidence four',
    'Evidence one',
    'Evidence two',
  ]);
});

test('tick-planning-item names the missing checkboxes of a body without any (66667155)', async t => {
  const s = await setup(t),
    p = port(s);
  const itemId = (await put(p, { kind: 'issue', title: 'Plain', body: 'No boxes here.' })).result.itemId;
  await assert.rejects(
    tick(p, { planningItemId: itemId, line: 1, evidence: 'x' }),
    /no Done-when checkboxes/,
  );
  assert.throws(
    () => hostedAgentCommandSchemas['tick-planning-item'].parse({ line: 1, evidence: 'x' }),
    /planningItemId/,
  );
});
