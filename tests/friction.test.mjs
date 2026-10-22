// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { readImprovements, formatImprovements } from '../dist/improve.js';
import { frictionEvents } from '../dist/friction.js';
import { buildWorkRecords, recordReferences } from '../dist/work-exchange-records.js';
import { frictionReceipt } from '../dist/friction-auto.js';
import { trustAgents } from './autonomy-fixture.mjs';
import { ForgeError } from '../dist/errors.js';
import { retryWorkPhase } from '../dist/work-retry.js';
import { withWorkLockOptions } from '../dist/work-lock.js';
import { withRetryObservation } from '../dist/friction-retry.js';
import { captureAutomatic } from '../dist/friction-auto.js';

const cli = resolve('dist/cli.js');
const exec = promisify(execFile);
const capture = (agent, input = {}) =>
  agent.dispatch({
    action: 'friction',
    title: 'Check interrupted',
    detail: 'Runner stopped',
    area: 'checks',
    ...input,
  });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-friction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  return { root, agent, store: agent.work.store };
}
const groups = store => readImprovements(store).result.groups;
async function lane(agent, extra = {}) {
  return (await agent.dispatch({ action: 'start', outcome: 'Improve workflow', ...extra })).result;
}
async function checkedLane(agent, extra = {}) {
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'console.log("ok")'],
  });
  const start = await lane(agent, extra);
  writeFileSync(join(start.path, 'file.txt'), 'improved\n');
  const result = (await agent.dispatch({ action: 'finish', laneId: start.laneId, message: 'Improve' }))
    .result;
  assert.equal(result.run.status, 'passed');
  return { start, result };
}

test('two concurrent Lane processes capture independent records, replay safely and leave source untouched', async t => {
  const { root, agent, store } = fixture(t);
  const lanes = [await lane(agent), await lane(agent)];
  const requests = lanes.map((item, i) => ({
    operationId: randomUUID(),
    laneId: item.laneId,
    title: `Friction ${i}`,
    detail: 'Extra work',
    area: 'workflow',
  }));
  const run = request =>
    exec(process.execPath, [cli, 'agent', root, 'friction', JSON.stringify(request)], {
      env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '60000' },
    });
  const results = await Promise.all(requests.map(run));
  assert.ok(results.every(result => JSON.parse(result.stdout).result.kind === 'capture'));
  assert.equal(frictionEvents(store).length, 2);
  const saved = store.select('lanes', lanes[0].laneId);
  assert.equal(saved.head, lanes[0].head);
  await Promise.all(requests.map(run));
  assert.equal(frictionEvents(store).length, 2);
  await assert.rejects(
    run({ ...requests[0], detail: 'Changed request' }),
    error => JSON.parse(error.stderr).error.code === 'WORK_OPERATION_CHANGED',
  );
  assert.equal(frictionEvents(store).length, 2);
});

test('normalization clusters near duplicates, retains records and totals reported costs', async t => {
  const { agent, store } = fixture(t);
  await capture(agent, { title: 'Check interrupted!', cost: { minutes: 4, retries: 1 } });
  await capture(agent, {
    title: '  INTERRUPTED check ',
    area: 'CHECKS',
    cost: { minutes: 6, retries: 2 },
    workaround: 'Local check',
  });
  await capture(agent, { title: 'Check interrupted', area: 'sync' });
  const list = groups(store);
  assert.equal(list.length, 2);
  assert.equal(list[0].count, 2);
  assert.deepEqual(list[0].cost, { minutes: 10, retries: 3 });
  assert.equal(list[0].records.length, 2);
  assert.equal(list[0].records[1].workaround, 'Local check');
  assert.equal(list[1].costReported, false);
  assert.ok(list[0].firstSeen <= list[0].lastSeen);
  assert.equal(
    formatImprovements(readImprovements(store).result),
    formatImprovements(readImprovements(store).result),
  );
});

test('capture without operationId replays with resolved pins; invalid Lane and fields leave Work unchanged', async t => {
  const { agent, store } = fixture(t);
  const first = await capture(agent);
  assert.ok(first.result.id);
  assert.equal((await capture(agent, first.result.resolved)).result.id, first.result.id);
  const revision = store.revision();
  await assert.rejects(capture(agent, { laneId: randomUUID() }), e => e.code === 'NOT_FOUND');
  await assert.rejects(capture(agent, { cost: { minutes: -1 } }), e => e.code === 'BAD_ARGUMENT');
  assert.equal(store.revision(), revision);
});

