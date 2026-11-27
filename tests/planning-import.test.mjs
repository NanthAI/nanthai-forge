// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { convexRowJson } from './convex-args.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { planningImportId } from '../dist/work-planning-put.js';
import { importPlanningPut, planningImportPages, planningImportRowSchema } from '../dist/planning-import.js';
import { executeHostedPlanning } from '../dist/hosted-agent-planning.js';
import { exportPlanning } from '../dist/work-planning-state.js';
import { getFunctionName } from 'convex/server';
const { advance } = await import(moduleUrl('../convex/projectPlanRollup.ts'));
const imports = await import(moduleUrl('../convex/projectPlanningImport.ts'));
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const row = (key, patch = {}) => ({
  key,
  source: 'docs/milestones.md',
  kind: 'issue',
  title: `Historical ${key}`,
  ...patch,
});
const rows = input => input.map(value => planningImportRowSchema.parse(value));

async function fixture(t) {
  const previous = process.env.FORGE_PLANNING_IMPORTS;
  process.env.FORGE_PLANNING_IMPORTS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_PLANNING_IMPORTS;
    else process.env.FORGE_PLANNING_IMPORTS = previous;
  });
  const s = await setup(t);
  Object.assign(s.tables.hostedProjects.get(s.projectId), {
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const calls = [];
  const invoke = async (name, input) => {
    calls.push(name);
    const [module, action] = name.split(':');
    const handler = { projectPlanningImport: imports, projectWorkCommand: commands }[module][action];
    const args = { projectId: s.projectId, ...input };
    const value =
      action === 'preview'
        ? await handler._handler(s.ctx, args)
        : await s.transaction(() => handler._handler(s.ctx, args));
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  const port = {
    root: join(s.directory, 'client'),
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    serverFeatures: ['planning-model', 'planning-import-pages'],
    exchange: {},
    query: invoke,
    mutation: invoke,
  };
  const read = async key => {
    const value = await index.detail._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'planningItems',
      id: planningImportId(key),
    });
    return value.value ? JSON.parse(value.value) : null;
  };
  const run = (source, apply, operationId, batchId) =>
    executeHostedPlanning(
      port,
      'owner',
      'planning',
      {
        transfer: { mode: 'import', apply, rows: source, ...(batchId ? { batchId } : {}) },
      },
      operationId,
    );
  return { ...s, calls, port, read, run, invoke };
}

