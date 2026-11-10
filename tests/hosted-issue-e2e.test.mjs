// SPDX-License-Identifier: Apache-2.0
// End to end, planned Issue -> `start {planningItemId}` -> saved Lane -> accepted landing -> the Intent
// and planning state a builder sees (CORE 0b12fcfe lines 1-2). Every hop is the real handler: the Work
// index and planning writes (hosted-planning fixture), the planned start, the acceptance completion tick
// and `projectHostedPlanning.intentStates` (hosted-acceptance fixture). Only the transport between the two
// in-memory databases is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { setup as planningSetup } from './hosted-planning-fixture.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { executeHostedPlanning, plannedIntent, markPlanningStarted } from '../dist/hosted-agent-planning.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import { policyPreset } from '../dist/autonomy-policy.js';

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const actionsV8 = await import(moduleUrl('../convex/projectWorkActionsV8.ts'));
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const planningModule = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const startModule = await import(moduleUrl('../convex/projectHostedStart.ts'));
const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (keyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = keyId;
});

/** The agent's port: planning handlers over the planning fixture, Intent states read from the REAL
 * `intentStates` query of the acceptance fixture's project. Counts every Convex call. */
function port(s, f) {
  installPlanningSearch(s);
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'projectHostedPlanning:intentStates')
      return f.transaction('intentStates', planningModule.intentStates, {
        projectId: f.projectId,
        ids: args.ids,
      });
    const [module, fn] = name.split(':');
    const handler = {
      projectWorkIndex: index,
      projectWorkActions: actions,
      projectWorkActionsV8: actionsV8,
      projectWorkCommand: commands,
      projectHostedPlanningSearch: search,
    }[module][fn];
    return handler._handler(s.ctx, args);
  };
  return {
    calls,
    root: join(s.directory, 'checkout'),
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    exchange: {
      client: {
        query: (ref, args) => invoke(getFunctionName(ref), args),
        action: (ref, args) => invoke(getFunctionName(ref), args),
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
    serverFeatures: [...hostedContractFeatures],
  };
}
const run = (p, action, input) =>
  executeHostedPlanning(p, 'owner', action, hostedAgentCommandSchemas[action].parse(input), undefined);
const read = (p, input = {}) => run(p, 'planning', input).then(response => response.result);

const boxes = ticks => `Why\n\nDone when:\n${ticks.map((tick, i) => `- [${tick}] line ${i + 1}`).join('\n')}`;

/** A planned world: one Issue in the Work index, one project with a real main, the Issue's planned start. */
async function world(t, { ticks = ['x', 'x'], completeOnAccept = false } = {}) {
  const s = await planningSetup(t),
    f = await acceptanceFixture(),
    p = port(s, f);
  const policy = policyPreset('supervised');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, lifecycle: { ...policy.lifecycle, completeOnAccept } },
  });
  const issue = (
    await run(p, 'put-planning-item', { kind: 'issue', title: 'Planned work', body: boxes(ticks) })
  ).result.itemId;
  // `start {planningItemId}`: the CLI resolves the Intent from the Issue, the server opens Intent + Lane.
  const begin = async () => {
    const planned = await plannedIntent(p, issue);
    const result = JSON.parse(
      await f.transaction('start', startModule.start, {
        projectId: f.projectId,
        operationId: randomUUID(),
        authorityEpoch: 1,
        expectedMain: { head: f.main.head, receiptId: f.main.receipt.id },
        intent: planned,
      }),
    );
    await markPlanningStarted(p, issue, randomUUID());
    // A builder's save: the Lane head moves to the saved state.
    const saved = await f.changeLane(result.lane.laneId, {
      head: f.state.sha256,
      sourceVersion: 1,
    });
    return {
      intentId: result.intentId,
      laneId: saved.id,
      lane: {
        laneId: saved.id,
        head: saved.head,
        version: saved.version,
        sourceVersion: saved.sourceVersion,
        lifecycleVersion: saved.lifecycleVersion,
        state: { object: { sha256: saved.head, size: f.state.size }, recipe: null },
      },
    };
  };
  const land = async lane => {
    const main = f.currentMain();
    const base = { head: main.head, receiptId: main.receipt.id };
    const item = await f.makeCandidate([lane], [], { base });
    const { state } = await f.ready(item, { expectedMain: base });
    const { receipt } = await f.accept(state);
    await f.materialize(receipt.id);
    return receipt;
  };
  return { s, f, p, issue, begin, land };
}
const intentStatus = async (w, intentId) =>
  JSON.parse(
    (
      await w.f.runAcceptance(
        'intentRead',
        (await import(moduleUrl('../convex/projectHostedRecords.ts'))).readHostedRecord,
        {
          ...w.f.auth,
          kind: 'intent',
          key: intentId,
        },
      )
    ).value,
  ).status;

test('planned start links the Issue to its Intent although the legacy intentIds stay empty', async t => {
  const w = await world(t);
  const started = await w.begin();
  assert.equal(started.intentId, w.issue, 'the planned Intent shares the Issue id');
  const item = (await read(w.p, { id: w.issue, reconcile: false })).item;
  assert.deepEqual(item.intentIds, [], 'markPlanningStarted never fills the legacy array');
  assert.equal(item.status, 'in-progress');
  assert.equal(item.intent, 'active', 'the link shows as the Intent state, not as intentIds');
});