test('triage retains decisions, fixed Lane links, reopen and original-operation replay', async t => {
  const { agent, store } = fixture(t);
  const report = (await capture(agent)).result,
    fixing = await lane(agent);
  const planned = {
    action: 'friction-triage',
    operationId: randomUUID(),
    frictionIds: [report.id],
    status: 'planned',
    reason: 'Next slice',
  };
  await agent.dispatch(planned);
  assert.equal(groups(store)[0].status, 'planned');
  await agent.dispatch({
    ...planned,
    operationId: randomUUID(),
    status: 'fixed',
    laneId: fixing.laneId,
    reason: 'Fixed check handling',
  });
  assert.deepEqual(groups(store)[0].fixedBy, [fixing.laneId]);
  await agent.dispatch({
    ...planned,
    operationId: randomUUID(),
    status: 'open',
    reason: 'Regression observed',
  });
  await agent.dispatch(planned);
  assert.equal(groups(store)[0].status, 'open');
  await agent.dispatch({
    ...planned,
    operationId: randomUUID(),
    status: 'dropped',
    reason: 'Superseded approach',
  });
  assert.equal(groups(store)[0].status, 'dropped');
  await assert.rejects(
    agent.dispatch({ ...planned, operationId: randomUUID(), status: 'fixed' }),
    e => e.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(
    agent.dispatch({ ...planned, operationId: randomUUID(), frictionIds: [randomUUID()] }),
    e => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    agent.dispatch({ ...planned, reason: 'Changed' }),
    e => e.code === 'WORK_OPERATION_CHANGED',
  );
  assert.equal(frictionEvents(store).filter(event => event.kind === 'triage').length, 4);
});

for (const citation of ['start', 'finish'])
  test(`${citation} citations close only on landing and can be explicitly reopened`, async t => {
    const { agent, store } = fixture(t);
    const report = (await capture(agent)).result;
    const { start, result } = await checkedLane(
      agent,
      citation === 'start' ? { frictionIds: [report.id] } : {},
    );
    if (citation === 'finish') {
      const before = frictionEvents(store).length;
      await assert.rejects(
        agent.dispatch({
          action: 'finish',
          laneId: start.laneId,
          message: 'Improve',
          ...result.resolved,
          frictionIds: [report.id],
        }),
        e => e.code === 'WORK_OPERATION_CHANGED',
      );
      assert.equal(frictionEvents(store).length, before);
    }
    if (citation === 'finish')
      await agent.dispatch({
        action: 'finish',
        laneId: start.laneId,
        message: 'Cite fix',
        frictionIds: [report.id],
      });
    assert.equal(groups(store)[0].status, 'open');
    await agent.dispatch({ action: 'complete', laneId: start.laneId });
    assert.equal(groups(store)[0].status, 'open');
    await agent.dispatch({ action: 'accept', viewId: result.view.viewId });
    assert.equal(groups(store)[0].status, 'fixed');
    assert.deepEqual(groups(store)[0].fixedBy, [start.laneId]);
    await agent.dispatch({
      action: 'friction-triage',
      frictionIds: [report.id],
      status: 'open',
      reason: 'Still reproducible',
    });
    assert.equal(groups(store)[0].status, 'open');
  });

test('interrupted and infrastructure check completion is captured once per run, ordinary failure is not', async t => {
  const { agent, store } = fixture(t);
  const { result } = await checkedLane(agent);
  const passed = store.select('runs', result.run.runId);
  const ids = [];
  for (const status of ['interrupted', 'runner-unavailable', 'failed', 'failed']) {
    const id = randomUUID();
    ids.push(id);
    store.locked(() => {
      const tx = store.records();
      tx.append('runs', {
        ...passed,
        id,
        status,
        ...(ids.length === 4 ? { error: { code: 'RUNNER_DIED', message: 'Synthetic runner failure' } } : {}),
      });
      store.commitRecords(tx);
    });
  }
  const reports = frictionEvents(store).filter(row => row.kind === 'capture');
  assert.equal(reports.length, 3);
  assert.equal(reports.filter(row => row.operationId === ids[0]).length, 1);
  assert.equal(groups(store).find(group => group.title === 'Check infrastructure failed').count, 2);
  for (let i = 0; i < 2; i++) {
    await agent.dispatch({ action: 'observe', operationId: ids[0] });
    store.locked(() => store.save(store.load()));
  }
  assert.equal(frictionEvents(store).length, 3);
});

test('transaction capture reads only changed run headers and the first reportable input, without backfill', async t => {
  const { agent, store } = fixture(t);
  const { start, result } = await checkedLane(agent);
  const passed = store.select('runs', result.run.runId);
  store.locked(() => {
    const data = store.load();
    data.runs = Array.from({ length: 257 }, () => ({
      ...passed,
      id: randomUUID(),
      status: 'interrupted',
    }));
    store.save(data);
  });
  const id = randomUUID();
  const publish = (change, reportable) =>
    store.locked(() => {
      const tx = store.records();
      change(tx);
      const at = tx.at.bind(tx),
        fieldsAt = tx.fieldsAt.bind(tx),
        fieldAt = tx.fieldAt.bind(tx);
      let inputReads = 0;
      t.mock.method(tx, 'at', (collection, ...args) => {
        assert.notEqual(collection, 'runs', 'capture never hydrates a full run');
        return at(collection, ...args);
      });
      t.mock.method(tx, 'fieldsAt', (collection, position) => {
        if (collection === 'runs') assert.equal(position, 257, 'historical run headers remain untouched');
        return fieldsAt(collection, position);
      });
      t.mock.method(tx, 'fieldAt', (collection, position, field, entry) => {
        assert.deepEqual([collection, position, field, entry], ['runs', 257, 'inputs', 0]);
        inputReads++;
        return fieldAt(collection, position, field, entry);
      });
      store.commitRecords(tx);
      assert.equal(inputReads, reportable ? 1 : 0);
    });
  publish(
    tx => tx.append('runs', { ...passed, id, inputs: Array.from({ length: 129 }, () => passed.inputs[0]) }),
    false,
  );
  assert.equal(frictionEvents(store).length, 0);
  publish(tx => tx.patchFields('runs', id, { status: 'interrupted' }), true);
  publish(tx => tx.patchFields('runs', id, { status: 'interrupted' }), false);
  publish(tx => {
    const run = tx.find('runs', id);
    tx.replace('runs', run.position, {
      ...run.record,
      status: 'failed',
      error: { code: 'RUNNER_DIED', message: 'Synthetic infrastructure failure' },
    });
  }, true);
  publish(tx => tx.patchFields('runs', id, { details: 'Same operation and class' }), true);
  const reports = frictionEvents(store);
  assert.equal(reports.length, 2, 'one capture per operation/class, no historical backfill');
  assert.ok(reports.every(report => report.operationId === id && report.laneId === start.laneId));
});

test('sync conflict is captured in Work once and replay leaves occurrence count unchanged', async t => {
  const { agent, store } = fixture(t);
  const report = (await capture(agent, { title: 'Unrelated' })).result;
  const a = await checkedLane(agent),
    b = await lane(agent);
  writeFileSync(join(b.path, 'file.txt'), 'other\n');
  await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'Other' });
  await agent.dispatch({ action: 'accept', viewId: a.result.view.viewId });
  const request = { action: 'sync', laneId: b.laneId, operationId: randomUUID() };
  const conflict = await agent.dispatch(request);
  assert.equal(conflict.result.status, 'conflict');
  await agent.dispatch({ ...request, ...conflict.result.resolved });
  assert.equal(groups(store).find(group => group.title === 'Sync conflict').count, 1);
  assert.equal(groups(store).find(group => group.frictionIds.includes(report.id)).status, 'open');
});