test('an ordinary put cannot claim the import path to assign a missing parent', async t => {
  const s = await fixture(t);
  const command = importPlanningPut(
    planningImportRowSchema.parse(row('old/child', { parentKey: 'old/missing' })),
    randomUUID(),
  );
  await assert.rejects(
    s.invoke('projectWorkCommand:command', {
      operationId: command.operationId,
      command: JSON.stringify(command),
    }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(await s.read('old/child'), null);
});

test('an import page schedules one check after the batch and never closes imported open Items', async t => {
  const s = await fixture(t);
  const checks = [];
  const original = s.ctx.scheduler.runAfter.bind(s.ctx.scheduler);
  s.ctx.scheduler.runAfter = (delay, fn, args) =>
    getFunctionName(fn) === 'projectPlanRollup:advance'
      ? Promise.resolve(`rollup-${checks.push(args)}`)
      : original(delay, fn, args);
  const operationId = randomUUID();
  const source = [
    row('import/parent', { status: 'open' }),
    row('import/child', {
      parentKey: 'import/parent',
      status: 'open',
      body: '## Done when\n- [x] Historical checkbox',
    }),
    row('import/other', { status: 'open', body: '## Done when\n- [x] Already recorded' }),
  ];
  const batchId = randomUUID();
  await s.run(source, true, operationId, batchId);
  await s.run(source, true, operationId, batchId);
  assert.equal(checks.length, 1);
  await advance._handler(s.ctx, checks.shift());
  assert.equal(checks.length, 0);
  for (const entry of source) assert.equal((await s.read(entry.key)).status, 'open');
});

test('source-agnostic review writes nothing; apply keeps closed history, parent/order, source and original dates without landing evidence', async t => {
  const s = await fixture(t),
    operationId = randomUUID();
  const source = [
    row('old/child', {
      status: 'abandoned',
      reason: 'wont-do',
      initiativeKey: 'old/milestone',
      parentKey: 'old/parent',
      fields: { order: 'F', type: 'Task' },
    }),
    row('old/parent', {
      initiativeKey: 'old/milestone',
      createdAt: '2024-01-02',
      closedAt: '2024-03-05',
      originalHandle: '@river',
    }),
    row('old/milestone', { kind: 'initiative', title: 'Previous milestone' }),
    row('not-selected', { selected: false }),
  ];
  const count = () => Object.values(s.tables).reduce((total, table) => total + table.size, 0);
  const before = count(),
    preview = await s.run(source, false, operationId);
  assert.equal(count(), before);
  assert.equal(preview.result.applyRequested, false);
  assert.equal(preview.result.rows.filter(value => value.action === 'create').length, 3);
  const applied = await s.run(source, true, operationId);
  assert.equal(applied.result.created.length, 3);
  const parent = await s.read('old/parent'),
    child = await s.read('old/child');
  assert.equal(parent.status, 'closed');
  assert.equal(parent.imported.createdAt, '2024-01-02');
  assert.equal(parent.imported.closedAt, '2024-03-05');
  assert.equal(parent.imported.originalHandle, '@river');
  assert.notEqual(parent.at, parent.imported.createdAt);
  assert.equal(child.status, 'abandoned');
  assert.equal(child.reason, 'wont-do');
  assert.equal(child.parentId, parent.id);
  assert.equal(child.initiativeId, planningImportId('old/milestone'));
  assert.equal(child.order, 'F');
  assert.equal(Object.hasOwn(child.imported, 'createdAt'), false);
  assert.equal(await s.read('not-selected'), null);
  assert.equal(s.tables.projectHostedAcceptances.size, 0);
  assert.equal(s.tables.projectHostedSaves.size, 0);
  const exported = JSON.parse(
    exportPlanning({ revision: 1, planningItems: [parent, child], planningComments: [], intents: [] }).json,
  );
  assert.deepEqual(exported.items[0].imported, parent.imported);
});

test('source keys prevent duplicates across imports, preserve later edits, and exact page replay retains its original result', async t => {
  const s = await fixture(t),
    operationId = randomUUID(),
    source = [row('same/key', { createdAt: '2023-01-01' })];
  const first = await s.run(source, true, operationId);
  const item = await s.read('same/key');
  const edit = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: item.id,
    expectedVersion: 1,
    body: 'Edited after import',
  };
  await s.invoke('projectWorkCommand:command', {
    operationId: edit.operationId,
    command: JSON.stringify(edit),
  });
  assert.deepEqual((await s.run(source, true, operationId)).result, first.result);
  const again = await s.run(source, true, randomUUID());
  assert.deepEqual(again.result.created, []);
  assert.deepEqual(again.result.skipped, [item.id]);
  assert.equal((await s.read('same/key')).body, 'Edited after import');
  assert.equal((await s.read('same/key')).version, 2);
  const rekey = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: item.id,
    expectedVersion: 2,
    imported: { ...item.imported, key: 'another/source' },
  };
  await assert.rejects(
    s.invoke('projectWorkCommand:command', {
      operationId: rekey.operationId,
      command: JSON.stringify(rekey),
    }),
    code('BAD_ARGUMENT'),
  );
  assert.equal((await s.read('same/key')).imported.key, 'same/key');
  const page = planningImportPages(rows(source), operationId)[0];
  const changed = { ...page, rows: rows([row('same/key', { title: 'Another payload' })]) };
  await assert.rejects(
    s.invoke('projectPlanningImport:apply', { operationId, request: JSON.stringify(changed) }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('large imported bodies still deduplicate through primary records and chunked compatibility readers', async t => {
  const s = await fixture(t);
  const source = [row('large/body', { body: 'historical text '.repeat(8000) })];
  const first = await s.run(source, true, randomUUID());
  assert.equal(first.result.created.length, 1);
  const preview = await s.run(source, false, randomUUID());
  assert.equal(preview.result.rows[0].action, 'skip');
  const again = await s.run(source, true, randomUUID());
  assert.deepEqual(again.result.created, []);
  assert.deepEqual(again.result.skipped, first.result.created);
});

test('a lost apply reply reconciles the committed page under its original operation without repeating effects', async t => {
  const s = await fixture(t),
    operationId = randomUUID(),
    source = [row('lost/reply')];
  const mutate = s.port.mutation;
  let lost = true;
  s.port.mutation = async (...args) => {
    const result = await mutate(...args);
    if (lost) {
      lost = false;
      throw new Error('Synthetic lost reply');
    }
    return result;
  };
  const uncertain = await s.run(source, true, operationId);
  assert.equal(uncertain.result.status, 'failed');
  assert.equal(uncertain.result.applyRequested, true);
  assert.deepEqual(uncertain.result.created, []);
  const item = await s.read('lost/reply');
  assert.equal(item.version, 1);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority.epoch = 2;
  const reconciled = await s.run(source, true, operationId);
  assert.equal(reconciled.result.status, 'complete');
  assert.deepEqual(reconciled.result.created, [item.id]);
  assert.equal((await s.read('lost/reply')).version, 1);
  assert.equal(s.tables.projectHostedOperations.size, 1);
});

test('a failed import page rolls back its additions; partial retries retain earlier pages and retry only unfinished pages', async t => {
  const s = await fixture(t),
    operationId = randomUUID();
  const original = s.port.mutation;
  let fail = true;
  s.port.mutation = (name, args) => {
    if (fail && JSON.parse(args.request).page === 1) throw new Error('Synthetic transfer interruption');
    return original(name, args);
  };
  const source = Array.from({ length: 205 }, (_, n) => row(`part/${n}`));
  const partial = await s.run(source, true, operationId);
  assert.equal(partial.result.status, 'partial');
  assert.equal(partial.result.created.length, 100);
  assert.equal(partial.result.failedPage, 1);
  assert.equal(partial.result.pendingKeys.length, 105);
  fail = false;
  s.calls.length = 0;
  const completed = await s.run(source, true, operationId);
  assert.equal(completed.result.created.length, 205);
  assert.equal(s.calls.filter(name => name === 'projectPlanningImport:apply').length, 2);
  assert.equal((await s.read('part/204')).status, 'closed');
  const bad = planningImportPages(
    rows([row('rollback/first'), row('rollback/second', { initiativeKey: 'absent' })]),
    randomUUID(),
  )[0];
  await assert.rejects(
    s.invoke('projectPlanningImport:apply', { operationId: randomUUID(), request: JSON.stringify(bad) }),
    code('NOT_FOUND'),
  );
  assert.equal(await s.read('rollback/first'), null);
});

test('authorised owner devices can apply; anonymous, unaffiliated accounts and revoked devices cannot read or apply', async t => {
  const s = await fixture(t),
    batchId = randomUUID();
  const page = planningImportPages(rows([row('access')]), batchId)[0];
  const args = { operationId: randomUUID(), request: JSON.stringify(page) };
  const original = s.ctx.auth.getUserIdentity;
  s.ctx.auth.getUserIdentity = async () => null;
  await assert.rejects(s.invoke('projectPlanningImport:preview', args), code('PROJECT_UNAVAILABLE'));
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'outsider' });
  await assert.rejects(s.invoke('projectPlanningImport:apply', args), code('PROJECT_UNAVAILABLE'));
  s.tables.cliCredentials.set('credential', {
    _id: 'credential',
    credentialId: 'device-key',
    owner: 'owner',
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 1000000,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device-key' });
  assert.equal((await s.invoke('projectPlanningImport:apply', args)).created.length, 1);
  s.tables.cliCredentials.get('credential').revoked = true;
  await assert.rejects(s.invoke('projectPlanningImport:preview', args), code('AUTH_REVOKED'));
  s.ctx.auth.getUserIdentity = original;
});

test('preparation preserves normal planning read access without granting planning writes', async t => {
  const s = await fixture(t);
  s.tables.hostedProjects.get(s.projectId).visibility = 'private';
  s.tables.projectReaders.set('member', { _id: 'member', projectId: s.projectId, reader: 'reader' });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'reader' });
  const source = [row('read-only/review')],
    operationId = randomUUID();
  assert.equal((await s.run(source, false, operationId)).result.rows[0].action, 'create');
  assert.equal((await s.run(source, true, operationId)).result.error.code, 'PROJECT_UNAVAILABLE');
  s.tables.projectReaders.delete('member');
  assert.equal((await s.run(source, false, randomUUID())).result.error.code, 'PROJECT_UNAVAILABLE');
});

test('public preparation does not reveal source-key matches hidden by the existing plan visibility rule', async t => {
  const s = await fixture(t);
  const source = [
    row('public/initiative', { kind: 'initiative', fields: { hidden: true } }),
    row('public/parent', { initiativeKey: 'public/initiative' }),
    row('public/child', { parentKey: 'public/parent' }),
    row('public/hidden', { fields: { hidden: true } }),
    row('public/visible'),
  ];
  await s.run(source, true, randomUUID());
  const project = s.tables.hostedProjects.get(s.projectId);
  project.visibility = 'public';
  project.planVisibility = 'members';
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'visitor' });
  const privatePlan = await s.run(source, false, randomUUID());
  assert(privatePlan.result.rows.every(row => row.action === 'create'));
  project.planVisibility = 'public';
  const publicPlan = await s.run(source, false, randomUUID());
  assert.equal(publicPlan.result.rows.find(row => row.key === 'public/visible').action, 'skip');
  assert(
    publicPlan.result.rows.filter(row => row.key !== 'public/visible').every(row => row.action === 'create'),
  );
  s.tables.projectReaders.set('member', { _id: 'member', projectId: s.projectId, reader: 'visitor' });
  project.planVisibility = 'members';
  const member = await s.run(source, false, randomUUID());
  assert(member.result.rows.every(row => row.action === 'skip'));
});

