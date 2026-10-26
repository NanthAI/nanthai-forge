// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
export const api = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
export const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
export const lanes = await import(moduleUrl('../convex/projectHostedLanes.ts'));
export const cascade = await import(moduleUrl('../convex/projectHostedLifecycleCascade.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const code = value => error => (error.data?.code ?? error.code) === value;
export const maxima = {};
export async function lifecycleFixture() {
  const f = await saveFixture();
  f.tables._scheduled_functions = new Map();
  let schedulerFailure = false;
  f.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (_delay, ref, args) => {
        if (schedulerFailure) throw Error('synthetic scheduler unavailable');
        return ctx.db.insert('_scheduled_functions', { name: getFunctionName(ref), args, state: 'pending' });
      },
    };
  });
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      return await f.transaction(name, fn, args, actor);
    } finally {
      for (const c of f.counts.filter(c => c.name === name)) {
        assert(c.ranges <= 500 && c.documents <= 500, `${name}: bounded reads`);
        assert(c.readBytes < 1024 * 1024 && c.writeBytes < 512 * 1024, `${name}: bounded metadata`);
        assert(
          !c.touched.some(t =>
            [
              'projectBackups',
              'projectWorkRecords',
              'projectWorkEvents',
              'projectWorkGenerations',
              'projectHostedChannels',
              'projectHostedCheckRuns',
              'projectObjects',
            ].includes(t),
          ),
          `${name}: no source/check/main/history hydration`,
        );
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const k of Object.keys(max)) max[k] = Math.max(max[k], c[k]);
      }
      for (const [table, rows] of Object.entries(f.tables))
        if (table.startsWith('projectHostedLifecycle')) {
          const fields = schema.tables[table].export().documentType.value;
          for (const row of rows.values()) {
            assert(
              Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields),
              `${table}: declared fields`,
            );
            for (const [key, field] of Object.entries(fields))
              assert(field.optional || key in row, `${table}.${key}`);
          }
        }
    }
  };
  const run = (name, fn, args) => call(name, { _handler: fn }, args);
  const auth = { projectId: f.projectId, actor: 'owner', authorityEpoch: 1 };
  const read = id =>
    run('lifecycleRead', records.readHostedRecord, { ...auth, kind: 'lane', key: id }).then(r =>
      JSON.parse(r.value),
    );
  const initial = await read(f.laneId),
    intentId = initial.intentId;
  const intent = {
    kind: 'intent',
    id: intentId,
    version: 0,
    at: initial.at,
    outcome: 'Synthetic lifecycle',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: initial.base,
    status: 'active',
  };
  await run('lifecycleSeed', records.writeHostedRecord, { ...auth, expectedVersion: null, record: intent });
  const request = (target = null, overrides = {}) => ({
    operationId: randomUUID(),
    action: 'abandon',
    reason: 'Synthetic abandoned work',
    authorityEpoch: 1,
    target: target ?? { kind: 'lane', laneId: f.laneId, expected: f.expected },
    ...overrides,
  });
  const begin = (r, actor = 'owner') =>
    call(
      'lifecycleBegin',
      api.transition,
      { projectId: f.projectId, request: JSON.stringify(r) },
      actor,
    ).then(JSON.parse);
  const advance = r =>
    call('lifecycleAdvance', api.advance, { projectId: f.projectId, operationId: r.operationId }).then(
      JSON.parse,
    );
  const plan = r =>
    [...f.tables.projectHostedLifecyclePlans.values()].find(p => p.operationId === r.operationId);
  let copiedTasks = 0;
  const transferTasks = () => {
    for (const task of f.scheduled.slice(copiedTasks))
      if (task.name.startsWith('projectHostedLifecycle:'))
        f.insert('_scheduled_functions', { ...task, state: 'pending' });
    copiedTasks = f.scheduled.length;
  };
  const pending = () => [...f.tables._scheduled_functions.values()].filter(t => t.state === 'pending');
  const execute = async () => {
    const t = pending()[0];
    assert(t, 'pending lifecycle tick');
    assert(['projectHostedLifecycle:advanceInternal', 'projectHostedLifecycle:saveWake'].includes(t.name));
    f.patch('_scheduled_functions', t._id, { state: 'running' });
    const result = JSON.parse(
      await call('lifecycleTick', t.name.endsWith(':saveWake') ? api.saveWake : api.advanceInternal, t.args),
    );
    f.patch('_scheduled_functions', t._id, { state: 'success' });
    return result;
  };
  const drain = async () => {
    let ticks = 0;
    transferTasks();
    while (pending().length) {
      assert(++ticks < 1000);
      await execute();
    }
    return ticks;
  };
  const addLane = async (overrides = {}) => {
    const l = { ...initial, id: randomUUID(), ...overrides };
    await run('lifecycleSeed', records.writeHostedRecord, { ...auth, expectedVersion: null, record: l });
    return l;
  };
  const changeLane = async (id, change) => {
    const old = await read(id);
    await run('lifecycleWrite', records.writeHostedRecord, {
      ...auth,
      expectedVersion: old.version,
      record: { ...old, ...change, version: old.version + 1 },
    });
    return read(id);
  };
  const history = (kind, key, cursor = null, actor = 'owner') =>
    call('lifecycleHistory', api.history, { projectId: f.projectId, kind, key, cursor }, actor).then(
      JSON.parse,
    );
  return {
    ...f,
    auth,
    intentId,
    intent,
    initial,
    lifeCall: call,
    lifeRun: run,
    read,
    addLane,
    changeLane,
    request,
    begin,
    advance,
    plan,
    pending,
    execute,
    drain,
    history,
    transferTasks,
    schedulerFailure: v => (schedulerFailure = v),
  };
}
