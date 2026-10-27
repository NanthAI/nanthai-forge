import { effectivePolicy } from '../dist/autonomy-policy.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, preparedCheckpoint, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const { log } = await import(moduleUrl('../convex/projectViewActions.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
test('hosted log pages read only retained run bytes and recheck current read authority', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-hosted-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'source');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    work = new WorkService(root);
  // Explicit project opt-in: this fixture exercises portable local-log recovery.
  const logPolicyData = work.store.load();
  logPolicyData.autonomyPolicy = {
    ...effectivePolicy(logPolicyData),
    checkLogs: { uploadLocal: true, retentionDays: 90 },
  };
  work.store.save(logPolicyData);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic log' })).result;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'Synthetic failure',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(20000)+'\\n✖ retained failure\\n');process.exit(1)"],
    })
  ).result;
  const runId = randomUUID();
  await work.dispatch(
    {
      action: 'run-check',
      operationId: runId,
      viewId: view.viewId,
      expectedHead: view.head,
      checkId: check.checkId,
      expectedDefinition: check.definition,
      expectedEnvironment: work.status().environment.fingerprint,
    },
    work.store.revision(),
  );
  for (let i = 0; i < 400 && !work.status().runs.find(r => r.id === runId)?.endedAt; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(work.status().runs.find(r => r.id === runId).status, 'failed');
  const s = fixture(),
    source = await preparedCheckpoint(s, work.store);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, source.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
  const args = {
    projectId: 'project',
    generationId,
    runId,
    stream: 'stdout',
    offset: 0,
  };
  const page = JSON.parse(await log._handler(s.ctx, args));
  assert.equal(page.nextOffset, 16384);
  assert(page.more);
  const end = JSON.parse(await log._handler(s.ctx, { ...args, offset: page.nextOffset }));
  assert.match(end.text, /✖ retained failure/);
  assert.equal(end.more, false);
  // A retained R2 log is described, never read or returned by the server action.
  const logPin = source.manifest.files.find(file => file.path === `check-${runId}/stdout.log`),
    object = [...s.tables.projectObjects.values()].find(row => row.digest === logPin.sha256),
    original = structuredClone(object),
    originalFetch = globalThis.fetch;
  delete object.storageId;
  Object.assign(object, { location: 'r2', r2Committed: true, r2Key: `v1/p/project/o/${logPin.sha256}` });
  globalThis.fetch = async () => {
    throw new Error('A metadata-only log read must not fetch R2 bytes.');
  };
  try {
    const direct = JSON.parse(await log._handler(s.ctx, args));
    assert.deepEqual(direct.direct, { sha256: logPin.sha256, size: logPin.size });
    assert.equal(direct.text, undefined);
    assert.equal(direct.backupId, backupId);
  } finally {
    globalThis.fetch = originalFetch;
    delete object.location;
    delete object.r2Committed;
    delete object.r2Key;
    Object.assign(object, original);
  }
  await assert.rejects(log._handler(s.ctx, { ...args, offset: -1 }), code('BAD_ARGUMENT'));
  await assert.rejects(log._handler(s.ctx, { ...args, runId: randomUUID() }), code('NOT_FOUND'));
  s.caller('stranger');
  await assert.rejects(log._handler(s.ctx, args), code('PROJECT_UNAVAILABLE'));
  s.caller(null);
  await assert.rejects(log._handler(s.ctx, args), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  const get = s.ctx.storage.getMetadata;
  s.ctx.storage.getMetadata = async id => {
    const value = await get(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return value;
  };
  await assert.rejects(log._handler(s.ctx, args), code('PROJECT_UNAVAILABLE'));
});
