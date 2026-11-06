// SPDX-License-Identifier: Apache-2.0
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import {
  assertNoConflictMarkers,
  inPlaceResolution,
  pendingConflictPaths,
} from './hosted-conflict-precheck.js';
import { normalizeHostedFinishResult } from './hosted-agent-finish-result.js';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nativePaths } from './source-paths.js';
import { indexedBlob, readCheckoutStatIndex } from './checkout-stat-index.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { SourceFileReader } from './source-file-reader.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedAgentDirectory, readAgentJson, HostedAgentJournal } from './hosted-agent-journal.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import type { HostedLaneSelection } from './hosted-lane.js';
import type { HostedAgentAddress, hostedAgentCommandSchemas } from './hosted-agent-contract.js';

type Command = z.infer<typeof hostedAgentCommandSchemas.finish>;
const selectionSchema = z.object({
  operationId: z.uuid(),
  fingerprint: z.string(),
  command: z.record(z.string(), z.unknown()),
});
export type FinishSelection = z.infer<typeof selectionSchema>;
export type FinishContext = {
  command: Record<string, unknown>;
  clean: HostedLaneSelection | null;
  previous: FinishSelection | null;
};

/** Only one Lane's metadata and a 1 MiB scan buffer. Source is reread on every new
 * shorthand selection, except files whose lstat the checkout stat index ties to their baseline
 * blob; a cached fingerprint is never source authority. */
export function finishSourceFingerprint(root: string, command: Command, operationId?: string) {
  const marker = readHostedLaneCheckout(root);
  if (
    !marker ||
    command.inputs ||
    command.candidateId ||
    (command.laneId && command.laneId !== marker.selection.laneId)
  )
    return canonicalPayload({
      inputs: command.inputs ?? null,
      candidateId: command.candidateId ?? null,
      laneId: command.laneId ?? null,
    });
  const files = new Map(marker.state.files.map(file => [file.path, file]));
  const local = nativePaths(root, [...files.keys()]);
  const present = new Set(local);
  for (const path of marker.materialized) if (!forgeCachePath(path) && !present.has(path)) files.delete(path);
  const scratch = Buffer.allocUnsafe(1024 * 1024),
    index = readCheckoutStatIndex(root);
  const marked: string[] = [];
  for (const path of local) {
    const stat = lstatSync(join(root, path));
    const mode = stat.isSymbolicLink() ? 'symlink' : stat.mode & 0o111 ? 'executable' : 'file';
    const baseline = files.get(path)?.blob;
    let blob: string;
    // The same blob the bytes would hash to: the stat index vouches only for unchanged baseline files.
    const indexed = baseline ? indexedBlob(index, path, stat, baseline) : undefined;
    if (indexed) blob = indexed;
    else if (mode === 'symlink') blob = digest(readlinkSync(join(root, path), { encoding: 'buffer' }));
    else {
      const reader = new SourceFileReader(root, path, 'SOURCE_CHANGED');
      try {
        const scan = conflictMarkerScan();
        blob = reader.scan(bytes => scanConflictMarkers(scan, bytes), undefined, scratch).sha256;
        if (blob !== baseline && conflictMarkersFound(scan)) marked.push(path);
      } finally {
        reader.close();
      }
    }
    files.set(path, { path, blob, mode });
  }
  assertNoConflictMarkers(
    root,
    marker.selection.laneId,
    marked,
    pendingConflictPaths(root, marker.selection.laneId).length > 0,
    { action: 'finish', parameters: { ...command, ...(operationId ? { operationId } : {}) } },
  );
  return digest(
    canonicalPayload({
      laneId: marker.selection.laneId,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }),
  );
}

/** One durable index per normalized finish selection, independent of history size.
 * Explicit operation replay never changes the latest shorthand selection. */
