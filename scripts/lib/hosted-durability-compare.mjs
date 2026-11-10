// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../child-env.mjs';
import { failure } from './hosted-durability-errors.mjs';
export { failure } from './hosted-durability-errors.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function unavailable(reason, project) {
  const ref = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
  return Object.assign(failure('WORK_INDEX_UNAVAILABLE'), {
    diagnostics: {
      reason,
      ...(project ? { projectRef: ref(project._id) } : {}),
      ...(project?.work?.generationId ? { generationRef: ref(project.work.generationId) } : {}),
    },
  });
}

// Full records are hashed, including IDs and creation times (snapshot import preserves both).
// Only selected Work metadata is retained in memory; private record values are never reported.
export function snapshotAccumulator({ databaseOnly = false } = {}) {
  const tables = new Map(),
    files = [],
    projects = [],
    generations = new Map(),
    partitions = new Map(),
    hostedMains = new Map(),
    storageIds = new Set(),
    artifactRefs = new Set(),
    committedArtifacts = new Set();
  let convexSourceRemains = false;
  function add(event) {
    if (event.kind === 'file') {
      files.push(event);
      return;
    }
    if (!tables.has(event.table)) tables.set(event.table, []);
    if (event.kind === 'table') return;
    const row = event.value;
    if (
      !event.table.endsWith('/generated_schema.jsonl') &&
      (!row || typeof row !== 'object' || Array.isArray(row))
    )
      throw failure('SNAPSHOT_INVALID');
    tables.get(event.table).push(hash(row));
    if (event.table === 'artifactBlobs' && row.committed && !row.removed)
      committedArtifacts.add(`r2blob:${row._id}`);
    if (databaseOnly) {
      const r2 = source => source?.location === 'r2' && source.r2Committed && source.r2Key;
      if (['projectObjects', 'projectBackups', 'projectProposals'].includes(event.table)) {
        if (row.storageId && !r2(row) && !row.removed) convexSourceRemains = true;
        if (row.archiveReceipt?.storageId && !r2(row.archiveReceipt)) convexSourceRemains = true;
      }
      if (
        ['imports', 'importArtifacts', 'sourceZones', 'agentGrants'].includes(event.table) &&
        row.artifactKey &&
        !r2(row)
      ) {
        if (row.artifactKey.startsWith('r2blob:')) artifactRefs.add(row.artifactKey);
        else convexSourceRemains = true;
      }
      if (event.table === 'derivedArtifacts' && row.storageId && !row.removed) {
        if (row.storageId.startsWith('r2blob:')) artifactRefs.add(row.storageId);
        else convexSourceRemains = true;
      }
    }
    if (event.table === '_storage') storageIds.add(row._id);
    if (event.table === 'hostedProjects') projects.push(row);
    // Server-authority main lives in its channel row; the Work index keeps the hosting-time copy.
    if (event.table === 'projectHostedChannels' && row.name === 'main') {
      const selection = typeof row.selection === 'string' ? JSON.parse(row.selection) : row.selection;
      if (hostedMains.has(row.projectId)) throw failure('WORK_INDEX_INVALID');
      hostedMains.set(row.projectId, selection?.head);
    }
    if (event.table === 'projectWorkGenerations') generations.set(row._id, row);
    if (event.table === 'projectWorkRecords') {
      let partition = partitions.get(row.generationId);
      if (!partition) partitions.set(row.generationId, (partition = { counts: {}, channels: new Map() }));
      partition.counts[row.collection] = (partition.counts[row.collection] ?? 0) + 1;
      if (['channels', 'hostedChannels'].includes(row.collection) && row.key === 'main') {
        if (partition.channels.has(row.collection)) throw failure('WORK_INDEX_INVALID');
        const head = JSON.parse(row.value).head;
        if (typeof head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
          throw failure('WORK_INDEX_INVALID');
        partition.channels.set(row.collection, head);
      }
    }
  }
  function finish() {
    if (!tables.has('hostedProjects')) throw failure('SNAPSHOT_INVALID');
    // Convex names stored files `_storage/<id>`, plus an extension when the content type has one.
    const fileIds = new Set(
      files.filter(file => file.path.startsWith('_storage/')).map(file => file.path.slice(9).split('.')[0]),
    );
    if (databaseOnly && (convexSourceRemains || [...artifactRefs].some(ref => !committedArtifacts.has(ref))))
      throw failure('DATABASE_ONLY_STORAGE_REMAINS');
    if (!databaseOnly && (!tables.has('_storage') || [...storageIds].some(id => !fileIds.has(id))))
      throw failure('STORAGE_INCOMPLETE');
    const work = projects
      .filter(p => p.work && !p.removal)
      .map(project => {
        const generation = generations.get(project.work.generationId);
        if (!generation) throw unavailable('generation-missing', project);
        if (generation.status !== 'ready')
          throw unavailable(
            generation.status === 'building' ? 'generation-building' : 'generation-failed',
            project,
          );
        if (generation.projectId !== project._id) throw unavailable('project-mismatch', project);
        if (generation.backupId !== project.work.backupId) throw unavailable('backup-mismatch', project);
        const partition = partitions.get(generation.recordsGenerationId ?? generation._id);
        if (!partition) throw unavailable('partition-missing', project);
        const main =
          hostedMains.get(project._id) ??
          partition.channels.get('hostedChannels') ??
          partition.channels.get('channels') ??
          null;
        if (main !== null && (typeof main !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(main)))
          throw failure('WORK_INDEX_INVALID');
        return {
          projectId: project._id,
          main,
          counts: Object.fromEntries(['intents', 'lanes', 'views'].map(c => [c, partition.counts[c] ?? 0])),
        };
      })
      .sort((a, b) => a.projectId.localeCompare(b.projectId));
    if (!work.length) throw unavailable('no-work-projects');
    return {
      format: 1,
      tables: Object.fromEntries(
        [...tables]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, records]) => [name, { count: records.length, sha256: hash(records.sort()) }]),
      ),
      files: { count: files.length, sha256: hash(files.sort((a, b) => a.path.localeCompare(b.path))) },
      work,
    };
  }
  return { add, finish };
}

