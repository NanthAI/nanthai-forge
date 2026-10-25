// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { localBrief } from '../dist/agent-brief-local.js';

test('Intent briefs and handoff reads list active decisions, overrides and brief superseded links', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-decision-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'synthetic source\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const start = outcome => agent.dispatch({ action: 'start', outcome }).then(response => response.result);
  const lane = await start('Apply recorded owner decisions');
  const other = await start('Unrelated Intent');
  const decide = (what, extra = {}) =>
    agent
      .dispatch({
        action: 'decide',
        target: { kind: 'project' },
        decidedBy: 'Owner',
        what,
        why: 'Recorded reason',
        ...extra,
      })
      .then(response => response.result);
  const project = await decide('Retain native source objects', {
    overrides: { kind: 'default', description: 'Git-native daily store', link: 'docs/decisions.md#7' },
  });
  const target = { kind: 'intent', intentId: lane.intentId };
  const old = await decide('Old contract', { target });
  const current = await decide('Current contract', { target, supersedes: old.id });
  const unrelated = await decide('Other Intent decision', {
    target: { kind: 'intent', intentId: other.intentId },
  });
  const brief = localBrief(agent.work.store, { situation: 'continue-lane', laneId: lane.laneId });
  assert.deepEqual(
    brief.context.decisions.active.map(record => record.id),
    [project.id, current.id],
  );
  assert.deepEqual(brief.context.decisions.superseded, [
    {
      id: old.id,
      target,
      what: 'Old contract',
      status: 'superseded',
      supersededBy: [current.id],
    },
  ]);
  assert.match(brief.full, /Owner decisions/);
  assert.match(brief.full, /Overrides: Git-native daily store \(docs\/decisions.md#7\)/);
  assert.ok(brief.full.includes(`Overrides: decision ${old.id}`));
  assert.ok(brief.full.includes(`Superseded decision ${old.id}: Old contract → ${current.id}`));
  assert.ok(!brief.full.includes(unrelated.id));
  assert.match(brief.copyText, /Owner decisions/);
  assert.ok(brief.copyText.length <= 1200);
  assert.ok(brief.full.length <= 32000);
  await agent.dispatch({ action: 'handoff', laneId: lane.laneId, summary: 'Ready for lead review' });
  const handoff = (await agent.dispatch({ action: 'handoff-read', laneId: lane.laneId })).result;
  assert.deepEqual(handoff.decisions, brief.context.decisions);
  const taken = localBrief(agent.work.store, {
    situation: 'take-handoff',
    messageId: handoff.handoff.operationId,
  });
  assert.deepEqual(taken.context.decisions, brief.context.decisions);
  const planned = localBrief(agent.work.store, { situation: 'start-intent', intentId: lane.intentId });
  assert.deepEqual(planned.context.decisions, brief.context.decisions);
});
