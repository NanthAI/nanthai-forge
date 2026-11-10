// SPDX-License-Identifier: Apache-2.0
import { workRecordRows } from './hosted-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const briefs = await import(moduleUrl('../convex/projectBriefings.ts'));
const denied = error => error.data?.code === 'PROJECT_UNAVAILABLE';
test('hosted current Proposed/abandon writes preserve history, lifecycle index, authority and child states', async t => {
  for (const unified of [true]) {
    const s = await setup(t, true, undefined);
    const command = s.item({ status: 'proposed' });
    await s.send(command);
    const brief = await briefs.brief._handler(s.ctx, {
      projectId: s.projectId,
      situation: 'start-intent',
      intentId: command.itemId,
      agent: 'generic',
    });
    assert.equal(brief.context.intentId, command.itemId);
    assert.equal(brief.context.intent.status, 'proposed');
    const plan = { ...command, operationId: randomUUID(), expectedVersion: 1, status: 'open' };
    await s.send(plan);
    const abandon = {
      ...plan,
      operationId: randomUUID(),
      expectedVersion: 2,
      status: 'abandoned',
      reason: 'Superseded by new plan',
    };
    const revision = (await s.read()).data.revision;
    await s.send(abandon, revision);
    await s.send(abandon, revision);
    const group = s.item({ kind: 'initiative', intentIds: unified ? [command.itemId] : [] });
    await s.send(group);
    await s.send({
      ...group,
      operationId: randomUUID(),
      expectedVersion: 1,
      status: 'abandoned',
      reason: 'Stopped Initiative',
    });
    const data = (await s.read()).data;
    assert.deepEqual(
      data.planningItems.filter(item => item.id === command.itemId).map(item => item.status),
      ['proposed', 'open', 'abandoned'],
    );
    assert.equal(data.planningItems.findLast(item => item.id === command.itemId).reason, abandon.reason);
    if (unified) {
      assert.equal(data.intents.find(item => item.id === command.itemId).status, 'abandoned');
      const events = [...workRecordRows(s.tables)]
        .filter(row => row.collection === 'lifecycle' && row.parent === command.itemId)
        .map(row => JSON.parse(row.value));
      assert.deepEqual(
        events.map(event => event.to),
        ['proposed', 'active', 'abandoned'],
      );
      assert.equal(events[2].reason, abandon.reason);
    }
    s.ctx.auth.getUserIdentity = async () => null;
    await assert.rejects(s.send({ ...plan, operationId: randomUUID(), expectedVersion: 3 }), denied);
    await assert.rejects(
      briefs.brief._handler(s.ctx, {
        projectId: s.projectId,
        situation: 'start-intent',
        intentId: command.itemId,
        agent: 'generic',
      }),
      denied,
    );
  }
});