test('deployment staging keeps preparation available and makes disabled apply leave planning unchanged', async t => {
  const s = await fixture(t),
    operationId = randomUUID(),
    source = [row('staged')];
  delete process.env.FORGE_PLANNING_IMPORTS;
  assert.equal((await s.run(source, false, operationId)).result.rows[0].action, 'create');
  const disabled = await s.run(source, true, operationId);
  assert.equal(disabled.result.error.code, 'HOSTED_ACTION_UNSUPPORTED');
  assert.equal(await s.read('staged'), null);
  assert.equal(s.tables.projectHostedOperations.size, 0);
});

test('staging leaves ordinary full-record edits and completed import replay available', async t => {
  const s = await fixture(t),
    operationId = randomUUID(),
    source = [row('existing/import')];
  const original = await s.run(source, true, operationId),
    item = await s.read('existing/import');
  delete process.env.FORGE_PLANNING_IMPORTS;
  const edit = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: item.id,
    expectedVersion: 1,
    title: 'Edited normally',
    imported: item.imported,
  };
  await s.invoke('projectWorkCommand:command', {
    operationId: edit.operationId,
    command: JSON.stringify(edit),
  });
  assert.equal((await s.read('existing/import')).title, 'Edited normally');
  assert.deepEqual((await s.run(source, true, operationId)).result, original.result);
  assert.equal((await s.read('existing/import')).version, 2);
});

