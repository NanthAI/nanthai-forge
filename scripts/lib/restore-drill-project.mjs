// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../child-env.mjs';
import { canonical, snapshotAccumulator, snapshotEvents } from './hosted-durability-compare.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex64 = /^[a-f0-9]{64}$/;

/** One pass over a snapshot ZIP: every row that names `projectId`, hashed canonically by
 * table and `_id`, plus (for the full backup) the backup verifier's whole-deployment summary.
 * Rows from other projects never leave the stream; only hashes and object pins are kept. */
export async function readProjectSnapshot(path, projectId, { whole = true } = {}) {
  const deployment = whole ? snapshotAccumulator() : null,
    rows = new Map(),
    objects = new Map(),
    r2Keys = new Set(),
    keyPattern = new RegExp(`v1/p/${projectId}/[A-Za-z0-9._/-]+`, 'g');
  let project = null;
  for await (const event of snapshotEvents(path)) {
    deployment?.add(event);
    if (event.kind !== 'record' || event.table.endsWith('/generated_schema.jsonl')) continue;
    const row = event.value,
      text = canonical(row);
    if (!text.includes(projectId)) continue;
    rows.set(`${event.table}\t${row._id}`, sha256(text));
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
  return { deployment: deployment?.finish() ?? null, rows, objects, r2Keys, owner: project.owner };
}

/** The backup reduced to one project (scripts/lib/restore-drill-filter.py). */
export async function filterProject(source, target, projectId) {
  const child = spawn(
    'python3',
    [fileURLToPath(new URL('./restore-drill-filter.py', import.meta.url)), source, target, projectId],
    { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  const code = await new Promise(done => {
    if (child.exitCode !== null) done(child.exitCode);
    else child.once('close', done);
  });
  if (code !== 0)
    throw Object.assign(new Error('Project filter failed.'), { code: 'SNAPSHOT_FILTER_FAILED' });
  return JSON.parse(output);
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

/** Copy the project's R2 prefix into the scratch bucket. Source access is LIST and GET only.
 * Content-addressed keys (`o/<sha256>`) must hash to their name; every key the backup's rows
 * reference must exist. */
export async function copyProjectObjects({ source, projectId, referenced, put }) {
  const prefix = `v1/p/${projectId}/`,
    seen = new Set(),
    digestMismatch = [];
  let bytes = 0,
    lists = 0;
  for await (const page of source.pages(prefix)) {
    lists++;
    for (const key of page) {
      const body = await source.bytes(key);
      const name = key.slice(prefix.length).split('/');
      if (name[0] === 'o' && hex64.test(name[1]) && sha256(body) !== name[1]) digestMismatch.push(key);
      await put(key, body);
      seen.add(key);
      bytes += body.length;
    }
  }
  const missing = [...referenced].filter(key => !seen.has(key)).sort();
  return {
    objects: seen.size,
    bytes,
    requests: { list: lists, get: seen.size },
    referenced: referenced.size,
    missing: missing.slice(0, 50),
    missingCount: missing.length,
    unreferenced: [...seen].filter(key => !referenced.has(key)).length,
    digestMismatch,
  };
}

/** Read every stored object of the project through the restored deployment's own download
 * path into an empty cache (the cache rejects bytes that differ from their SHA-256 pin), then
 * every file of every State among them. */
export async function readProjectThroughApp({ exchange, cache, parseState, readObject, objects, main }) {
  const digests = [...objects.keys()].sort();
  await cache.ensure(digests);
  const states = [];
  for (const digest of digests) {
    try {
      states.push({ digest, state: parseState(readObject(digest)) });
    } catch {
      /* Not a State manifest: file contents, Work metadata or a recipe leaf. */
    }
  }
  const files = new Map();
  for (const { state } of states) for (const file of state.files) files.set(file.blob, file);
  await cache.ensure([...files.keys()]);
  let bytes = 0;
  const sizeMismatch = [];
  for (const digest of new Set([...digests, ...files.keys()])) {
    const body = readObject(digest);
    if (sha256(body) !== digest)
      throw Object.assign(new Error('Object differs.'), { code: 'OBJECT_MISMATCH' });
    if (objects.has(digest) && objects.get(digest) !== body.length) sizeMismatch.push(digest);
    bytes += body.length;
  }
  const current = await exchange.current();
  return {
    objects: digests.length,
    states: states.length,
    files: files.size,
    fileEntries: states.reduce((total, { state }) => total + state.files.length, 0),
    bytes,
    sizeMismatch,
    main: { backup: main, restored: current.head ?? null, equal: (current.head ?? null) === main },
    mainIsReadState: states.some(({ digest }) => digest === main),
  };
}
