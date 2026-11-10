// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { jsonToConvex } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const inventory = await import(moduleUrl('../convex/projectPurgeInventory.ts'));
const { finishReadFields } = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const rowsPage = await import(moduleUrl('../convex/projectPurgeRows.ts'));
const retention = await import(moduleUrl('../convex/projectRetention.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const projectWork = await import(moduleUrl('../convex/projectWork.ts'));
const storageInventory = await import(moduleUrl('../convex/projectStorageInventory.ts'));
const storageOwnership = await import(moduleUrl('../convex/projectStorageOwnership.ts'));
const { projectPurgeTables, projectPurgeSpecial, idPaths } = inventory;
const day = 24 * 60 * 60 * 1000;

test('orphan inventory covers every indexed root owner without treating nested generation references as ownership', () => {
  const owners = storageOwnership.storageOwners();
  assert.deepEqual(
    new Set(owners.filter(owner => owner.field === 'projectId').map(owner => owner.table)),
    new Set(Object.keys(projectPurgeTables)),
  );
  assert.deepEqual(
    owners
      .filter(owner => owner.parent === 'projectWorkGenerations')
      .map(owner => [owner.table, owner.field])
      .sort(),
    [
      ['projectReturnPages', 'partitionId'],
      ['projectWorkRecords', 'generationId'],
    ],
  );
  assert.throws(() => storageOwnership.storageOwner('projectGithubImports', 'workIndex.generationId'));
});

test('orphan owner enumeration jumps entire populated owner ranges and resumes without payload scans', async () => {
  const s = state([]);
  for (const owner of ['a', 'b', 'c', 'd', 'e']) {
    if (owner !== 'c') s.tables.hostedProjects.set(owner, { _id: owner, _creationTime: 1 });
    for (let i = 0; i < 1000; i++)
      s.tables.projectWorkRecords.set(`${owner}-${i}`, {
        _id: `${owner}-${i}`,
        _creationTime: i,
        projectId: owner,
        generationId: 'generation',
        collection: 'runs',
        key: `${i}`,
        parent: '',
        position: i,
        value: 'synthetic payload',
      });
  }
  const query = s.ctx.db.query;
  let seeks = 0;
  s.ctx.db.query = table => {
    const q = query(table);
    const take = q.take;
    q.take = n => {
      assert.equal(n, 1);
      seeks++;
      return take(n);
    };
    return q;
  };
  const input = { table: 'projectWorkRecords', field: 'projectId', after: null };
  const first = await storageInventory.ownerPage(s.ctx, input);
  assert.deepEqual(
    first.page.map(row => [row.ownerId, row.exists]),
    [
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', true],
    ],
  );
  assert.equal(seeks, 4, 'one indexed row read per distinct owner despite 1,000 rows in each range');
  assert.equal(first.isDone, false);
  const last = await storageInventory.ownerPage(s.ctx, { ...input, after: first.after });
  assert.deepEqual(
    last.page.map(row => row.ownerId),
    ['e'],
  );
  assert.equal(last.isDone, true);
  assert.equal(s.scheduled.length, 0, 'inventory schedules no work');
});

test('orphan purge rechecks absent ownership and exact pins, preserves live rows and reconciles lost replies', async () => {
  const s = state([]);
  const row = {
    _id: 'orphan',
    _creationTime: 1,
    projectId: 'missing',
    generationId: 'gone',
    collection: 'runs',
    key: 'run',
    parent: '',
    position: 0,
    value: '{}',
  };
  s.tables.projectWorkRecords.set(row._id, row);
  s.tables.projectWorkRecords.set('foreign', { ...row, _id: 'foreign', projectId: 'live' });
  s.tables.hostedProjects.set('live', { _id: 'live', _creationTime: 1 });
  const input = {
    table: 'projectWorkRecords',
    field: 'projectId',
    ownerId: 'missing',
    operationId: randomUUID(),
    part: 'one',
    pins: [{ id: row._id, sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex') }],
  };
  const apply = args => s.transaction(() => storageInventory.purgeOrphans._handler(s.ctx, args));
  s.tables.hostedProjects.set('missing', { _id: 'missing', _creationTime: 1 });
  await assert.rejects(apply(input), /absent owner/);
  s.tables.hostedProjects.delete('missing');
  await assert.rejects(
    apply({ ...input, pins: [{ ...input.pins[0], sha256: 'a'.repeat(64) }] }),
    /pinned row/,
  );
  const result = await apply(input);
  assert.equal(result.deleted, 1);
  assert.ok(result.bytes > 0);
  assert.deepEqual(await apply(input), result, 'unknown outcome replays the committed page receipt');
  await assert.rejects(apply({ ...input, ownerId: 'changed' }), /Replay the original/);
  assert.equal(s.tables.projectWorkRecords.has('orphan'), false);
  assert.equal(s.tables.projectWorkRecords.has('foreign'), true);
  assert.equal(s.scheduled.length, 0, 'finished cleanup has zero idle work');
});

/** Every typed hosted-project reference anywhere in a document, and any `projectId` field. */
function projectFields(table) {
  const fields = new Set(idPaths(table, 'hostedProjects'));
  if ('projectId' in (schema.tables[table].validator.fields ?? {})) fields.add('projectId');
  return [...fields];
}

test('inventory guard: every table that stores a hosted-project id is covered by the purge', () => {
  const owned = Object.keys(schema.tables).filter(table => projectFields(table).length);
  const covered = new Set([...Object.keys(projectPurgeTables), ...Object.keys(projectPurgeSpecial)]);
  const missing = owned.filter(table => !covered.has(table));
  assert.deepEqual(
    missing,
    [],
    `Add these project-owned tables to convex/projectPurgeInventory.ts (with an index that starts with projectId): ${missing.join(', ')}`,
  );
  for (const table of Object.keys(projectPurgeTables)) {
    const { index, scope } = inventory.purgeIndex(table);
    assert.ok(schema.tables[table], `${table} is no longer in the schema; remove it from the purge`);
    assert.deepEqual(
      projectFields(table),
      ['projectId'],
      `${table} must have exactly one project owner field`,
    );
    const found = schema.tables[table].export().indexes.find(item => item.indexDescriptor === index);
    assert.equal(found?.fields[0], 'projectId', `${table}.${index} must start with projectId`);
    if (scope) assert.equal(found.fields[1], 'scope', `${table}.${index} must filter by scope second`);
  }
  for (const table of Object.keys(projectPurgeSpecial))
    assert.ok(schema.tables[table], `${table} special purge step names a missing table`);
  assert.deepEqual(projectFields('hostedProjects'), [], 'the root row has no owner field');
  // Files and scheduled functions are found from the schema, so new references are covered too.
  assert.deepEqual(inventory.rowReferences('projectWorkGenerations').files, [
    'returnCursor',
    'returnSnapshot',
  ]);
  assert.ok(inventory.rowReferences('projectHostedLandingDesired').tasks.includes('wake.taskId'));
  assert.deepEqual(inventory.valuesAt({ a: [{ b: 'x' }, { b: 'y' }], c: { d: 'z' } }, 'a[].b'), ['x', 'y']);
  assert.deepEqual(inventory.valuesAt({ c: { d: 'z' } }, 'c.d'), ['z']);
});

/** A schema-valid document with only required fields. */
function sample(spec) {
  switch (spec.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.value)
          .filter(([, field]) => !field.optional)
          .map(([key, field]) => [key, sample(field.fieldType)]),
      );
    case 'array':
      return [];
    case 'record':
      return {};
    case 'union':
      return sample(spec.value[0]);
    case 'literal':
      return jsonToConvex(spec.value);
    case 'id':
      return `synthetic-${spec.tableName}`;
    case 'number':
      return 1;
    case 'bigint':
      return 1n;
    case 'boolean':
      return false;
    case 'bytes':
      return new ArrayBuffer(4);
    case 'string':
      return 'synthetic';
    default:
      return null;
  }
}
function fixture() {
  const s = state([]);
  const now = { value: Date.now() };
  s.now = now;
  const project = (id, owner) =>
    s.tables.hostedProjects.set(id, {
      _id: id,
      _creationTime: 1,
      owner,
      key: randomUUID(),
      name: `Synthetic ${id}`,
      slug: `synthetic-${id}`,
      currentBackup: null,
      revision: 1,
    });
  project('project', 'owner');
  project('foreign', 'other');
  let n = 0;
  const add = (table, projectId, values = {}) => {
    const id = `${table}-${projectId}-${n++}`;
    s.tables[table].set(id, {
      ...sample(schema.tables[table].validator.json),
      _id: id,
      _creationTime: n,
      projectId,
      ...values,
    });
    return id;
  };
  for (const table of Object.keys(projectPurgeTables)) {
    for (const projectId of ['project', 'foreign']) {
      const extra = {};
      for (const path of inventory.rowReferences(table).tasks.filter(path => !path.includes('.'))) {
        extra[path] = `task-${table}-${projectId}`;
        s.tasks.set(extra[path], { state: { kind: 'pending' } });
      }
      if (table === 'projectWorkGenerations') {
        extra.returnSnapshot = `file-${projectId}-snapshot`;
        s.file(extra.returnSnapshot, new Blob(['synthetic snapshot']));
      }
      if (table === 'projectObjects') Object.assign(extra, { removed: false, size: 300 });
      if (table === 'projectBackups') extra.size = 700;
      if (table === 'projectUploadCleanup') extra.pending = false;
      if (table === 'projectGithubImports') extra.protocol = 1;
      if (table === 'agentGuidanceOperations') extra.scope = 'project';
      add(table, projectId, extra);
    }
  }
  // Overflow one grant table and one bulk table past their page sizes.
  for (let i = 0; i < 130; i++) add('projectReaders', 'project', { reader: `reader-${i}` });
  for (let i = 0; i < 1500; i++) add('projectHostedRecords', 'project');
  for (const projectId of ['project', 'foreign'])
    s.tables.artifactBlobs.set(`blob-${projectId}`, {
      _id: `blob-${projectId}`,
      _creationTime: 1,
      namespace: `v1/p/${projectId}/archives/backup`,
      digest: 'a'.repeat(64),
      size: 1,
      contentType: 'application/gzip',
      committed: true,
      removed: false,
    });
  s.personal = add('agentGuidanceOperations', 'project', { scope: 'personal' });
  s.tables.projectSlugs.set('slug-project', {
    _id: 'slug-project',
    owner: 'owner',
    slug: 'synthetic-project',
    projectId: 'project',
  });
  s.op = () => ({
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: s.tables.hostedProjects.get('project').revision,
  });
  // Scheduled function runner: run only due mutations of this slice; R2 actions are modelled by their result.
  const handlers = { projectLifecycle: lifecycle, projectRetention: retention };
  s.run = async () => {
    let calls = 0,
      maxDeletes = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const project = s.tables.hostedProjects.get('project');
      if (project.r2Purge && !project.r2PrefixPurged) {
        project.r2PrefixPurged = true;
        await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
        calls++;
        continue;
      }
      const due = s.scheduled.find(
        task =>
          s.tasks.get(task.id)?.state.kind === 'pending' &&
          (task.at === undefined || task.at <= now.value) &&
          handlers[getFunctionName(task.fn).split(':')[0]],
      );
      if (!due) return { calls, maxDeletes };
      s.tasks.set(due.id, { state: { kind: 'success' } });
      const [module, name] = getFunctionName(due.fn).split(':');
      const before = s.deletedRows;
      await s.transaction(() => handlers[module][name]._handler(s.ctx, due.args));
      maxDeletes = Math.max(maxDeletes, s.deletedRows - before);
      calls++;
    }
    throw new Error('scheduled work did not converge');
  };
  s.deletedRows = 0;
  const remove = s.ctx.db.delete;
  s.ctx.db.delete = async id => {
    assert.ok(
      Object.values(s.tables).some(table => table.has(id)),
      `Delete on nonexistent document ID: ${id}`,
    );
    s.deletedRows++;
    return remove(id);
  };
  return s;
}
const count = (s, projectId) =>
  Object.keys(projectPurgeTables).reduce(
    (sum, table) =>
      sum +
      [...s.tables[table].values()].filter(row => row.projectId === projectId && row.scope !== 'personal')
        .length,
    0,
  );
const pending = s =>
  [...s.tasks.entries()].filter(([, task]) => task.state.kind === 'pending').map(([id]) => id);

test('delete tombstones at once, revokes access, measures retained size and purges every covered row at day 90', async t => {
  const s = fixture();
  t.mock.method(Date, 'now', () => s.now.value);
  const foreignRows = count(s, 'foreign');
  await lifecycle.trash._handler(s.ctx, s.op());
  const project = () => s.tables.hostedProjects.get('project');
  assert.equal(project().removal, 'trash');
  // Hidden from everyone, owner included; writes and Lanes go through the same gate.
  for (const caller of ['owner', 'reader-1']) {
    s.caller(caller);
    await assert.rejects(
      projectWork.state._handler(s.ctx, { projectId: 'project' }),
      e => e.data?.code === 'PROJECT_UNAVAILABLE',
    );
  }
  s.caller('owner');
  // One expiry at the end of the window, set now; never a polling cron.
  const expiry = s.scheduled.find(task => getFunctionName(task.fn) === 'projectRetention:expire');
  assert.equal(expiry.at, project().removedAt + 90 * day);
  assert.equal(project().retention.purgeAt, expiry.at);
  // Grants and runner registrations: first page revoked in the delete itself, the rest paged.
  assert.equal([...s.tables.projectReaders.values()].filter(r => r.projectId === 'project').length, 31);
  assert.equal(project().retention.revoking, true);
  const idle = await s.run();
  for (const table of retention.revokedTables)
    assert.equal([...s.tables[table].values()].filter(r => r.projectId === 'project').length, 0, table);
  assert.equal(project().retention.revoking, undefined);
  assert.deepEqual(
    {
      bytes: project().retention.retainedBytes,
      objects: project().retention.retainedObjects,
      measured: project().retention.measured,
    },
    { bytes: 300 + 700 + 1, objects: 3, measured: true },
  );
  assert.ok(idle.calls <= 4, `deletion bookkeeping used ${idle.calls} calls`);
  // Idle: only the single expiry is pending until day 90.
  assert.deepEqual(
    pending(s).filter(id => s.scheduled.some(task => task.id === id)),
    [expiry.id],
  );
  assert.equal((await s.run()).calls, 0, 'nothing runs while the deleted project waits');

  s.now.value = expiry.at;
  const purge = await s.run();
  assert.equal(project().removal, 'deleted');
  assert.ok(
    s.tables.agentGuidanceOperations.has(s.personal),
    'personal guidance keeps its incidental projectId',
  );
  assert.equal(count(s, 'project'), 0, 'zero project rows remain');
  assert.equal(count(s, 'foreign'), foreignRows, 'other projects keep every row');
  assert.ok(!s.tables.artifactBlobs.has('blob-project') && s.tables.artifactBlobs.has('blob-foreign'));
  assert.deepEqual(
    [s.files.has('file-project-snapshot'), s.files.has('file-foreign-snapshot')],
    [false, true],
  );
  assert.ok(!s.tables.projectSlugs.has('slug-project'), 'the slug is released after the purge');
  assert.equal(project().slug, undefined);
  assert.equal(project().name, '');
  for (const table of Object.keys(projectPurgeTables))
    for (const path of inventory.rowReferences(table).tasks.filter(path => !path.includes('.')))
      assert.equal(s.tasks.get(`task-${table}-project`).state.kind, 'canceled', `${table}.${path}`);
  assert.equal(pending(s).filter(id => id.startsWith('task-') && id.endsWith('-project')).length, 0);
  assert.deepEqual(
    s.scheduled.filter(task => pending(s).includes(task.id)).map(task => getFunctionName(task.fn)),
    // The prefix purge action is modelled above by its completion mark.
    ['projectR2Maintenance:purgeDeletedProjectPage'],
    'idle after purge',
  );
  const receipt = project().purge;
  assert.equal(receipt.reason, 'retention');
  assert.match(receipt.operationId, /^retention:project:/);
  assert.ok(receipt.completedAt && receipt.rows > 1500);
  assert.ok(purge.maxDeletes <= rowsPage.purgePageBudget.rows + 50, `page deleted ${purge.maxDeletes} rows`);
  t.diagnostic(
    `purge: ${purge.calls} scheduled calls, ${receipt.pages} row pages, ${receipt.rows} rows, ${receipt.bytes} bytes, max ${purge.maxDeletes} deletes per call`,
  );
});

test('permanent purge removes every writer companion without double deletion or projection recreation, including resumed pages', async t => {
  for (const resumed of [false, true]) {
    await t.test(
      resumed ? 'resume after the metric companion was purged' : 'all companions present',
      async t => {
        const s = fixture();
        t.mock.method(Date, 'now', () => s.now.value);
        const companions = s.tables.projectFinishReadRows;
        const companion = (kind, source, projectId) => {
          const id = `companion-${kind}-${source._id}`;
          companions.set(id, {
            _id: id,
            _creationTime: 1,
            kind,
            sourceId: source._id,
            ...(projectId ? { projectId } : {}),
            value: '{}',
          });
          return id;
        };
        // Include every finish-writer selection, retained metric id and presence pointer.
        // The inventory-only fixture used to omit these optional links and tolerate missing deletes.
        for (const projectId of ['project', 'foreign']) {
          for (const kind of Object.keys(finishReadFields)) {
            const source = [...s.tables[kind].values()].find(row =>
              kind === 'hostedProjects' ? row._id === projectId : row.projectId === projectId,
            );
            companion(kind, source, kind === 'hostedProjects' ? undefined : projectId);
            if (kind === 'projectHostedFinishes') companion('projectHostedFinishOwners', source, projectId);
            if (kind === 'projectHostedLandingRequests')
              companion('projectHostedLandingPeers', source, projectId);
            if (kind === 'projectHostedLandingQueues')
              companion('projectHostedAheadQueues', source, projectId);
            if (kind === 'projectHostedCheckRuns') {
              const rowId = companion('projectMetricCheckRuns', source, projectId);
              source.metricsProjected = true;
              source.metricProjection = { rowId, digest: 'a'.repeat(64) };
              if (resumed && projectId === 'project') companions.delete(rowId);
            }
          }
          const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(
            row => row.projectId === projectId,
          );
          const presence = [...s.tables.projectHostedPresence.values()].find(
            row => row.projectId === projectId,
          );
          overlap.presenceRow = { id: presence._id, at: 1 };
        }
        const foreign = structuredClone(
          Object.fromEntries(
            Object.entries(s.tables).map(([name, rows]) => [
              name,
              [...rows.values()].filter(
                row =>
                  row.projectId === 'foreign' ||
                  (name === 'projectFinishReadRows' && row.sourceId === 'foreign'),
              ),
            ]),
          ),
        );
        // Exercise the registered production mutation and its real finish/metric wrapper.
        await lifecycle.permanentlyDelete._handler(s.ctx, { ...s.op(), confirm: 'synthetic-project' });
        s.now.value += retention.purgeSettleMs;
        const result = await s.run();
        assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
        assert.equal(count(s, 'project'), 0);
        assert.ok(
          ![...companions.values()].some(row => row.sourceId === 'project'),
          'legacy root projection removed',
        );
        for (const [name, expected] of Object.entries(foreign))
          for (const row of expected) assert.deepEqual(s.tables[name].get(row._id), row, name);
        assert.ok(result.maxDeletes <= rowsPage.purgePageBudget.rows + 50);
        assert.equal((await s.run()).calls, 0, 'completed purge adds no idle calls');
        t.diagnostic(
          `purge: ${result.calls} scheduled calls, ${s.tables.hostedProjects.get('project').purge.pages} row pages`,
        );
      },
    );
  }
});

test('restore within the window cancels the expiry and does not bring back grants', async t => {
  const s = fixture();
  t.mock.method(Date, 'now', () => s.now.value);
  await lifecycle.trash._handler(s.ctx, s.op());
  await assert.rejects(lifecycle.restore._handler(s.ctx, s.op()), e => e.data?.code === 'WORK_STALE');
  await s.run();
  const expiry = s.tables.hostedProjects.get('project').retention.task;
  s.now.value += 89 * day;
  await lifecycle.restore._handler(s.ctx, s.op());
  const project = s.tables.hostedProjects.get('project');
  assert.equal(project.removal, undefined);
  assert.equal(project.retention, undefined);
  assert.equal(s.tasks.get(expiry).state.kind, 'canceled');
  assert.equal([...s.tables.projectReaders.values()].filter(r => r.projectId === 'project').length, 0);
  assert.equal((await projectWork.state._handler(s.ctx, { projectId: 'project' }))._id, 'project');
});

test('restore is refused after the window; the late expiry still purges', async t => {
  const s = fixture();
  t.mock.method(Date, 'now', () => s.now.value);
  await lifecycle.trash._handler(s.ctx, s.op());
  await s.run();
  s.now.value += 90 * day;
  await assert.rejects(
    lifecycle.restore._handler(s.ctx, s.op()),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await s.run();
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.equal(count(s, 'project'), 0);
});

test('delete permanently now needs the typed slug, revokes at once and waits only for in-flight uploads', async t => {
  const s = fixture();
  t.mock.method(Date, 'now', () => s.now.value);
  for (const confirm of [undefined, '', 'Synthetic project', 'synthetic-foreign'])
    await assert.rejects(
      lifecycle.permanentlyDelete._handler(s.ctx, {
        ...s.op(),
        ...(confirm === undefined ? {} : { confirm }),
      }),
      e => e.data?.code === 'BAD_ARGUMENT',
    );
  assert.equal(s.tables.hostedProjects.get('project').removal, undefined);
  const op = { ...s.op(), confirm: 'synthetic-project' };
  await lifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
  s.caller('owner');
  await assert.rejects(
    projectWork.state._handler(s.ctx, { projectId: 'project' }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await s.run();
  // Row purge waits until signed R2 uploads issued before deletion have expired.
  const project = s.tables.hostedProjects.get('project');
  assert.equal(project.removal, 'deleting');
  const settle = s.scheduled.find(task => task.at === project.removedAt + retention.purgeSettleMs);
  assert.ok(settle, 'one settle wake at the upload expiry');
  s.now.value = settle.at;
  await s.run();
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.equal(s.tables.hostedProjects.get('project').purge.operationId, op.operationId);
  assert.equal(count(s, 'project'), 0);
  // Replaying the original operation reconciles without a confirm oracle.
  await lifecycle.permanentlyDelete._handler(s.ctx, op);
});