test('finish bounces add one counted report and a conditional hint, stable on receipt replay', t => {
  const { store } = fixture(t),
    operationId = randomUUID();
  assert.deepEqual(
    frictionReceipt(store, { action: 'finish', operationId }, { status: 'accepted', attempts: [{}] }),
    {},
  );
  const receipt = {
    status: 'accepted',
    terminal: true,
    attempts: [{ error: { code: 'CHANNEL_CHANGED' } }, { error: { code: 'CONTRACT_RESYNC_REQUIRED' } }, {}],
  };
  assert.match(frictionReceipt(store, { action: 'finish', operationId }, receipt).frictionHint, /friction/);
  frictionReceipt(store, { action: 'finish', operationId }, receipt);
  assert.equal(groups(store)[0].count, 2);
  assert.equal(groups(store)[0].cost.retries, 2);
  assert.equal(frictionEvents(store).length, 1);
  receipt.attempts.unshift({ error: { code: 'CHANNEL_CHANGED' } });
  frictionReceipt(store, { action: 'finish', operationId }, receipt);
  frictionReceipt(store, { action: 'finish', operationId }, receipt);
  assert.equal(groups(store)[0].count, 3);
  assert.equal(frictionEvents(store).filter(event => event.kind === 'capture').length, 1);
});

