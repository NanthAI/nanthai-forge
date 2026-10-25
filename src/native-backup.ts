// SPDX-License-Identifier: Apache-2.0
import { retainRecoveryCapture } from './recovery-capture.js';
import {
  chmodSync,
  lstatSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { copyPrivate, overlayHostedJournal } from './work-backup.js';
import {
  nativeFileSchema as fileSchema,
  nativeManifestSchema as manifestSchema,
} from './work-archive-metadata.js';
import { inspectArtifacts } from './work-artifacts.js';
import { NativeSource, nativeMarker } from './native-source.js';
import { NativeMaterialization } from './native-materialization.js';
import { WorkStore } from './work-store.js';
import { workSchema, type WorkData } from './work-types.js';
import { digest } from './hash.js';
import { readSource, fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { packWorkArchive, withWorkArchive } from './work-backup-archive.js';
import { validateNativeArchiveRecords } from './native-archive-validation.js';
import { nativeReachable } from './native-reachable.js';
import { diskGuard } from './disk-guard.js';
import {
  artifactArchivePlan,
  deduplicateArtifactFiles,
  materializeArtifactAliases,
} from './native-artifact-alias.js';

export function exportNativeWork(
  store: WorkStore,
  revision: number,
  archive: boolean,
  deduplicateArtifacts = false,
) {
  return exportSnapshot(store, revision, archive, undefined, deduplicateArtifacts);
}
export function exportNativeSource(store: WorkStore, revision: number, head: string) {
  return exportSnapshot(store, revision, true, head);
}
async function exportSnapshot(
  store: WorkStore,
  revision: number,
  archive: boolean,
  head?: string,
  deduplicateArtifacts = false,
) {
  invariant(
    !deduplicateArtifacts || archive,
    'BAD_ARGUMENT',
    'Artifact-deduplicated transport requires an archive export.',
  );
  const snapshot = store.locked(() => {
    const current = store.load();
    invariant(current.revision === revision, 'WORK_STALE', 'Work changed before native export.');
    // A source release carries only a fresh empty native owner, never the original private Work or run logs.
    const data: WorkData = head
      ? workSchema.parse({ schema: 1, revision: 0, nativeHead: head, intents: [], lanes: [], views: [] })
      : current;
    return {
      data,
      capturedAt: new Date().toISOString(),
      ids: nativeReachable(store, data),
      bytes: head ? Buffer.from(JSON.stringify(data, null, 2)) : store.snapshotBytes(),
    };
  });
  const path = mkdtempSync(join(store.directory, 'native-backup-')),
    files: z.infer<typeof fileSchema>[] = [],
    unavailable: string[] = [];
  async function copy(source: string, sourcePath: string, destination: string) {
    const observed = await copyPrivate(join(source, sourcePath), join(path, destination));
    files.push({ path: destination, ...observed });
    return observed;
  }
  writeFileSync(join(path, 'work.json'), snapshot.bytes, { flag: 'wx', mode: 0o600 });
  files.push({ path: 'work.json', size: snapshot.bytes.length, sha256: digest(snapshot.bytes) });
  mkdirSync(join(path, 'objects'), { mode: 0o700 });
  const source = new NativeSource(store.root);
  for (const id of snapshot.ids) {
    // Immutable objects are copied through their authoritative digest-bound reader.
    // Filesystem timestamp hydration cannot replace exact original bytes.
    const bytes = source.object(id),
      destination = join(path, 'objects', id);
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    const observed = await fingerprintPrivateFile(destination, 'INVALID_WORK_BACKUP');
    invariant(
      observed.sha256 === id && observed.size === bytes.length,
      'INVALID_WORK_BACKUP',
      'Original native source changed during export.',
    );
    files.push({ path: `objects/${id}`, ...observed });
  }
  for (const run of snapshot.data.runs) {
    const dir = join(store.directory, `check-${run.id}`);
    for (const name of [
      'stdout.log',
      'stderr.log',
      ...(run.endedAt ? ['result.json'] : []),
      ...(run.resourceUsage?.producer ? ['resources.txt'] : []),
    ]) {
      const recorded = `check-${run.id}/${name}`;
      if (existsSync(join(dir, name))) await copy(dir, name, recorded);
      else unavailable.push(recorded);
    }
    try {
      await inspectArtifacts(dir, run);
      for (const artifact of run.artifacts ?? [])
        if (artifact.status === 'retained') {
          const observed = await copy(
            dir,
            `artifacts/${artifact.filename}`,
            `check-${run.id}/artifacts/${artifact.filename}`,
          );
          invariant(
            observed.sha256 === artifact.sha256 && observed.size === artifact.size,
            'INVALID_WORK_BACKUP',
            'Original build output changed during export.',
          );
        }
    } catch (error) {
      if (files.some(file => file.path.startsWith(`check-${run.id}/artifacts/`))) throw error;
      unavailable.push(
        ...(run.artifacts ?? []).map(item =>
          item.status === 'retained' ? `check-${run.id}/artifacts/${item.filename}` : item.sourcePath,
        ),
      );
    }
  }
  writeFileSync(
    join(path, 'recovery-timing.json'),
    JSON.stringify({ capturedAt: snapshot.capturedAt, evidenceCapturedAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 },
  );
  const aliases = deduplicateArtifacts ? deduplicateArtifactFiles(files) : undefined;
  const logicalBytes = files.reduce((total, file) => total + file.size, 0),
    physical = aliases ? files.filter(file => !aliases.some(alias => alias.path === file.path)) : files;
  const json = JSON.stringify(
    manifestSchema.parse({
      schema: deduplicateArtifacts ? 2 : 1,
      ...(aliases ? { artifactAliases: aliases } : {}),
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head: snapshot.data.nativeHead,
      revision: snapshot.data.revision,
      files,
      unavailable,
      coverage: head
        ? 'Selected native State and reachable ancestry/source, including intact original imported Git bundles and their refs. Only an empty native restore owner is included; original Work, discussion, planning, run logs, build outputs, projections, uncheckpointed files, ignored credentials and provider grants are excluded.'
        : 'Complete retained native States, source bytes, Work records and available recorded run files. Native source-archive contribution receipts retain original archive digests and claims; contributor archive Work/log bytes remain in original saved/provider files, not this owner backup. Git compatibility contributions retain their original uploaded bundle, reachable candidate and base-projection bundles, source-to-Git mapping, original Git commit objects and receipt pins in this full backup. Source-only releases exclude contribution receipts and base projections. Uncheckpointed workspace changes, new ignored files/credentials, graphs, provider grants and running processes are excluded. Explicitly imported tracked Git source/history may include private credentials. Restore never runs recorded commands.',
    }),
    null,
    2,
  );
  writeFileSync(join(path, 'manifest.json'), json, { flag: 'wx', mode: 0o600 });
  const file = archive
    ? await packWorkArchive(
        path,
        physical.map(file => file.path),
      )
    : { path: join(path, 'manifest.json'), ...(await fingerprintPrivateFile(join(path, 'manifest.json'))) };
  return {
    revision: store.load().revision,
    result: {
      ...(!head
        ? {
            recovery: retainRecoveryCapture(
              store,
              path,
              { sha256: digest(json), size: Buffer.byteLength(json) },
              { kind: 'export' },
            ),
          }
        : {}),
      path,
      json,
      sha256: digest(json),
      files: files.length,
      unavailable,
      coverage: JSON.parse(json).coverage,
      ...(deduplicateArtifacts
        ? {
            transport: {
              schema: 2,
              logicalFiles: files.length,
              physicalFiles: physical.length,
              logicalBytes,
              physicalBytes: physical.reduce((total, file) => total + file.size, 0),
              aliasedArtifacts: aliases!.length,
              requiresReader: 'Forge native backup schema 2',
            },
          }
        : {}),
      ...(archive ? { archive: file } : {}),
    },
  };
}
async function stageFingerprint(directory: string, path: string) {
  let current = directory;
  try {
    for (const part of path.split('/')) {
      current = join(current, part);
      invariant(
        !lstatSync(current).isSymbolicLink(),
        'INVALID_WORK_BACKUP',
        'Native backup bytes differ from their manifest.',
      );
    }
  } catch {
    invariant(false, 'INVALID_WORK_BACKUP', 'Native backup bytes differ from their manifest.');
  }
  return fingerprintPrivateFile(current, 'INVALID_WORK_BACKUP');
}
function pruneStage(directory: string, paths: Set<string>, prefix = '') {
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      pruneStage(directory, paths, path);
      if (!readdirSync(join(directory, path)).length) rmdirSync(join(directory, path));
    } else if (!paths.has(path)) rmSync(join(directory, path));
  }
}
async function restoreDirectory(
  directory: string,
  target: string,
  disposable = false,
  beforePublish?: (root: string) => void,
) {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  } catch {
    invariant(false, 'INVALID_WORK_BACKUP', 'Native backup manifest is invalid.');
  }
  const destination = resolve(target);
  invariant(
    !existsSync(destination),
    'RESTORE_TARGET_EXISTS',
    'Choose a new native restore destination; existing work is preserved.',
  );
  const plan = artifactArchivePlan(manifest);
  const scratch = realpathSync(
    mkdtempSync(join(realpathSync(dirname(destination)), '.forge-native-restore-')),
  );
  try {
    const owner = join(scratch, 'owner'),
      work = join(owner, '.forge/work');
    mkdirSync(join(owner, '.forge'), { recursive: true, mode: 0o700 });
    nativeMarker(owner);
    let moved = false;
    if (disposable) {
      // Only the exchange caller's exclusive disposable stage can be moved.
      // Validate before and after moving; no persisted validation proof is used.
      for (const file of plan.physical) {
        const observed = await stageFingerprint(directory, file.path);
        invariant(
          observed.size === file.size && observed.sha256 === file.sha256,
          'INVALID_WORK_BACKUP',
          'Native backup bytes differ from their manifest.',
        );
        chmodSync(join(directory, file.path), 0o600);
      }
      pruneStage(directory, new Set(['manifest.json', ...plan.physical.map(file => file.path)]));
      try {
        renameSync(directory, work);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      }
    }
    if (!moved) {
      mkdirSync(join(work, 'objects'), { recursive: true, mode: 0o700 });
      for (const file of plan.physical) {
        const bytes = readSource(directory, file.path, file.size + 1);
        invariant(
          bytes && bytes.length === file.size && digest(bytes) === file.sha256,
          'INVALID_WORK_BACKUP',
          'Native backup bytes differ from their manifest.',
        );
        const path = join(work, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      }
    } else {
      rmSync(join(work, 'manifest.json'));
      // Pull may have received every logical alias already; rebuild aliases by
      // their original checked plan, just as caller-owned archive restoration.
      for (const alias of plan.aliases) rmSync(join(work, alias.path), { force: true });
    }
    await materializeArtifactAliases(work, manifest.files, plan.aliases);
    for (const file of manifest.files) {
      if (disposable) {
        const observed = await stageFingerprint(work, file.path);
        invariant(
          observed.size === file.size && observed.sha256 === file.sha256,
          'INVALID_WORK_BACKUP',
          'Native backup bytes differ from their manifest.',
        );
      } else {
        const bytes = readSource(work, file.path, file.size + 1);
        invariant(
          bytes && bytes.length === file.size && digest(bytes) === file.sha256,
          'INVALID_WORK_BACKUP',
          'Native backup bytes differ from their manifest.',
        );
      }
    }
    const data = new WorkStore(owner).load();
    validateNativeArchiveRecords(new WorkStore(owner), manifest, data);
    const materialized = join(scratch, 'materialized'),
      source = new NativeMaterialization(owner),
      warnings: string[] = [];
    try {
      source.materialize(manifest.head, materialized, false);
      // This whole owner is private until the final publication below. Use a
      // sibling staging name so ordinary live-Lane publication does not flush
      // every file for each historical Lane. Immutable source remains retained
      // and all independent working files must exist before owner publication.
      for (const lane of data.lanes) {
        const staged = join(work, `restore-${lane.id}`);
        warnings.push(...diskGuard(owner));
        warnings.push(...source.materialize(lane.head, staged));
        renameSync(staged, join(work, `lane-${lane.id}`));
      }
    } finally {
      source.dispose();
    }
    renameSync(join(owner, '.forge'), join(materialized, '.forge'));
    let interrupted = false;
    for (const run of [...data.runs, ...data.playbookRuns])
      if (['queued', 'preparing', 'running'].includes(run.status)) {
        interrupted = true;
        run.status = 'interrupted';
        run.endedAt = new Date().toISOString();
        run.details += ' Native snapshot restored without restarting commands.';
      }
    if (interrupted) data.revision++;
    if (interrupted) new WorkStore(materialized).save(data);
    beforePublish?.(materialized);
    mkdirSync(destination, { mode: 0o700 });
    try {
      renameSync(materialized, destination);
    } catch (error) {
      try {
        rmdirSync(destination);
      } catch {
        /* Preserve concurrent files. */
      }
      throw error;
    }
    return {
      root: destination,
      head: manifest.head,
      revision: data.revision,
      restored: true,
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
      unavailable: manifest.unavailable,
      coverage: manifest.coverage,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Internal handoff: only a caller-created disposable exchange directory may be consumed.
// Public archive/directory restore below always leaves its supplied input intact.
export async function restoreNativeExchangeStage(
  directory: string,
  target: string,
  beforePublish?: (root: string) => void,
) {
  return restoreDirectory(directory, target, true, beforePublish);
}

export async function restoreNativeWork(input: string, target: string, journalPath?: string) {
  const use = (directory: string) => restoreDirectory(directory, target);
  if (existsSync(join(input, 'manifest.json'))) {
    invariant(!journalPath, 'BAD_ARGUMENT', 'Restore a hosted journal with its original archive file.');
    return use(input);
  }
  return withWorkArchive(input, async (directory, archive) => {
    if (journalPath) overlayHostedJournal(directory, archive.sha256, journalPath);
    return use(directory);
  });
}
