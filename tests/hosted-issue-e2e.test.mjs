// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const startModule = await import(moduleUrl('../convex/projectHostedStart.ts'));
const { move } = await import(moduleUrl('../convex/projectPlanningStart.ts'));
const { fold } = await import(moduleUrl('../convex/projectInitiativeWorkFold.ts'));
const { advance } = await import(moduleUrl('../convex/projectPlanRollup.ts'));
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
    if (name === 'projectItemWork:read')
      return f.transaction('itemWork', itemWork.read, { ...args, projectId: f.projectId });
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
    serverFeatures: [...hostedContractFeatures, 'planning-status-worker'],
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
  const wakes = [];
  const schedule = s.ctx.scheduler.runAfter.bind(s.ctx.scheduler);
  s.ctx.scheduler.runAfter = (delay, ref, args) =>
    getFunctionName(ref) === 'projectPlanRollup:advance'
      ? Promise.resolve(`rollup-${wakes.push(args)}`)
      : schedule(delay, ref, args);
  const drain = async () => {
    for (let i = 0; wakes.length && i < 20; i++) await advance._handler(s.ctx, wakes.shift());
    assert.deepEqual(wakes, []);
  };
  const bridged = new Set();
  const bridge = async name => {
    // Bridge the canonical Intent + Lane heads and the landed-Lane evidence into the Plan fixture.
    // The actual scheduled handlers decide status, once per scheduled function.
    for (const head of f.tables.projectHostedRecordHeads.values()) {
      if (!(head.kind === 'intent' && head.key === issue) && !(head.kind === 'lane' && head.parent === issue))
        continue;
      s.tables.projectHostedRecordHeads.set(head._id, { ...head, projectId: s.projectId });
    }
    for (const overlap of f.tables.projectHostedOverlapLanes.values()) {
      if (overlap.intentId !== issue) continue;
      s.tables.projectHostedOverlapLanes.set(overlap._id, { ...overlap, projectId: s.projectId });
    }
    for (const task of f.tables._scheduled_functions.values()) {
      if (task.name !== name || bridged.has(task._id)) continue;
      bridged.add(task._id);
      const args = { ...task.args[0], projectId: s.projectId };
      if (name === 'projectPlanningStart:move') await move._handler(s.ctx, args);
      else await fold._handler(s.ctx, args);
    }
    await drain();
  };
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
    await bridge('projectPlanningStart:move');
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
    await bridge('projectInitiativeWorkFold:fold');
    return receipt;
  };
  return { s, f, p, issue, begin, land, bridge, drain };
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

test('closes + every Done-when box ticked: the landing fold closes the Issue even with completeOnAccept off, and reads write nothing', async t => {
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
  const events = w.s.tables.projectWorkEvents.size;
  const first = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(first.item.intent, 'completed');
  assert.equal(first.item.status, 'closed');
  assert.equal(first.item.reason, 'Done: linked work finished');
  assert.equal(first.reconciled, undefined);
  assert.equal(w.s.tables.projectWorkEvents.size, events);
  // The healthy path reads the workspace, item, comments and one Item work reply; it never writes.
  assert.equal(w.p.calls.filter(name => name === 'projectItemWork:read').length, 1);
  assert.equal(w.p.calls.filter(name => name === 'projectHostedPlanning:intentStates').length, 0);
  // Incident d4b68402/16093ed1: the Item read names the landed Lane and its receipt, not just a status.
  assert.equal(first.work.total, 1);
  assert.equal(first.work.lanes[0].laneId, started.laneId);
  assert.equal(first.work.lanes[0].state, 'open', 'completeOnAccept off keeps the Lane open');
  assert.equal(first.work.lanes[0].receipt.receiptId, receipt.id, 'and it still names its landing');
  // Idempotent: another read, and a replayed completion tick, change nothing.
  await w.f.materialize(receipt.id);
  await w.bridge('projectInitiativeWorkFold:fold');
  const again = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(again.item.status, 'closed');
  assert.equal(again.reconciled, undefined);
  assert.equal(w.s.tables.projectWorkEvents.size, events);
});

test('closes + open Done-when lines: reads explain the hold without writing, and the final tick closes the Issue', async t => {
  const w = await world(t, { ticks: ['x', ' ', ' '], completeOnAccept: false });
  const started = await w.begin();
  await w.land(started.lane);
  const first = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(first.item.status, 'in-progress', 'a landing alone never closes an Issue with open lines');
  assert.equal(first.item.intent, 'completed');
  const [held] = first.reconciled.held;
  assert.equal(held.openLines, 2);
  assert.deepEqual(held.lines, ['line 2', 'line 3']);
  const after = await read(w.p, { id: w.issue, reconcile: false });
  assert.equal(after.item.version, first.item.version);
  assert.equal(after.comments.filter(c => /still open/.test(c.text)).length, 0);
  const events = w.s.tables.projectWorkEvents.size;
  assert.equal((await read(w.p, { id: w.issue, reconcile: true })).reconciled.held.length, 1);
  assert.equal(w.s.tables.projectWorkEvents.size, events);
  await run(w.p, 'tick-planning-item', { planningItemId: w.issue, line: 2, evidence: 'Checked' });
  await w.drain();
  assert.equal((await read(w.p, { id: w.issue })).item.status, 'in-progress');
  await run(w.p, 'tick-planning-item', { planningItemId: w.issue, line: 3, evidence: 'Checked' });
  await w.drain();
  const done = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(done.item.status, 'closed');
  assert.equal(done.reconciled, undefined);
});

test('completeOnAccept on: the Lane completes with the Intent and the Issue closes', async t => {
  const w = await world(t, { ticks: ['x'], completeOnAccept: true });
  const started = await w.begin();
  const receipt = await w.land(started.lane);
  assert.equal(await intentStatus(w, started.intentId), 'completed');
  assert.equal((await w.f.readLane(started.laneId)).state, 'completed');
  const seen = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(seen.item.status, 'closed');
  // The closed Item still names what landed (1c2ab97a): the Lane, landed, with its receipt.
  assert.deepEqual(
    seen.work.lanes.map(lane => [lane.laneId, lane.state, lane.receipt?.receiptId]),
    [[started.laneId, 'landed', receipt.id]],
  );
});

test('an active sibling Lane keeps the Intent and the Issue open until it lands too', async t => {
  const w = await world(t, { ticks: ['x'], completeOnAccept: false });
  const first = await w.begin();
  const sibling = await w.begin();
  assert.equal(sibling.intentId, first.intentId);
  assert.notEqual(sibling.laneId, first.laneId);
  await w.land(first.lane);
  assert.equal(await intentStatus(w, first.intentId), 'active', 'a pinned or unlanded sibling keeps it open');
  const mid = await read(w.p, { id: w.issue, reconcile: true });
  assert.equal(mid.item.status, 'in-progress');
  assert.equal(mid.item.intent, 'active');
  assert.equal(mid.reconciled, undefined, 'no hold comment while work is running');
  await w.land(sibling.lane);
  assert.equal(await intentStatus(w, first.intentId), 'completed');
  assert.equal((await read(w.p, { id: w.issue, reconcile: true })).item.status, 'closed');
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
