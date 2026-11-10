// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, snapshotAccumulator, snapshotEvents } from './hosted-durability-compare.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex64 = /^[a-f0-9]{64}$/;

function projectRow(rows, table, row, projectId) {
  const text = canonical(row);
  if (!text.includes(projectId)) return null;
  rows.set(`${table}\t${row._id}`, sha256(text));
  return text;
}

/** One pass over a snapshot ZIP (a path, or its bytes as an async iterable): every row that
 * names `projectId`, hashed canonically by table and `_id`, plus (for the full backup) the backup
 * verifier's whole-deployment summary. With `sink` the same pass streams the backup reduced to
 * the project to `sink(readable)` (the drill uploads it straight into the scratch import), with each of
 * `schemaTables` the backup lacks added empty (`filter.createdEmpty`). Rows from other projects never leave the stream; only hashes and object
 * pins are kept. */
export async function readProjectSnapshot(
  source,
  projectId,
  { whole = true, sink = null, schemaTables = [], signal } = {},
) {
  const deployment = whole ? snapshotAccumulator() : null,
    rows = new Map(),
    objects = new Map(),
    r2Keys = new Set(),
    keyPattern = new RegExp(`v1/p/${projectId}/[A-Za-z0-9._/-]+`, 'g');
  let project = null,
    filtered = null;
  for await (const event of snapshotEvents(source, {
    filter: sink && { projectId, sink, schemaTables },
    signal,
  })) {
    if (event.kind === 'filtered') {
      filtered = { kept: event.kept, dropped: event.dropped, createdEmpty: event.created };
      continue;
    }
    deployment?.add(event);
    if (event.kind !== 'record' || event.table.endsWith('/generated_schema.jsonl')) continue;
    const row = event.value,
      text = projectRow(rows, event.table, row, projectId);
    if (text === null) continue;
    if (event.table === 'hostedProjects' && row._id === projectId) project = row;
    for (const [key] of text.matchAll(keyPattern)) r2Keys.add(key);
    if (row.projectId !== projectId) continue;
    // An R2 upload that was prepared but never committed is not a stored object: the app serves
    // no bytes for it, so the drill does not ask the restored app for it either.
    const pending = row.location === 'r2' && !row.r2Committed && !row.storageId && !row.recipe;
    if (event.table === 'projectObjects' && !row.removed && !pending) objects.set(row.digest, row.size);
    if (event.table === 'projectObjectCatalog')
      for (let at = 0; at < row.digests.length; at += 64)
        objects.set(row.digests.slice(at, at + 64), row.sizes[at / 64]);
  }
  if (!project)
    throw Object.assign(new Error('Project is absent from the backup.'), { code: 'PROJECT_ABSENT' });
  return {
    deployment: deployment?.finish() ?? null,
    rows,
    objects,
    r2Keys,
    owner: project.owner,
    filter: filtered,
  };
}

/** The restored instance's rows that name `projectId`, read straight from its database file
 * (read-only, after the import and before any code runs) instead of exporting it to disk. The
 * pinned backend keeps every revision as (table_id, id, ts, json_value, deleted): the newest
 * revision of an id is the row, and `_tables` rows (their own id is the `_tables` table id)
 * name each table. Rows are stored in the snapshot's JSON form, so they hash like the backup's. */
export function readRestoredRows(database, projectId) {
  const db = new DatabaseSync(database, { readOnly: true }),
    rows = new Map(),
    unreadable = () =>
      Object.assign(new Error('Restored database unreadable.'), { code: 'RESTORED_READ_FAILED' });
  try {
    const revisions = db.prepare(
      'SELECT id, json_value, deleted FROM documents WHERE table_id = ? ORDER BY id, ts',
    );
    function* newest(tablet) {
      let last = null;
      for (const revision of revisions.iterate(tablet)) {
        if (last && Buffer.compare(last.id, revision.id) !== 0 && !last.deleted) yield last;
        last = revision;
      }
      if (last && !last.deleted) yield last;
    }
    const meta = db.prepare('SELECT table_id FROM documents WHERE table_id = id LIMIT 1').get();
    if (!meta) throw unreadable();
    const tables = [...newest(meta.table_id)]
      .map(entry => ({ tablet: entry.id, ...JSON.parse(entry.json_value) }))
      .filter(table => table.state === 'active' && !table.name.startsWith('_'));
    for (const table of tables)
      for (const { json_value: json } of newest(table.tablet))
        if (json.includes(projectId)) projectRow(rows, table.name, JSON.parse(json), projectId);
    if (!tables.length) throw unreadable();
    return { rows, tables: tables.length };
  } finally {
    db.close();
  }
}