test('1,000 and 2,000 historical Items use ten and twenty bounded apply pages, never per-Item calls', async t => {
  const baseline = await fixture(t);
  let ordinaryWrites = 0;
  for (const method of ['insert', 'patch', 'replace']) {
    const original = baseline.ctx.db[method];
    baseline.ctx.db[method] = async (...args) => {
      const result = await original(...args);
      ordinaryWrites++;
      return result;
    };
  }
  const plain = baseline.item({ status: 'closed' });
  await baseline.invoke('projectWorkCommand:command', {
    operationId: plain.operationId,
    command: JSON.stringify(plain),
  });
  assert.equal(baseline.tables.projectPlanningAudit.size, 1, 'a live creation can seed History');
  const measurements = [];
  for (const size of [1000, 2000]) {
    const s = await fixture(t),
      meter = meterReads(s.ctx);
    let writes = 0,
      writeBytes = 0,
      maxPageWrites = 0;
    for (const method of ['insert', 'patch', 'replace']) {
      const original = s.ctx.db[method];
      s.ctx.db[method] = async (...args) => {
        const result = await original(...args);
        writes++;
        writeBytes += Buffer.byteLength(convexRowJson(args[1]));
        return result;
      };
    }
    const mutate = s.port.mutation;
    s.port.mutation = async (...args) => {
      const before = writes;
      const result = await mutate(...args);
      maxPageWrites = Math.max(maxPageWrites, writes - before);
      return result;
    };
    const at = performance.now();
    const read = await meter.cost(async () => {
      const result = await s.run(
        Array.from({ length: size }, (_, n) => row(`scale/${n}`)),
        true,
        randomUUID(),
      );
      assert.equal(result.result.created.length, size);
      assert.equal(result.result.pages, size / 100);
    });
    assert.equal(s.calls.length, size / 100);
    assert.equal(s.tables.projectPlanningAudit.size, 0, 'historical imports do not backfill audit summaries');
    assert(maxPageWrites <= 2100, `bounded completed-primary page writes: ${maxPageWrites}`);
    assert(
      maxPageWrites <= ordinaryWrites * 100 + 2,
      `page exceeds existing per-Item writes plus its two receipt writes: ${maxPageWrites}`,
    );
    measurements.push({
      size,
      calls: s.calls.length,
      read,
      writes,
      writeBytes,
      maxPageWrites,
      ordinaryWrites,
      wallMs: Math.round(performance.now() - at),
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  }
  assert(measurements[1].writes <= measurements[0].writes * 2.01);
  assert(measurements[1].read.documents <= measurements[0].read.documents * 2.01);
  t.diagnostic(JSON.stringify(measurements));
});
