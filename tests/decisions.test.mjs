// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { decisionRecords } from '../dist/decisions.js';
import { decideInputSchema } from '../dist/decision-types.js';
import { parseWork } from '../dist/work-unified-types.js';
import { recordReferences } from '../dist/work-exchange-records.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-decisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.txt'), 'synthetic source\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic decision work' })).result;
  return { root, agent, lane, store: agent.work.store };
}
const command = (extra = {}) => ({
  action: 'decide',
  operationId: randomUUID(),
  target: { kind: 'project' },
  decidedBy: 'Synthetic owner',
  what: 'Use a focused contract check',
  why: 'Keep the implementation loop short',
  overrides: { kind: 'default', description: 'Run every test locally', link: 'docs/agents/workflow.md' },
  ...extra,
});
const list = async (agent, target) =>
  (await agent.dispatch({ action: 'decisions', ...(target ? { target } : {}) })).result.decisions;

test('native decisions retain decider, actor, requester, time and override without a Work format bump', async t => {
  const previousName = process.env.FORGE_AGENT_NAME;
  process.env.FORGE_AGENT_NAME = 'Synthetic requester';
  t.after(() => {
    if (previousName === undefined) delete process.env.FORGE_AGENT_NAME;
    else process.env.FORGE_AGENT_NAME = previousName;
  });
  const { agent, store, lane } = await fixture(t);
  const schema = store.load().schema;
  const input = command({ actor: 'Synthetic builder', tool: 'fixture', decidedAt: '2026-10-24' });
  const created = (await agent.dispatch(input)).result;
  assert.equal(created.kind, 'decision');
  assert.equal(created.schema, 1);
  assert.equal(created.decidedBy, 'Synthetic owner');
  assert.deepEqual(created.actor, { kind: 'agent', name: 'Synthetic builder', tool: 'fixture' });
  assert.equal(created.requester.name, 'Synthetic requester');
  assert.equal(created.requester.kind, 'agent');
  assert.equal(created.decidedAt, '2026-10-24');
  assert.ok(Number.isFinite(Date.parse(created.at)));
  assert.deepEqual(created.overrides, input.overrides);
  assert.equal(store.load().schema, schema);
  assert.equal(store.select('lanes', lane.laneId).head, lane.head);
  assert.equal(store.readRecords().manifest.collections.decisions.count, 1);
  assert.deepEqual(decisionRecords(store), [created]);
  assert.deepEqual(parseWork(store.load()).decisions, [created]);
  const before = store.revision();
  assert.deepEqual(await list(agent), [{ ...created, status: 'active', supersededBy: [] }]);
  assert.equal(store.revision(), before, 'listing does not mutate Work');
});

test('supersession retains the old record and links every explicit replacement, including chains', async t => {
  const { agent, store, lane } = await fixture(t);
  const target = { kind: 'intent', intentId: lane.intentId };
  const old = (await agent.dispatch(command({ target }))).result;
  const replacement = (await agent.dispatch(command({ target, supersedes: old.id, overrides: undefined })))
    .result;
  const last = (await agent.dispatch(command({ target, supersedes: replacement.id }))).result;
  const fork = (await agent.dispatch(command({ target, supersedes: old.id }))).result;
  assert.deepEqual(decisionRecords(store)[0], old, 'earlier immutable fact was not rewritten');
  assert.deepEqual(replacement.overrides, { kind: 'decision', decisionId: old.id });
  const rows = await list(agent, target);
  assert.equal(rows[0].status, 'superseded');
  assert.deepEqual(rows[0].supersededBy, [replacement.id, fork.id]);
  assert.deepEqual(rows[1].supersededBy, [last.id]);
  assert.deepEqual(
    rows.filter(row => row.status === 'active').map(row => row.id),
    [last.id, fork.id],
  );
  assert.deepEqual(await list(agent, { kind: 'project' }), []);
  assert.deepEqual(
    recordReferences('decisions', replacement).sort((a, b) => a.collection.localeCompare(b.collection)),
    [
      { collection: 'decisions', key: old.id },
      { collection: 'intents', key: lane.intentId },
    ],
  );
});

test('unknown-outcome replay returns the original decision after supersession and rejects changed inputs', async t => {
  const { agent, store } = await fixture(t);
  const input = command({ operationId: undefined });
  const first = (await agent.dispatch(input)).result;
  assert.ok(first.resolved.operationId);
  await agent.dispatch(command({ supersedes: first.id }));
  const revision = store.revision();
  assert.deepEqual((await agent.dispatch({ ...input, ...first.resolved })).result.id, first.id);
  assert.equal(store.revision(), revision);
  await assert.rejects(agent.dispatch({ ...input, ...first.resolved, why: 'Changed retry' }), {
    code: 'WORK_OPERATION_CHANGED',
  });
  assert.equal(decisionRecords(store).length, 2);
});

test('invalid Intent, references and empty text do not append or alter decisions', async t => {
  const { agent, store } = await fixture(t);
  const revision = store.revision();
  for (const extra of [
    { target: { kind: 'intent', intentId: randomUUID() } },
    { supersedes: randomUUID() },
    { overrides: { kind: 'decision', decisionId: randomUUID() } },
  ])
    await assert.rejects(agent.dispatch(command(extra)), { code: 'NOT_FOUND' });
  for (const extra of [{ what: ' ' }, { decidedBy: '' }, { why: '' }, { decidedAt: 'yesterday' }])
    await assert.rejects(agent.dispatch(command(extra)), { code: 'BAD_ARGUMENT' });
  assert.equal(store.revision(), revision);
  assert.deepEqual(await list(agent), []);
});

test('portable native export/restore preserves decisions, override links and operation replay', async t => {
  const { root, agent, store, lane } = await fixture(t);
  const input = command({ target: { kind: 'intent', intentId: lane.intentId } });
  const original = (await agent.dispatch(input)).result;
  await agent.dispatch(command({ supersedes: original.id }));
  const before = await list(agent);
  const backup = (await agent.work.dispatch({ action: 'export-work', archive: true }, store.revision()))
    .result;
  const target = join(root, 'restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new AgentWorkflow(target);
  assert.deepEqual(await list(restored), before);
  assert.deepEqual((await restored.dispatch(input)).result, original);
});

test('prepared Phase 5 decisions are ten unique project record requests and remain unapplied', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/phase5-owner-decisions.json', 'utf8'));
  assert.equal(fixture.records.length, 10);
  assert.equal(new Set(fixture.records.map(record => record.operationId)).size, 10);
  for (const record of fixture.records) {
    assert.equal(record.action, 'decide');
    assert.deepEqual(decideInputSchema.parse(record).target, { kind: 'project' });
    assert.equal(record.decidedBy, 'Owner');
    assert.ok(record.why);
    if (record.overrides) assert.ok(record.overrides.description);
  }
  assert.match(fixture.records[9].what, /7-day/);
});