test('closes + every Done-when box ticked: landing (completeOnAccept off) completes the Intent, the read closes the Issue once, replays add nothing', async t => {
  const w = await world(t, { ticks: ['x', 'x'], completeOnAccept: false });
  const started = await w.begin();
  const receipt = await w.land(started.lane);
  assert.equal(await intentStatus(w, started.intentId), 'completed');
  assert.equal(
    (await w.f.readLane(started.laneId)).state,
    'active',
    'completeOnAccept off keeps the Lane open',
  );
  w.p.calls.length = 0;
  const first = await read(w.p, { id: w.issue });
  assert.equal(first.item.intent, 'completed');
  assert.deepEqual(
    first.reconciled.changed.map(c => [c.id, c.to]),
    [[w.issue, 'closed']],
  );
  assert.equal(first.reconciled.held, undefined);
  const events = w.s.tables.projectWorkEvents.size;
  // The healthy path adds no Convex call beyond the read itself: workspace, item, comments, states, one write.
  assert(w.p.calls.filter(name => name === 'projectHostedPlanning:intentStates').length === 1);
  // Idempotent: another read, and a replayed completion tick, change nothing.
  await w.f.materialize(receipt.id);
  const again = await read(w.p, { id: w.issue });
  assert.equal(again.item.status, 'closed');
  assert.equal(again.reconciled, undefined);
  assert.equal(w.s.tables.projectWorkEvents.size, events);
});

test('closes + open Done-when lines: the Issue holds, names the open lines and the close command, and closes by that command', async t => {
  const w = await world(t, { ticks: ['x', ' ', ' '], completeOnAccept: false });
  const started = await w.begin();
  await w.land(started.lane);
  const first = await read(w.p, { id: w.issue });
  assert.equal(first.item.status, 'in-progress', 'a landing alone never closes an Issue with open lines');
  assert.equal(first.item.intent, 'completed');
  const [held] = first.reconciled.held;
  assert.equal(held.openLines, 2);
  assert.deepEqual(held.lines, ['line 2', 'line 3']);
  assert.match(held.close, /"status":"closed"/);
  const after = await read(w.p, { id: w.issue, reconcile: false });
  assert.match(held.close, new RegExp(`"expectedVersion":${after.item.version},`));
  assert.equal(after.comments.filter(c => /still open/.test(c.text)).length, 1);
  // Retry: still held, no second comment or write.
  const events = w.s.tables.projectWorkEvents.size;
  assert.equal((await read(w.p, { id: w.issue })).reconciled.held.length, 1);
  assert.equal(w.s.tables.projectWorkEvents.size, events);
  // The builder runs the printed close with its evidence: done.
  await run(w.p, 'put-planning-item', {
    itemId: w.issue,
    expectedVersion: after.item.version,
    status: 'closed',
    reason: 'Done-when met, evidence in comments',
  });
  const done = await read(w.p, { id: w.issue });
  assert.equal(done.item.status, 'closed');
  assert.equal(done.reconciled, undefined);
});

test('completeOnAccept on: the Lane completes with the Intent and the Issue closes', async t => {
  const w = await world(t, { ticks: ['x'], completeOnAccept: true });
  const started = await w.begin();
  await w.land(started.lane);
  assert.equal(await intentStatus(w, started.intentId), 'completed');
  assert.equal((await w.f.readLane(started.laneId)).state, 'completed');
  assert.equal((await read(w.p, { id: w.issue })).item.status, 'closed');
});

test('an active sibling Lane keeps the Intent and the Issue open until it lands too', async t => {
  const w = await world(t, { ticks: ['x'], completeOnAccept: false });
  const first = await w.begin();
  const sibling = await w.begin();
  assert.equal(sibling.intentId, first.intentId);
  assert.notEqual(sibling.laneId, first.laneId);
  await w.land(first.lane);
  assert.equal(await intentStatus(w, first.intentId), 'active', 'a pinned or unlanded sibling keeps it open');
  const mid = await read(w.p, { id: w.issue });
  assert.equal(mid.item.status, 'in-progress');
  assert.equal(mid.item.intent, 'active');
  assert.equal(mid.reconciled, undefined, 'no hold comment while work is running');
  await w.land(sibling.lane);
  assert.equal(await intentStatus(w, first.intentId), 'completed');
  assert.equal((await read(w.p, { id: w.issue })).item.status, 'closed');
});

test('every planning read shows the planned link: id read, list and search, empty legacy intentIds notwithstanding (30a4d75d)', async t => {
  const w = await world(t, { ticks: ['x', ' '], completeOnAccept: false });
  const started = await w.begin();
  await w.land(started.lane);
  const byId = (await read(w.p, { id: w.issue, reconcile: false })).item;
  const listed = (await read(w.p, { reconcile: false })).items.find(item => item.id === w.issue);
  const found = (await read(w.p, { search: w.issue, status: 'all' })).items.find(item => item.id === w.issue);
  for (const [name, row] of Object.entries({ byId, listed, found })) {
    assert.deepEqual(row.intentIds ?? [], [], `${name}: legacy array is empty`);
    assert.equal(row.plannedIntentId, w.issue, `${name}: names the Intent this Issue starts`);
  }
  assert.equal(byId.intent, 'completed');
  assert.equal(listed.intent, 'completed');
});