export async function selectHostedFinish(
  root: string,
  address: HostedAgentAddress,
  actor: string,
  command: Command,
  operationId: string | undefined,
  observe: (
    operationId: string,
    runId?: string,
  ) => Promise<{ status?: string; submission?: { observation?: { state: string } } }>,
) {
  const directory = hostedAgentDirectory(root);
  const source = Object.fromEntries(
    Object.entries(command).filter(
      ([key]) => !['accept', 'message', 'retry', 'reason', 'priority'].includes(key),
    ),
  );
  const index = join(directory, `finish-${digest(canonicalPayload({ root, address, actor, source }))}.json`);
  const explicitReplay = operationId && checkoutPathExists(join(directory, `${operationId}.json`));
  if (explicitReplay) return new HostedAgentJournal(root, address, actor, 'finish', command, operationId);
  const fingerprint = finishSourceFingerprint(root, command, operationId);
  const marker = readHostedLaneCheckout(root);
  const clean =
    marker &&
    fingerprint ===
      digest(
        canonicalPayload({
          laneId: marker.selection.laneId,
          files: [...marker.state.files].sort((a, b) => a.path.localeCompare(b.path)),
        }),
      );
  const previous = checkoutPathExists(index) ? selectionSchema.parse(readAgentJson(index)) : undefined;
  // This folder became the named Lane's conflict resolution: that Lane's saved source is unchanged
  // by anything done here, so its shorthand keeps following the original operation's recovery.
  const resolvedHere =
    !!command.laneId &&
    !!marker &&
    marker.selection.laneId !== command.laneId &&
    !!inPlaceResolution(root, command.laneId);
  const sameSource = previous?.fingerprint === fingerprint || (resolvedHere && previous !== undefined);
  const terminal = async (prior: FinishSelection) => {
    const path = join(directory, `${prior.operationId}.json`);
    if (!checkoutPathExists(path)) return false;
    const saved = readAgentJson(path) as {
      values: Record<string, unknown>;
    };
    if (saved.values['finish-source-failed']) return true;
    try {
      const run = saved.values['finish-check-run'] as { id: string } | undefined;
      const observed = await observe(prior.operationId, run?.id);
      return observed.status
        ? ['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted'].includes(observed.status)
        : Boolean(observed.submission && observed.submission.observation?.state !== 'pending');
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return false;
      throw error;
    }
  };
  let selected = operationId;
  if (!selected && previous && !sameSource && !(await terminal(previous))) selected = previous.operationId;
  if (!selected && previous && sameSource && previous.command.accept === command.accept) {
    if (!command.retry) selected = previous.operationId;
    else if (canonicalPayload(previous.command) === canonicalPayload(command)) {
      if (!(await terminal(previous))) selected = previous.operationId;
    }
  }
  selected ??= randomUUID();
  const reservation = workLocked(join(directory, 'lock'), () => {
    const latest = checkoutPathExists(index) ? selectionSchema.parse(readAgentJson(index)) : undefined;
    // Another caller may have reserved the next generation while terminality
    // was observed outside the lock. Reconcile that unknown outcome first.
    if (
      !operationId &&
      latest &&
      latest.operationId !== previous?.operationId &&
      latest.fingerprint === fingerprint &&
      latest.command.accept === command.accept &&
      latest.command.priority === command.priority
    )
      return latest;
    const retainedCommand =
      !operationId && previous && selected === previous.operationId ? previous.command : command;
    const value = {
      operationId: selected!,
      fingerprint: previous && selected === previous.operationId ? previous.fingerprint : fingerprint,
      command: retainedCommand,
    };
    durableReplace(index, canonicalPayload(value));
    return value;
  });
  selected = reservation.operationId;
  const journal = new HostedAgentJournal(root, address, actor, 'finish', reservation.command, selected);
  await journal.retain<FinishContext>('finish-context', () => ({
    command: reservation.command,
    clean: clean ? marker.selection : null,
    previous: previous && sameSource && previous.operationId !== selected ? previous : null,
  }));
  return journal;
}

export function finishRetryHint(root: string, command: Command, result: Record<string, unknown>) {
  return normalizeHostedFinishResult(root, command, result);
}