test('exhausted Work retries retain cost without changing the thrown error', async t => {
  const { store } = fixture(t),
    operationId = randomUUID();
  await assert.rejects(
    withWorkLockOptions({ waitMs: 1 }, () =>
      withRetryObservation(
        (id, code, retries) =>
          captureAutomatic(store, {
            operationId: id,
            category: 'work-retries',
            title: 'Work retries exhausted',
            area: 'workflow',
            detail: code,
            retries,
          }),
        () =>
          retryWorkPhase(operationId, () => {
            throw new ForgeError('WORK_STALE', 'Synthetic race');
          }),
      ),
    ),
    e => e.code === 'WORK_STALE',
  );
  assert.equal(groups(store)[0].title, 'Work retries exhausted');
  assert.ok(groups(store)[0].cost.retries >= 1);
});

test('CLI improve JSON and text are stable; seven roadmap records import once into six groups', async t => {
  const { root, agent, store } = fixture(t);
  const rows = JSON.parse(readFileSync(new URL('./fixtures/friction/roadmap.json', import.meta.url), 'utf8'));
  for (const input of rows) await agent.dispatch({ action: 'friction', ...input });
  for (const input of rows) await agent.dispatch({ action: 'friction', ...input });
  assert.equal(frictionEvents(store).length, 7);
  assert.equal(groups(store).length, 6);
  assert.deepEqual(
    new Set(groups(store).flatMap(group => group.records.map(row => row.detail))),
    new Set(rows.map(row => row.detail)),
  );
  const text = () => execFileSync(process.execPath, [cli, 'improve', root], { encoding: 'utf8' });
  assert.equal(text(), text());
  assert.match(text(), /2 occurrence\(s\)/);
  const json = JSON.parse(
    execFileSync(process.execPath, [cli, 'improve', root, '--json'], { encoding: 'utf8' }),
  );
  assert.deepEqual(json.result, readImprovements(store).result);
});

test('friction records survive portable export and full Work saves without backfilling past failures', async t => {
  const { agent, store } = fixture(t);
  const report = (await capture(agent)).result;
  const fixing = await lane(agent, { frictionIds: [report.id] });
  store.locked(() => store.save(store.load()));
  const portable = buildWorkRecords(store.load());
  assert.ok(portable.root.fields.find(field => field.name === 'frictionEvents').records.length === 2);
  const cite = frictionEvents(store).find(row => row.kind === 'cite');
  assert.ok(
    recordReferences('frictionEvents', cite).some(
      ref => ref.collection === 'frictionEvents' && ref.key === report.id,
    ),
  );
  assert.ok(
    recordReferences('frictionEvents', cite).some(
      ref => ref.collection === 'lanes' && ref.key === fixing.laneId,
    ),
  );
  const { result } = await checkedLane(agent);
  const run = store.select('runs', result.run.runId);
  store.locked(() => {
    const data = store.load();
    data.runs.push({ ...run, id: randomUUID(), status: 'interrupted' });
    store.save(data);
  });
  store.locked(() => {
    const tx = store.records();
    tx.append('runs', { ...run, id: randomUUID() });
    store.commitRecords(tx);
  });
  assert.equal(frictionEvents(store).filter(row => row.kind === 'capture').length, 1);
});

test('one combined Candidate closes reports cited by both input Lanes', async t => {
  const { agent, store } = fixture(t);
  const ids = [
    (await capture(agent)).result.id,
    (await capture(agent, { title: 'Other friction' })).result.id,
  ];
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'console.log("ok")'],
  });
  const a = await lane(agent, { frictionIds: [ids[0]] });
  const b = await lane(agent, { intentId: a.intentId, frictionIds: [ids[1]] });
  writeFileSync(join(a.path, 'a.txt'), 'a\n');
  writeFileSync(join(b.path, 'b.txt'), 'b\n');
  await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'Sibling fix' });
  const accepted = await agent.dispatch({
    action: 'finish',
    laneId: a.laneId,
    with: [b.laneId],
    message: 'Combined fix',
    accept: true,
  });
  assert.equal(accepted.result.status, 'accepted');
  assert.ok(groups(store).every(group => group.status === 'fixed'));
  assert.deepEqual(new Set(groups(store).flatMap(group => group.fixedBy)), new Set([a.laneId, b.laneId]));
});

test('planning needs no extra explanation; dropping retains its required reason', async t => {
  const { agent, store } = fixture(t);
  const report = (await capture(agent)).result;
  await agent.dispatch({ action: 'friction-triage', frictionIds: [report.id], status: 'planned' });
  assert.equal(groups(store)[0].status, 'planned');
  await assert.rejects(
    agent.dispatch({ action: 'friction-triage', frictionIds: [report.id], status: 'dropped' }),
    e => e.code === 'BAD_ARGUMENT',
  );
});
