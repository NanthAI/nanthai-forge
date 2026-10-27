// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildByteTree } from '../dist/native-exchange-tree.js';
const actions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const at = '2026-01-01T00:00:00.000Z';
/** Synthetic dogfood-sized shape. No source or credentials from an owner. */
export function progressFixture(scale = 1, saved, ensure = actions.ensure._handler) {
  const n = count => Math.max(1, Math.ceil(count * scale));
  const objects = new Map(),
    heads = [];
  for (let i = 0; i < n(2495); i++) {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: i && i <= n(1530) ? [heads[i - 1]] : [],
        files: [],
        message: `State ${i}`,
        at,
      }),
    );
    const head = digest(bytes);
    objects.set(head, bytes);
    heads.push(head);
  }
  const head = heads.at(-1);
  let data = workSchema.parse({
    schema: 17,
    revision: 27630,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
    automaticActions: [],
    landingEntries: [],
  });
  for (let i = 0; i < n(625); i++)
    data.intents.push({
      id: randomUUID(),
      outcome: `Intent ${i}`,
      constraints: '',
      base: heads[i % heads.length],
      status: 'active',
      createdAt: at,
      notes:
        scale < 1
          ? Array.from({ length: 32 }, (_, n) => ({ kind: 'comment', text: `${n} ${'x'.repeat(3900)}`, at }))
          : [],
    });
  let saves = 0;
  for (let i = 0; i < n(555); i++) {
    const checkpoints = [];
    for (let j = 0; j < Math.floor(n(2789) / n(555)) + (i < n(2789) % n(555) ? 1 : 0); j++) {
      checkpoints.push({ head: heads[saves++ % heads.length], parent: head, message: 'Save', at });
    }
    data.lanes.push({
      id: randomUUID(),
      intentId: data.intents[i % data.intents.length].id,
      name: `Lane ${i}`,
      base: head,
      head: heads[i % heads.length],
      assignment: '',
      target: '',
      state: 'active',
      checkpoints,
    });
  }
  for (let i = 0; i < n(2167); i++) {
    const lane = data.lanes[i % data.lanes.length];
    data.views.push({
      id: randomUUID(),
      intentId: lane.intentId,
      base: head,
      head: heads[i % heads.length],
      inputs: [{ laneId: lane.id, head: lane.head }],
      status: 'clean',
      details: '',
      dependencies: [],
      at,
    });
  }
  const check = {
    id: randomUUID(),
    name: 'Synthetic',
    executable: 'node',
    args: [],
    environmentLabel: 'fake',
    definition: head,
    at,
  };
  data.checks.push(check);
  for (let i = 0; i < n(1471); i++) {
    const view = data.views[i % data.views.length];
    data.runs.push({
      id: randomUUID(),
      viewId: view.id,
      head: view.head,
      base: view.base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: {
        platform: 'synthetic',
        arch: 'fake',
        os: 'fake',
        node: '24.22.1',
        env: {},
        fingerprint: head,
      },
      status: 'passed',
      startedAt: at,
      runner: { pid: 1, host: 'fake' },
      details: 'x'.repeat(i < n(1109) ? 33000 : 1000),
    });
  }
  for (let i = 0; i < n(2001); i++)
    data.automaticActions.push({
      id: randomUUID(),
      at,
      action: { actor: 'Synthetic', summary: 'A synthetic action', undo: 'Restore fixture' },
      result: '{}',
    });
  for (let i = 0; i < n(572); i++)
    data.landingEntries.push({
      id: randomUUID(),
      request: head,
      channel: 'main',
      viewId: data.views[i % data.views.length].id,
      head,
      checkId: check.id,
      definition: head,
      environment: head,
      arrivedAt: at,
      submitter: 'Synthetic',
      keepOpen: false,
      priority: 'normal',
      status: 'accepted',
    });
  const records = buildWorkRecords(workSchema.parse(data));
  for (const [key, bytes] of records.objects) objects.set(key, bytes);
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: data.revision,
      files: [
        { path: 'work.json', ...records.root.work },
        ...heads.map(sha256 => ({ path: `objects/${sha256}`, sha256, size: objects.get(sha256).length })),
      ],
      unavailable: [],
      coverage: 'Synthetic index benchmark',
    }),
  );
  const root = Buffer.from(
    JSON.stringify({
      kind: 'forge-native-exchange',
      schema: 2,
      work: records.root.work,
      manifest: buildByteTree(manifest, objects),
      records: buildByteTree(records.bytes, objects),
    }),
  );
  objects.set(digest(root), root);
  const s = state([]);
  let project = {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    currentBackup: 'backup',
    revision: 1,
    work: {
      backupId: 'backup',
      initialRevision: data.revision,
      revision: data.revision,
      operationId: randomUUID(),
    },
  };
  let backup = {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    digest: digest(root),
    size: root.length,
    status: 'stored',
    transport: 'objects',
    preview: { format: 'native', revision: data.revision, manifestDigest: digest(manifest) },
  };
  s.tables.hostedProjects.set('project', project);
  s.tables.projectBackups.set('backup', backup);
  if (saved) {
    data = saved.data;
    objects.clear();
    for (const [key, value] of saved.objects) objects.set(key, value);
    for (const [table, rows] of saved.tables) s.tables[table] = new Map(rows);
    project = s.tables.hostedProjects.get('project');
    backup = s.tables.projectBackups.get('backup');
  }
  // Index the fake database too: scanning every row would measure the fake, not the build.
  const byCollection = new Map(),
    byKey = new Map();
  for (const [id, row] of s.tables.projectWorkRecords) {
    const bucket = byCollection.get(row.collection) ?? new Map();
    byCollection.set(row.collection, bucket);
    bucket.set(id, row);
    byKey.set(JSON.stringify([row.collection, row.key]), id);
  }
  const reserved = new Set(saved?.tables.flatMap(([, rows]) => rows.map(([id]) => id)) ?? []);
  const insert = s.ctx.db.insert,
    patch = s.ctx.db.patch,
    remove = s.ctx.db.delete,
    queryDb = s.ctx.db.query;
  s.ctx.db.insert = async (table, row) => {
    // Preserve persisted fake IDs across a simulated process restart.
    const oldRows = saved ? new Map(s.tables[table]) : null;
    let id = await insert(table, row);
    while (reserved.has(id)) {
      if (oldRows?.has(id)) s.tables[table].set(id, oldRows.get(id));
      else s.tables[table].delete(id);
      id = await insert(table, row);
    }
    if (table === 'projectWorkRecords') {
      const bucket = byCollection.get(row.collection) ?? new Map();
      byCollection.set(row.collection, bucket);
      bucket.set(id, s.tables[table].get(id));
      byKey.set(JSON.stringify([row.collection, row.key]), id);
    }
    return id;
  };
  s.ctx.db.delete = async id => {
    const row = s.tables.projectWorkRecords.get(id);
    if (row) {
      byCollection.get(row.collection)?.delete(id);
      byKey.delete(JSON.stringify([row.collection, row.key]));
    }
    return remove(id);
  };
  s.ctx.db.patch = (id, row) => patch(id, row);
  s.ctx.db.query = table => {
    if (table !== 'projectWorkRecords') return queryDb(table);
    let matches = [],
      direction = 1;
    const q = {
      withIndex(index, build) {
        const capture = Object.fromEntries(
          ['eq', 'gte', 'gt', 'lt', 'lte'].map(kind => [
            kind,
            (key, value) => {
              matches.push({ kind, key, value });
              return capture;
            },
          ]),
        );
        build(capture);
        return q;
      },
      order(value) {
        direction = value === 'desc' ? -1 : 1;
        return q;
      },
      async take(n) {
        return rows()
          .slice(0, n)
          .map(row => structuredClone(row));
      },
      async unique() {
        const found = rows();
        if (found.length > 1) throw new Error('Not unique');
        return structuredClone(found[0] ?? null);
      },
    };
    const rows = () => {
      const collection = matches.find(m => m.key === 'collection')?.value;
      const key = matches.find(m => m.key === 'key')?.value;
      const id = key === undefined ? undefined : byKey.get(JSON.stringify([collection, key]));
      const selected =
        key === undefined
          ? [...(byCollection.get(collection)?.values() ?? [])]
          : id
            ? [s.tables.projectWorkRecords.get(id)]
            : [];
      return selected
        .filter(row =>
          matches.every(({ kind, key, value }) =>
            kind === 'eq'
              ? row[key] === value
              : kind === 'gte'
                ? row[key] >= value
                : kind === 'gt'
                  ? row[key] > value
                  : kind === 'lt'
                    ? row[key] < value
                    : row[key] <= value,
          ),
        )
        .sort((a, b) => direction * (a.position - b.position || a._creationTime - b._creationTime));
    };
    return q;
  };
  const metrics = {
    calls: {},
    steps: 0,
    documentsRead: 0,
    documentsWritten: 0,
    storageReads: 0,
    maxRpcBytes: 0,
    maxStepMs: 0,
    maxActionMs: 0,
    actionCalls: 0,
  };
  const get = s.ctx.db.get;
  s.ctx.db.get = async id => {
    metrics.documentsRead++;
    return get(id);
  };
  for (const kind of ['insert', 'patch', 'delete']) {
    const run = s.ctx.db[kind];
    s.ctx.db[kind] = async (...args) => {
      metrics.documentsWritten++;
      return run(...args);
    };
  }
  const queryInstrument = s.ctx.db.query;
  s.ctx.db.query = table => {
    const q = queryInstrument(table);
    for (const kind of ['take', 'unique', 'paginate'])
      if (q[kind]) {
        const run = q[kind];
        q[kind] = async (...args) => {
          const result = await run(...args);
          metrics.documentsRead += Array.isArray(result)
            ? result.length
            : result?.page
              ? result.page.length
              : result
                ? 1
                : 0;
          return result;
        };
      }
    return q;
  };
  s.ctx.db.system.get = async id =>
    objects.has(id) ? { _id: id, sha256: id, size: objects.get(id).length } : null;
  s.ctx.storage.get = async id => {
    metrics.storageReads++;
    return new Blob([objects.get(id)]);
  };
  s.ctx.storage.getMetadata = async id => ({ sha256: id, size: objects.get(id).length });
  const query = s.ctx.runQuery,
    mutation = s.ctx.runMutation;
  let stepStarted = performance.now();
  s.ctx.runQuery = async (ref, args) => {
    const name = getFunctionName(ref);
    metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
    if (name === 'projectObjects:resolve')
      return args.digests.map(sha256 => ({
        projectId: 'project',
        digest: sha256,
        size: objects.get(sha256).length,
        storageId: sha256,
      }));
    if (name === 'projectWork:get') return project;
    if (name === 'projectWork:events') return { page: [], isDone: true, continueCursor: '' };
    if (name === 'projectBackups:get') return { project, backup };
    return query(ref, args);
  };
  s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref);
    metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
    metrics.maxRpcBytes = Math.max(metrics.maxRpcBytes, Buffer.byteLength(JSON.stringify(args)));
    const result = await mutation(ref, args);
    if (name === 'projectWorkIndexBuildStore:step') {
      metrics.steps++;
      metrics.maxStepMs = Math.max(metrics.maxStepMs, performance.now() - stepStarted);
      stepStarted = performance.now();
    }
    return result;
  };
  // Empty file maps still exercise real parent parsing and index projection; no source network IO.
  s.ctx.runAction = async (ref, args) => {
    const name = getFunctionName(ref);
    metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
    if (name === 'projectWorkAncestry:changedStates') return { before: [], after: [], paths: [] };
    if (name === 'projectWorkAncestry:stateBatch') return args.pins.map(p => ({ head: p.sha256, files: [] }));
    throw new Error(`Unexpected action ${name}`);
  };
  return {
    s,
    data,
    metrics,
    snapshot: () => ({
      data,
      objects: [...objects],
      tables: Object.entries(s.tables).map(([name, rows]) => [name, [...rows]]),
    }),
    async drive() {
      const started = performance.now();
      stepStarted = started;
      metrics.actionCalls++;
      const result = await ensure(s.ctx, { projectId: 'project' });
      metrics.maxActionMs = Math.max(metrics.maxActionMs, performance.now() - started);
      return result;
    },
  };
}
