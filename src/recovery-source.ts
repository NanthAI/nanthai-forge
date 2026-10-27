import { optionalCheckPath, portableCheckPath, runLogRecord } from './check-log-policy.js';
import { foldHostedRecovery } from './recovery-hosted.js';
import type { HostedRecoveryPage, RecoveryTable } from './recovery-hosted-protocol.js';
import type { ContentPin } from './native-exchange.js';
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { restoreNativeExchangeStage } from './native-backup.js';
import { pullNativeExchange, type ExchangeTransport } from './native-exchange.js';
import { withWorkArchive } from './work-backup-archive.js';
import { overlayHostedJournal } from './work-backup.js';
import { hostedJournalSchema } from './work-metadata.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { fingerprintPrivateFile } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { WorkStore } from './work-store.js';
import { nativeChannels } from './native-work.js';
import { sameRecoveryPins, type RecoveryRequest, type RecoverySelection } from './recovery-protocol.js';
import { writeRecoveryState, writeRecoveryText } from './recovery-state.js';
import { nativeReachable } from './native-reachable.js';
import { NativeSource } from './native-source.js';

export interface RecoveryTransport extends ExchangeTransport {
  prepare(): Promise<unknown>;
  hostedPage?(
    selection: RecoverySelection,
    table: RecoveryTable,
    cursor: string | null,
  ): Promise<HostedRecoveryPage>;
  objects?(ids: string[]): Promise<ContentPin[]>;
  journal(): Promise<string>;
  reconnect(selection: RecoverySelection, requestHash: string, role: 'owner' | 'client'): Promise<unknown>;
  archive(selection: RecoverySelection, path: string): Promise<void>;
}

