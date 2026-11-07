// SPDX-License-Identifier: Apache-2.0
// Archive local protocol evidence before any checkout removal. No source hydration/RPCs.
import { lstat, readdir, mkdir, copyFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, relative } from 'node:path';

const inspect = path =>
  lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Inventory the root marker and complete local JSON journals, including recursively nested
 * checkout siblings. Source/object cache bytes and dependency symlinks are never followed. */
export async function archiveRoot({ root, cellDir, reason }) {
  const parent = join(cellDir, 'evidence');
  await mkdir(parent, { recursive: true });
  const out = await mkdtemp(join(parent, `${basename(root)}-`));
  const record = {
    root,
    reason,
    at: new Date().toISOString(),
    complete: false,
    files: [],
    locations: [],
    errors: [],
  };
  async function capture(file) {
    const before = await lstat(file);
    if (!before.isFile()) throw Error('Evidence is not a regular file');
    const name = relative(dirname(root), file);
    const target = join(out, 'files', name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    const sha256 = await digest(target);
    const after = await lstat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256 !== (await digest(file)))
      throw Error('Evidence changed during capture');
    record.files.push({ path: name, bytes: after.size, sha256 });
  }
  async function location(path, kind, visit) {
    try {
      const stat = await inspect(path);
      record.locations.push({
        path: relative(dirname(root), path),
        kind,
        status: stat ? 'present' : 'absent',
      });
      if (stat?.isSymbolicLink()) throw Error('Symlinked evidence location');
      if (stat) await visit(path, stat);
    } catch (error) {
      record.errors.push({ path: relative(dirname(root), path), error: String(error.message) });
    }
  }
  async function walk(directory, all = false) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (
        !all &&
        (['objects', 'conflict-objects', 'previous'].includes(item.name) || item.name.startsWith('checkout-'))
      ) {
        record.locations.push({
          path: relative(dirname(root), path),
          kind: 'source-cache',
          status: 'excluded',
        });
        continue;
      }
      if (item.isSymbolicLink()) {
        record.errors.push({ path: relative(dirname(root), path), error: 'Symlinked evidence entry' });
      } else if (item.isDirectory()) {
        if (item.name === 'lanes') {
          for (const name of await rootNames(path, true)) await visitRoot(join(path, name));
        } else await walk(path, all || item.name === 'agent');
      } else if (item.isFile() && (all || /\.jsonl?$/.test(item.name))) await capture(path);
    }
  }
  async function visitRoot(checkout) {
    await location(join(checkout, '.forge'), 'checkout-markers', path => walk(path, true));
    await location(`${checkout}.forge-client`, 'client-journals', path => walk(path));
    await location(`${checkout}.forge-metrics.jsonl`, 'operation-metrics', capture);
  }
  await visitRoot(root);
  record.complete = record.errors.length === 0;
  await writeFile(join(out, 'capture.json'), JSON.stringify(record, null, 2) + '\n');
  if (!record.complete) throw Error(`BENCH_EVIDENCE_INCOMPLETE ${join(out, 'capture.json')}`);
  return { dir: out, ...record };
}

export async function archiveThenRemove({ root, cellDir, reason, remove }) {
  const capture = await archiveRoot({ root, cellDir, reason });
  await remove(root);
  return capture;
}

/** The last sweep also covers roots whose start/open threw before task registration, reset
 * and oracle roots, and journals left beside an already absent checkout. */
export async function removeWorkspace({
  ws,
  cellDir,
  reason,
  remove = path => rm(path, { recursive: true, force: true }),
}) {
  const names = await rootNames(ws);
  const captures = [];
  for (const name of names) captures.push(await archiveRoot({ root: join(ws, name), cellDir, reason }));
  await remove(ws);
  return captures;
}

async function rootNames(directory, nested = false) {
  const names = new Set();
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.endsWith('.forge-client')) names.add(item.name.slice(0, -13));
    else if (item.name.endsWith('.forge-metrics.jsonl')) names.add(item.name.slice(0, -20));
    else if (item.isDirectory() && (nested || (await inspect(join(directory, item.name, '.forge')))))
      names.add(item.name);
  }
  return names;
}