/** Every snapshot entry as `{kind:'table'|'record'|'file', ...}`, streamed without extracting
 * the ZIP. Fails with SNAPSHOT_READ_FAILED when the reader cannot finish. */
export async function* snapshotEvents(path) {
  const child = spawn(
    'python3',
    [fileURLToPath(new URL('./hosted-durability-zip.py', import.meta.url)), path],
    { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const completion = new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
  let finished = false;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity }))
      yield JSON.parse(line);
    finished = true;
  } finally {
    if (!finished) child.kill();
    const passed = await completion;
    if (finished && !passed) throw failure('SNAPSHOT_READ_FAILED');
  }
}

export async function readSnapshot(path, options = {}) {
  const accumulator = snapshotAccumulator(options);
  try {
    for await (const event of snapshotEvents(path)) accumulator.add(event);
    return accumulator.finish();
  } catch (error) {
    if (error.code?.startsWith('WORK_')) throw error;
    throw failure(
      error.code === 'STORAGE_INCOMPLETE' || error.code === 'DATABASE_ONLY_STORAGE_REMAINS'
        ? error.code
        : 'SNAPSHOT_READ_FAILED',
    );
  }
}

export function compareSnapshots(left, right) {
  const tables = [...new Set([...Object.keys(left.tables), ...Object.keys(right.tables)])]
    .sort()
    .map(table => ({
      table,
      left: left.tables[table] ?? null,
      right: right.tables[table] ?? null,
      equal: canonical(left.tables[table] ?? null) === canonical(right.tables[table] ?? null),
    }));
  const workEqual = canonical(left.work) === canonical(right.work);
  const filesEqual = canonical(left.files) === canonical(right.files);
  return {
    equal: workEqual && filesEqual && tables.every(t => t.equal),
    workEqual,
    filesEqual,
    leftWork: left.work,
    rightWork: right.work,
    files: { left: left.files, right: right.files },
    tables,
  };
}