export async function restoreRecoverySource(
  directory: string,
  target: string,
  request: RecoveryRequest,
  selected: RecoverySelection,
  transport: RecoveryTransport,
) {
  const marker = 'recovery-source.json',
    identity = digest(JSON.stringify(request));
  if (existsSync(target)) {
    const path = join(new WorkStore(target).directory, marker);
    invariant(
      existsSync(path),
      'RESTORE_TARGET_EXISTS',
      'The recovery stage contains unrelated work; it remains unchanged.',
    );
    const retained = JSON.parse(readFileSync(path, 'utf8'));
    invariant(
      retained.identity === identity && sameRecoveryPins(retained.selected, selected),
      'WORK_OPERATION_CHANGED',
      'Retain the original staged recovery and pins.',
    );
    invariant(
      digest(readFileSync(join(directory, 'journal.json'))) === retained.journalSha256,
      'INVALID_WORK_JOURNAL',
      'The retained recovery journal differs from its original bytes.',
    );
    if (selected.hostedMain) {
      await foldHostedRecovery(directory, target, selected, transport);
      retained.workSha256 = digest(new WorkStore(target).snapshotBytes());
      writeRecoveryState(path, retained);
    }
    return recoveryCoverage(
      target,
      nativeManifestSchema.parse(retained.manifest),
      retained.journalSha256,
      selected,
      retained.workSha256,
      null,
    );
  }
  // Never overlay a journal from a later checkpoint or a different project.
  const journalBytes = await transport.journal(),
    raw = JSON.parse(journalBytes),
    journal = hostedJournalSchema.parse(raw);
  invariant(
    journal.projectKey === selected.ownerId &&
      raw.source?.backupId === selected.backupId &&
      journal.revision === selected.revision &&
      journal.base.archiveSha256 === selected.checkpointSha256 &&
      journal.base.manifestSha256 === selected.manifestSha256,
    'WORK_STALE',
    'Hosted source or Work changed before recovery. Retain the original operation and pins.',
  );
  const journalPath = join(directory, 'journal.json');
  writeRecoveryText(journalPath, journalBytes);
  let manifest: ReturnType<typeof nativeManifestSchema.parse> | undefined;
  const started = performance.now();
  const beforePublish = (root: string) =>
    writeRecoveryState(join(new WorkStore(root).directory, marker), {
      identity,
      selected,
      manifest,
      journalSha256: digest(journalBytes),
      workSha256: digest(new WorkStore(root).snapshotBytes()),
    });
  if (request.archivePath || selected.transport === 'archive') {
    const archivePath = request.archivePath ?? join(directory, 'source.tar.gz');
    if (!request.archivePath && !existsSync(archivePath)) await transport.archive(selected, archivePath);
    await withWorkArchive(archivePath, async (backup, pin) => {
      invariant(
        pin.sha256 === selected.checkpointSha256 && pin.size === selected.checkpointSize,
        'INVALID_WORK_BACKUP',
        'Select the exact archive belonging to this hosted checkpoint.',
      );
      overlayHostedJournal(backup, pin.sha256, journalPath);
      manifest = nativeManifestSchema.parse(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')));
      await restoreNativeExchangeStage(backup, target, beforePublish);
    });
  } else {
    const original = await transport.manifest(selected.backupId);
    invariant(
      (original.sourceDigest ?? original.digest) === selected.checkpointSha256 &&
        original.digest === selected.manifestSha256 &&
        digest(original.json) === original.digest,
      'INVALID_WORK_BACKUP',
      'The recovery checkpoint differs from its selected pins.',
    );
    manifest = nativeManifestSchema.parse(JSON.parse(original.json));
    // Reuse the pinned, already authenticated manifest, rather than rediscovering a revision.
    const pinned = Object.create(transport) as RecoveryTransport;
    pinned.manifest = async () => original;
    await pullNativeExchange(selected.backupId, target, pinned, {
      ...(request.cacheRoot ? { cacheRoot: request.cacheRoot } : {}),
      journalPath,
      beforePublish,
    });
  }
  invariant(manifest, 'INVALID_WORK_BACKUP', 'The native recovery manifest is unavailable.');
  if (selected.hostedMain) {
    await foldHostedRecovery(directory, target, selected, transport);
    beforePublish(target);
  }
  return recoveryCoverage(
    target,
    manifest,
    digest(journalBytes),
    selected,
    digest(new WorkStore(target).snapshotBytes()),
    Math.round(performance.now() - started),
  );
}

async function recoveryCoverage(
  target: string,
  manifest: ReturnType<typeof nativeManifestSchema.parse>,
  journalSha256: string,
  selected: RecoverySelection,
  workSha256: string,
  elapsedMs: number | null,
) {
  const store = new WorkStore(target),
    data = store.load();
  invariant(
    digest(store.snapshotBytes()) === workSha256,
    'SOURCE_CHANGED',
    'Staged recovered Work changed; its files are retained.',
  );
  const source = new NativeSource(target);
  for (const id of nativeReachable(store)) source.object(id);
  const evidence = [];
  for (const file of manifest.files.filter(
    file =>
      file.path.startsWith('check-') &&
      (existsSync(join(store.directory, file.path)) || !optionalCheckPath(data, file.path)),
  )) {
    const observed = await fingerprintPrivateFile(join(store.directory, file.path), 'INVALID_WORK_BACKUP');
    // Running-run metadata changes to interrupted; retained evidence bytes remain exact.
    invariant(
      observed.sha256 === file.sha256 && observed.size === file.size,
      'INVALID_WORK_BACKUP',
      'Restored check evidence differs from its captured bytes.',
    );
    evidence.push({ path: file.path, ...observed });
  }
  return {
    rootHead: data.nativeHead,
    main: data.hostedRecovery
      ? {
          name: 'main',
          head: data.hostedRecovery.main.head,
          moveId: data.hostedRecovery.main.receipt.id,
          diagnostic: null,
        }
      : (nativeChannels(data).find(c => c.name === 'main') ?? null),
    ...(data.hostedRecovery ? { hosted: data.hostedRecovery } : {}),
    revision: data.revision,
    journalRevision: selected.revision,
    journalSha256,
    workSha256,
    lanes: data.lanes.map(lane => ({
      id: lane.id,
      base: lane.base,
      head: lane.head,
      checkpoints: lane.checkpoints.map(c => ({ head: c.head, at: c.at })),
    })),
    evidence: {
      included: evidence,
      unavailable: manifest.unavailable.filter(path => portableCheckPath(data, path)),
      checkLogs: manifest.checkLogs ?? data.runs.map(run => runLogRecord(data, run)),
    },
    runs: data.runs.map(run => ({ id: run.id, status: run.status })),
    completeHistory: selected.completeHistory,
    coverage: manifest.coverage,
    elapsedMs,
    omissions: [
      'Uncheckpointed edits, credentials, local bindings, parent-driver retry state and running processes are not restored.',
    ],
  };
}
