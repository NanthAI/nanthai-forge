// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CheckQueue } from '../../dist/check-queue.js';
import { failure, readSnapshot } from './hosted-durability-compare.mjs';
import { r2Client } from './hosted-backup-r2.mjs';

const week = 7 * 24 * 60 * 60 * 1000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export async function fileDigest(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest('hex') };
}
async function load(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { receipts: {} };
    throw failure('BACKUP_STATE_INVALID');
  }
}
async function save(path, value) {
  const temp = path + '.' + randomUUID();
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}
export function backupStatus(state, now = new Date()) {
  const last = state.lastSuccess ?? null;
  return {
    operation: 'backup-status',
    lastSuccess: last,
    lastAttempt: state.lastAttempt ?? null,
    missedWeek: !last || now.getTime() - Date.parse(last) > week,
    pending: !!state.pending,
  };
}
export async function readBackupStatus(directory, now) {
  return backupStatus(await load(join(directory, 'last-run.json')), now);
}

async function confirm(client, key, expected) {
  const head = await client.head(key);
  if (!head) return false;
  // Metadata alone does not establish the checksum of multipart content. Read back and hash.
  if (head.size !== expected.size || (head.sha256 && head.sha256 !== expected.sha256))
    throw failure('BACKUP_CHECKSUM_MISMATCH');
  const actual = await client.digest(key);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
    throw failure('BACKUP_CHECKSUM_MISMATCH');
  return true;
}
async function upload(client, pending, path, persist) {
  if (await confirm(client, pending.key, pending)) return;
  if (!pending.uploadId) {
    pending.uploadId = await client.create(pending.key, pending.sha256);
    await persist();
  }
  const file = await open(path, 'r');
  const parts = [];
  try {
    const partSize = 16 * 1024 * 1024;
    for (let offset = 0; offset < pending.size; offset += partSize) {
      const bytes = Buffer.alloc(Math.min(partSize, pending.size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw failure('BACKUP_STATE_INVALID');
      parts.push(await client.part(pending.key, pending.uploadId, parts.length + 1, bytes));
    }
  } finally {
    await file.close();
  }
  // On a lost completion response, preserve the original key/upload ID for HEAD reconciliation.
  await client.complete(pending.key, pending.uploadId, parts);
  if (!(await confirm(client, pending.key, pending))) throw failure('BACKUP_CHECKSUM_MISMATCH');
}

export async function pruneBackups(client, prefix, currentKey) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escaped}(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-[a-f0-9-]{36})/manifest\\.json$`,
  );
  const keys = await client.list(prefix);
  const backups = [...new Set(keys.filter(key => pattern.test(key)))].sort().reverse();
  // Reserve a slot for this run even when clocks move backwards or a newer run exists.
  const keep = new Set([currentKey.replace(/snapshot\.zip$/, 'manifest.json')]);
  for (const key of backups) {
    if (keep.size >= 4) break;
    keep.add(key);
  }
  let pruned = 0;
  for (const manifest of backups) {
    if (keep.has(manifest)) continue;
    const key = manifest.replace(/manifest\.json$/, 'snapshot.zip');
    // Never derive deletions from a manifest body, arbitrary list entries, or another prefix.
    await client.remove(key);
    await client.remove(manifest);
    pruned++;
  }
  return pruned;
}

export async function backup(command, exportSnapshot, options = {}) {
  const now = options.now ?? new Date();
  const directory = command.stateDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const queue = new CheckQueue(join(directory, 'queue'), {
    limit: 1,
    serializeAdmission: false,
    anchor: directory,
  });
  try {
    if (!queue.position().acquired) throw failure('BACKUP_BUSY');
    const path = join(directory, 'last-run.json');
    const state = await load(path);
    const previous = backupStatus(state, now);
    const target = { deployment: command.deployment, bucket: command.bucket, prefix: command.prefix };
    if (state.target && JSON.stringify(state.target) !== JSON.stringify(target))
      throw failure('BACKUP_TARGET_MISMATCH');
    state.target = target;
    if (command.operationId && state.receipts[command.operationId])
      return state.receipts[command.operationId];
    if (state.pending && command.operationId && state.pending.id !== command.operationId)
      throw failure('BACKUP_PENDING');
    const client = options.client ?? r2Client();
    if (!state.pending) {
      const id = command.operationId ?? randomUUID();
      if (!uuid(id)) throw failure('ARGUMENT_INVALID');
      const time = now.toISOString();
      const name = `${time.replaceAll(':', '-')}-${id}`;
      state.pending = { id, time, key: command.prefix + name + '/snapshot.zip' };
      await save(path, state);
    }
    const pending = state.pending;
    const snapshot = join(directory, pending.id + '.zip');
    try {
      if (!pending.manifest) {
        // Publish an export only after the exporter and ZIP/storage/Work verification succeed.
        const temp = snapshot + '.partial.zip';
        await rm(temp, { force: true });
        await exportSnapshot(command.deployment, temp);
        const summary = await (options.verifySnapshot ?? readSnapshot)(temp);
        const digest = await fileDigest(temp);
        await rename(temp, snapshot);
        Object.assign(pending, digest);
        // No remote write has happened yet. Name a re-export by its actual snapshot
        // observation, so a retry after an export failure sorts by the new data.
        pending.time = now.toISOString();
        pending.key = command.prefix + `${pending.time.replaceAll(':', '-')}-${pending.id}/snapshot.zip`;
        const identity = options.identity ?? (await sourceIdentity());
        pending.manifest = {
          format: 1,
          operationId: pending.id,
          time: now.toISOString(),
          deployment: command.deployment,
          ...digest,
          storedFiles: summary.files,
          identity,
        };
        await save(path, state);
      }
      if (
        JSON.stringify(await fileDigest(snapshot)) !==
        JSON.stringify({ size: pending.size, sha256: pending.sha256 })
      )
        throw failure('BACKUP_CHECKSUM_MISMATCH');
      await upload(client, pending, snapshot, () => save(path, state));
      const manifest = Buffer.from(JSON.stringify(pending.manifest) + '\n');
      const manifestKey = pending.key.replace(/snapshot\.zip$/, 'manifest.json');
      const manifestDigest = { size: manifest.length, sha256: sha(manifest) };
      if (!(await confirm(client, manifestKey, manifestDigest))) {
        await client.put(manifestKey, manifest, manifestDigest.sha256);
        if (!(await confirm(client, manifestKey, manifestDigest))) throw failure('BACKUP_CHECKSUM_MISMATCH');
      }
      const pruned = await pruneBackups(client, command.prefix, pending.key);
      const result = {
        operation: 'backup',
        complete: true,
        operationId: pending.id,
        time: pending.manifest.time,
        size: pending.size,
        sha256: pending.sha256,
        pruned,
        missedWeek: previous.missedWeek,
      };
      state.lastSuccess = pending.manifest.time;
      state.lastAttempt = { time: now.toISOString(), status: 'passed' };
      state.receipts[pending.id] = result;
      delete state.pending;
      await save(path, state);
      try {
        await rm(snapshot, { force: true });
      } catch {
        return { ...result, localSnapshotRetained: true };
      }
      return result;
    } catch (error) {
      state.lastAttempt = { time: now.toISOString(), status: 'failed' };
      await save(path, state);
      throw error;
    }
  } finally {
    queue.release();
  }
}
async function sourceIdentity() {
  const root = new URL('../../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = await readFile(new URL('package-lock.json', root));
  const files = [
    'scripts/hosted-durability.mjs',
    'scripts/lib/hosted-backup.mjs',
    'scripts/lib/hosted-backup-r2.mjs',
    'scripts/lib/hosted-durability-compare.mjs',
    'scripts/lib/hosted-durability-zip.py',
    'src/r2-presign.ts',
  ];
  const source = createHash('sha256');
  for (const file of files) source.update(file + '\0').update(await readFile(new URL(file, root)));
  return {
    package: pkg.name,
    version: pkg.version,
    lockfileSha256: sha(lock),
    backupSourceSha256: source.digest('hex'),
  };
}