/** Row-by-row comparison. Differences name table and row id, never row contents. */
export function compareProjectRows(left, right) {
  const tables = new Map(),
    differing = [];
  const count = (key, side) => {
    const table = key.split('\t')[0];
    if (!tables.has(table)) tables.set(table, { table, backup: 0, restored: 0, equal: true });
    tables.get(table)[side]++;
    return tables.get(table);
  };
  for (const [key, hash] of left) {
    const entry = count(key, 'backup');
    if (right.get(key) !== hash) {
      entry.equal = false;
      differing.push({ row: key.replace('\t', '/'), reason: right.has(key) ? 'changed' : 'missing' });
    }
  }
  for (const key of right.keys()) {
    const entry = count(key, 'restored');
    if (!left.has(key)) {
      entry.equal = false;
      differing.push({ row: key.replace('\t', '/'), reason: 'extra' });
    }
  }
  return {
    equal: differing.length === 0,
    rows: left.size,
    tables: [...tables.values()].sort((a, b) => a.table.localeCompare(b.table)),
    differing: differing.slice(0, 50),
    differingCount: differing.length,
  };
}

/** Check the project's R2 prefix in place. Source access is LIST and GET only, and bytes are
 * streamed (never held whole or written): every key the backup's rows reference must exist, and
 * every content-addressed key (`o/<sha256>`) must hash to its name and have the size its row
 * records. Other keys are checked for existence only. A source pack is a cache that is replaced
 * as main moves (readers fall back to object transfer), so a referenced pack rotated away since
 * the backup is counted as `cacheMissing`, not as loss. `signal` stops it between objects. */
export async function verifyProjectObjects({
  source,
  projectId,
  referenced,
  sizes,
  concurrency = 32,
  signal,
}) {
  const prefix = `v1/p/${projectId}/`,
    seen = new Set(),
    content = [],
    digestMismatch = [],
    sizeMismatch = [];
  let bytes = 0,
    lists = 0;
  for await (const page of source.pages(prefix)) {
    lists++;
    for (const key of page) {
      seen.add(key);
      const name = key.slice(prefix.length).split('/');
      if (name.length === 2 && name[0] === 'o' && hex64.test(name[1])) content.push([key, name[1]]);
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, content.length) }, async () => {
      while (next < content.length) {
        signal?.throwIfAborted();
        const [key, digest] = content[next++];
        const got = await source.digest(key);
        bytes += got.size;
        if (got.sha256 !== digest) digestMismatch.push(key);
        else if (sizes.has(digest) && sizes.get(digest) !== got.size) sizeMismatch.push(key);
      }
    }),
  );
  const absent = [...referenced].filter(key => !seen.has(key)).sort(),
    cache = key => key.startsWith(`${prefix}source-pack/`),
    missing = absent.filter(key => !cache(key));
  return {
    objects: seen.size,
    hashed: content.length,
    bytes,
    requests: { list: lists, get: content.length },
    referenced: referenced.size,
    missing: missing.slice(0, 50),
    missingCount: missing.length,
    cacheMissing: absent.length - missing.length,
    unreferenced: [...seen].filter(key => !referenced.has(key)).length,
    digestMismatch: digestMismatch.sort().slice(0, 50),
    digestMismatchCount: digestMismatch.length,
    sizeMismatch: sizeMismatch.sort().slice(0, 50),
    sizeMismatchCount: sizeMismatch.length,
  };
}

/** Read main's State and every file of it through the restored deployment's own download path
 * into an empty cache (the cache rejects bytes that differ from their SHA-256 pin). The scratch
 * bucket reads through to the source prefix, so nothing is copied first; every other object's
 * bytes are checked by verifyProjectObjects. */
export async function readProjectThroughApp({ exchange, cache, parseState, readObject, objects, main }) {
  const current = await exchange.current();
  const result = { states: 0, files: 0, fileEntries: 0, bytes: 0, sizeMismatch: [] };
  if (main) {
    await cache.ensure([main]);
    const state = parseState(readObject(main));
    const files = [...new Set(state.files.map(file => file.blob))];
    await cache.ensure(files);
    for (const digest of [main, ...files]) {
      const body = readObject(digest);
      if (sha256(body) !== digest)
        throw Object.assign(new Error('Object differs.'), { code: 'OBJECT_MISMATCH' });
      if (objects.has(digest) && objects.get(digest) !== body.length) result.sizeMismatch.push(digest);
      result.bytes += body.length;
    }
    Object.assign(result, { states: 1, files: files.length, fileEntries: state.files.length });
  }
  return {
    ...result,
    main: { backup: main, restored: current.head ?? null, equal: (current.head ?? null) === main },
  };
}
