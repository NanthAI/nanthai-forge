// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { executeLocalCheck } from '../dist/local-checks.js';
const requests = await import(moduleUrl('../convex/projectCheckRequests.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
async function fixture(t, slow = false) {
  let view, check, marker;
  const s = await setup(t, true, async root => {
    marker = join(root, '..', 'executions');
    const agent = new AgentWorkflow(root);
    const lane = (
      await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Hosted check fixture' })
    ).result;
    writeFileSync(join(lane.path, 'a.ts'), 'export const a = 2;\n');
    const cp = (
      await agent.dispatch({
        action: 'checkpoint',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: lane.head,
        message: 'Two',
      })
    ).result;
    view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: cp.head }],
      })
    ).result;
    check = (
      await agent.dispatch({
        action: 'define-check',
        name: 'Source check',
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('fs');if(!fs.readFileSync('a.ts','utf8').includes('= 2;'))process.exit(1);fs.appendFileSync(${JSON.stringify(marker)},'ran'+String.fromCharCode(10));${slow ? 'setTimeout(()=>{},10000)' : ''}`,
        ],
      })
    ).result;
  });
  const generation = await index.ensure._handler(s.ctx, { projectId: s.projectId });
  const runnerId = 'local-runner',
    scope = { projectId: s.projectId, runnerId };
  await requests.connect._handler(s.ctx, { ...scope, name: 'Fixture computer', listening: true });
  const invoke = (ref, args) => requests[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args);
  const transport = { query: invoke, mutation: invoke };
  const queue = (patch = {}) =>
    requests.request._handler(s.ctx, {
      ...scope,
      operationId: randomUUID(),
      viewId: view.viewId,
      head: view.head,
      checkId: check.checkId,
      definition: check.definition,
      ...patch,
    });
  return {
    ...s,
    scope,
    view,
    check,
    marker,
    generation,
    transport,
    queue,
    selection: item => ({ ...scope, operationId: item.operationId }),
  };
}
test('hosted requests execute an exact local View once and reconcile a lost terminal response', async t => {
  const s = await fixture(t),
    before = s.local.store.revision(),
    item = await s.queue();
  assert.equal(s.local.store.revision(), before);
  assert.equal(item.state, 'queued');
  const original = {
    ...s.scope,
    operationId: item.operationId,
    viewId: item.viewId,
    head: item.head,
    checkId: item.checkId,
    definition: item.definition,
  };
  assert.deepEqual(await requests.request._handler(s.ctx, original), item);
  await assert.rejects(
    requests.request._handler(s.ctx, { ...original, head: 'b'.repeat(64) }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(s.queue({ definition: 'b'.repeat(64) }), code('EVIDENCE_CHANGED'));
  let lost = false;
  const transport = {
    ...s.transport,
    mutation: async (ref, args) => {
      const result = await s.transport.mutation(ref, args);
      if (getFunctionName(ref).endsWith(':update') && result.state === 'finished' && !lost) {
        lost = true;
        throw Error('Reply lost');
      }
      return result;
    },
  };
  await assert.rejects(executeLocalCheck(s.root, transport, s.selection(item)), /Reply lost/);
  await executeLocalCheck(s.root, s.transport, s.selection(item));
  const final = await requests.observe._handler(s.ctx, s.selection(item));
  assert.equal(final.report.status, 'passed');
  assert.equal(final.report.runId, item.operationId);
  assert.equal(s.local.store.select('runs', item.operationId).head, s.view.head);
  assert.equal(readFileSync(s.marker, 'utf8'), 'ran\n');
  await assert.rejects(
    requests.update._handler(s.ctx, { ...s.selection(item), report: { ...final.report, status: 'failed' } }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(
    (
      await requests.update._handler(s.ctx, {
        ...s.selection(item),
        report: { ...final.report, status: 'running' },
      })
    ).report.status,
    'passed',
  );
});
test('queued and running cancellation preserve the original request and local run outcome', async t => {
  const s = await fixture(t, true),
    queued = await s.queue();
  await requests.cancel._handler(s.ctx, { projectId: s.projectId, operationId: queued.operationId });
  await executeLocalCheck(s.root, s.transport, s.selection(queued));
  assert.equal(s.local.store.select('runs', queued.operationId), undefined);
  assert.equal(existsSync(s.marker), false);
  const active = await s.queue();
  let cancelled = false;
  const transport = {
    ...s.transport,
    query: async (ref, args) => {
      if (!cancelled) {
        cancelled = true;
        await requests.cancel._handler(s.ctx, { projectId: s.projectId, operationId: active.operationId });
      }
      return s.transport.query(ref, args);
    },
  };
  await executeLocalCheck(s.root, transport, s.selection(active));
  const result = await requests.observe._handler(s.ctx, s.selection(active));
  assert.equal(result.report.status, 'cancelled');
  assert.equal(s.local.store.select('runs', active.operationId).status, 'cancelled');
});
test('current project and runner authority, changed local definitions and deletion use existing owners', async t => {
  const s = await fixture(t),
    item = await s.queue();
  s.caller('outsider');
  await assert.rejects(requests.next._handler(s.ctx, s.scope), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(s.queue(), code('PROJECT_UNAVAILABLE'));
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: s.projectId, contributor: 'other' });
  s.caller('other');
  await assert.rejects(s.queue(), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(requests.claim._handler(s.ctx, s.selection(item)), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    requests.connect._handler(s.ctx, { ...s.scope, name: 'Take over', listening: true }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.tables.projectContributors.delete('grant');
  await assert.rejects(s.queue(), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  await new AgentWorkflow(s.root).dispatch({
    action: 'define-check',
    checkId: s.check.checkId,
    name: 'Changed check',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  await executeLocalCheck(s.root, s.transport, s.selection(item));
  assert.equal((await requests.observe._handler(s.ctx, s.selection(item))).report.status, 'error');
  assert.equal(existsSync(s.marker), false);
  assert.equal(s.local.store.select('runs', item.operationId), undefined);
  s.tables.hostedProjects.get(s.projectId).removal = 'trash';
  await assert.rejects(s.queue(), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get(s.projectId).removal = 'deleting';
  await lifecycle.purge._handler(s.ctx, { projectId: s.projectId });
  assert.equal(s.tables.projectCheckRequests.size, 0);
  assert.equal(s.tables.projectCheckRunners.size, 0);
});
test('disconnect after launch retains a claimed request and reconciles the same local run', async t => {
  const s = await fixture(t),
    item = await s.queue();
  await assert.rejects(
    executeLocalCheck(
      s.root,
      {
        ...s.transport,
        query: async () => {
          throw Error('Disconnected');
        },
      },
      s.selection(item),
    ),
    /Disconnected/,
  );
  assert.equal((await requests.observe._handler(s.ctx, s.selection(item))).state, 'claimed');
  await executeLocalCheck(s.root, s.transport, s.selection(item));
  assert.equal(readFileSync(s.marker, 'utf8'), 'ran\n');
  assert.equal((await requests.observe._handler(s.ctx, s.selection(item))).report.status, 'passed');
});
test('format2 indexes rebuild with check choices without changing source or Work', async t => {
  const s = await fixture(t),
    before = await s.read();
  s.tables.projectWorkGenerations.get(s.generation).format = 2;
  const next = await index.ensure._handler(s.ctx, { projectId: s.projectId });
  assert.notEqual(next, s.generation);
  assert.equal(s.tables.projectWorkGenerations.get(next).format, HOSTED_WORK_INDEX_FORMAT);
  const row = [...s.tables.projectWorkRecords.values()].find(
    row => row.generationId === next && row.collection === 'checks',
  );
  assert.equal(JSON.parse(row.value).definition, s.check.definition);
  const after = await s.read();
  assert.equal(after.backupId, before.backupId);
  assert.deepEqual(after.data, before.data);
});

test('a hosted UUID collision cannot relabel another local run as evidence for this request', async t => {
  const s = await fixture(t),
    agent = new AgentWorkflow(s.root),
    operationId = randomUUID();
  const other = (
    await agent.dispatch({
      action: 'define-check',
      name: 'Different check',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
  ).result;
  await agent.dispatch({
    action: 'run',
    operationId,
    viewId: s.view.viewId,
    expectedHead: s.view.head,
    checkId: other.checkId,
  });
  const before = s.local.store.select('runs', operationId),
    item = await s.queue({ operationId });
  await executeLocalCheck(s.root, s.transport, s.selection(item));
  const result = await requests.observe._handler(s.ctx, s.selection(item));
  assert.equal(result.report.status, 'error');
  assert.equal(result.report.runId, null);
  assert.deepEqual(s.local.store.select('runs', operationId), before);
  assert.equal(existsSync(s.marker), false);
});

test('a retained foreign request cannot launch a local command through the runner client', async t => {
  const s = await fixture(t),
    item = await s.queue();
  s.tables.projectCheckRequests.get(item._id).actor = 'former-requester';
  const before = s.local.store.revision();
  await assert.rejects(
    executeLocalCheck(s.root, s.transport, s.selection(item)),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.local.store.revision(), before);
  assert.equal(s.local.store.select('runs', item.operationId), undefined);
  assert.equal(existsSync(s.marker), false);
});
