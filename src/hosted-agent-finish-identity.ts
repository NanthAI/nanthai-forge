// SPDX-License-Identifier: Apache-2.0
import { checkTerminal } from './check-run-state.js';
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import {
  assertNoConflictMarkers,
  inPlaceOrigin,
  inPlaceResolution,
  pendingConflictPaths,
} from './hosted-conflict-precheck.js';
import { normalizeHostedFinishResult } from './hosted-agent-finish-result.js';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nativePaths } from './source-paths.js';
import { backgroundSaveOperation } from './hosted-save-pending.js';
import { capturedTree, unsavedPaths } from './hosted-save-receipt-state.js';
import { cachedSourcePaths, indexedBlob, readCheckoutStatIndex } from './checkout-stat-index.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { SourceFileReader } from './source-file-reader.js';
import { digest } from './hash.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { hostedAgentDirectory, readAgentJson, HostedAgentJournal } from './hosted-agent-journal.js';
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedLaneSelection } from './hosted-lane.js';
import type { HostedAgentAddress, hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { diskMode } from './source-links.js';
import { readSource } from './files.js';
import { clientCacheRoot } from './root-paths.js';
import { readOverlapBytes } from './hosted-overlap-text.js';
import { storedBytes, worktreeText } from './checkout-text.js';

type Command = z.infer<typeof hostedAgentCommandSchemas.finish>;
const selectionSchema = z.object({
  operationId: z.uuid(),
  fingerprint: z.string(),
  command: z.record(z.string(), z.unknown()),
  checkoutLaneId: z.uuid().optional(),
});
export type FinishSelection = z.infer<typeof selectionSchema>;
/** Journal key: this finish was refused before it submitted anything (a known refusal code). */
export const finishRefusedKey = 'finish-refused';
/** Refusals thrown before compose or submission: the operation ended, nothing runs on the server. */
export const FINISH_REFUSALS = new Set([
  'NOTHING_TO_LAND',
  'UNSAVED_LANE_EDITS',
  'PREFLIGHT_REQUIRED',
  'PREFLIGHT_BUDGET_EXCEEDED',
]);
export type FinishContext = {
  command: Record<string, unknown>;
  clean: HostedLaneSelection | null;
  previous: FinishSelection | null;
};

/** Older finish selections retained the checkout binding only once they pinned a source step. */
function legacyFinishLane(root: string, directory: string, operationId: string) {
  const path = join(directory, `${operationId}.json`);
  if (!checkoutPathExists(path)) return undefined;
  const { values } = readAgentJson(path) as { values: Record<string, unknown> };
  const context = values['finish-context'] as FinishContext | undefined;
  if (context?.clean) return context.clean.laneId;
  const compose = values[`compose:${String(values['finish-compose-operation'])}`] as
    | { pages: { kind: string; value: { entries: { laneId?: string }[] } }[] }
    | undefined;
  const inputLane = compose?.pages.find(page => page.kind === 'inputs')?.value.entries[0]?.laneId;
  if (inputLane) return inputLane;
  // A dirty checkout may already have saved when compose selection loses its reply. The small
  // save request survives settlement and pins the Lane even before compose records its inputs.
  const save = z.uuid().safeParse(values['id:save']);
  if (!save.success) return undefined;
  const request = join(clientCacheRoot(root), 'saves', save.data, 'request.json');
  return checkoutPathExists(request) ? (readAgentJson(request) as { laneId: string }).laneId : undefined;
}

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
  const { files, marked } = scanCheckout(root, marker);
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

/** The checkout's current files by path, and the paths whose bytes or mode differ from the saved
 * baseline (edited, added or deleted): the unsaved edits. One local scan; unchanged baseline files
 * are vouched for by the stat index and never reread. */
export function scanCheckout(root: string, marker: HostedLaneCheckoutMarker) {
  const baselineFiles = new Map(marker.state.files.map(file => [file.path, file]));
  const files = new Map(baselineFiles);
  // No walk while the last recorded one holds (checkout-tree.json; Issue 48835eea).
  const local = cachedSourcePaths(root, files.keys()) ?? nativePaths(root, [...files.keys()]);
  const present = new Set(local);
  const changed: string[] = [];
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path)) {
      files.delete(path);
      if (baselineFiles.has(path)) changed.push(path);
    }
  const scratch = Buffer.allocUnsafe(1024 * 1024),
    index = readCheckoutStatIndex(root),
    text = worktreeText(root, marker.state.files);
  const marked: string[] = [];
  for (const path of local) {
    const stat = lstatSync(join(root, path));
    const before = baselineFiles.get(path);
    // A submodule is its pointer: a pointer file or a checkout (directory) whose HEAD names it.
    const mode = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory() || before?.mode === 'gitlink'
        ? 'gitlink'
        : diskMode(stat, before?.mode);
    const baseline = files.get(path)?.blob;
    let blob: string;
    // The same blob the bytes would hash to: the stat index vouches only for unchanged baseline files.
    const indexed = baseline && !stat.isDirectory() ? indexedBlob(index, path, stat, baseline) : undefined;
    if (stat.isDirectory()) blob = digest(gitlinkDirectoryPointer(root, path));
    else if (indexed) blob = indexed;
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
      // The blob a save stores: `.gitattributes` text files are normalised to LF (44ef42b9).
      if (text && blob !== baseline && text.action(path) !== 'binary') {
        const bytes = readSource(root, path, Number.MAX_SAFE_INTEGER);
        if (bytes) {
          const old = baseline;
          blob = digest(
            storedBytes(
              text,
              path,
              mode,
              bytes,
              old ? { blob: old, read: () => readOverlapBytes(clientCacheRoot(root), old) } : undefined,
            ),
          );
        }
      }
    }
    if (!before || before.blob !== blob || before.mode !== mode) changed.push(path);
    files.set(path, { path, blob, mode });
  }
  return { files, marked, changed };
}

/** `status {files:true}` (git status): this folder's files that differ from its saved head, from
 * the same local scan a save makes. No server call; at most 50 paths listed (ad80e037). While a save
 * of this folder is settling (it returned before the server finished), the files that equal what it
 * captured are `settling`, not unsaved; only files that differ from its capture are unsaved
 * (friction 9124ec2f). Local capture read only. */
export function unsavedFiles(root: string, laneId?: string) {
  const marker = readHostedLaneCheckout(root);
  if (!marker || (laneId && marker.selection.laneId !== laneId))
    throw new ForgeError(
      'HOSTED_CHECKOUT_REQUIRED',
      'Run status {"files":true} in the Lane folder printed by start: it compares that folder with its saved head.',
    );
  const { files, changed, marked } = scanCheckout(root, marker);
  const settlingId = backgroundSaveOperation(root),
    captured = settlingId ? capturedTree(root, settlingId) : null;
  // Differs from what the settling save captured: still unsaved once it settles. Unreadable: all unsaved.
  let pending: Set<string> | null = null;
  if (captured)
    try {
      pending = new Set(unsavedPaths(root, captured) ?? changed);
    } catch {
      pending = null;
    }
  const saved = new Set(marker.state.files.map(file => file.path));
  const capturedPaths = pending && captured ? new Set(captured.files.map(file => file.path)) : saved;
  const row = (path: string, against: Set<string>) => ({
    path,
    change: !against.has(path) ? 'added' : files.has(path) ? 'modified' : 'deleted',
    ...(marked.includes(path) ? { conflictMarkers: true } : {}),
  });
  const rows = [...(pending ?? new Set(changed))].sort().map(path => row(path, capturedPaths)),
    held = pending
      ? [...new Set(changed)]
          .filter(path => !pending.has(path))
          .sort()
          .map(path => row(path, saved))
      : [];
  const list = (items: typeof rows) => ({
    count: items.length,
    paths: items.slice(0, 50),
    ...(items.length > 50 ? { more: items.length - 50 } : {}),
  });
  const settling =
    pending && settlingId
      ? {
          operationId: settlingId,
          captured: captured!.changes,
          ...list(held),
        }
      : undefined;
  return {
    laneId: marker.selection.laneId,
    head: marker.selection.head,
    unsaved: list(rows),
    ...(settling ? { settling } : {}),
    note: [
      settling
        ? `Settling: save ${settlingId} (${settling.captured} captured file${settling.captured === 1 ? '' : 's'}) is still finishing on the server; the files listed under settling are in it, and the next command here reports its outcome.`
        : '',
      rows.length
        ? `Unsaved: save records these files; land --save saves and lands them. Undo one file (git checkout -- FILE): x snapshots {"restore":"saved","paths":["FILE"]}.`
        : settling
          ? 'Nothing else is unsaved.'
          : 'This folder matches its saved head.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Fields that select the source independently of the landing options. */
export function finishSourceSelection(command: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(command).filter(
      ([key]) =>
        ![
          'accept',
          'message',
          'retry',
          'reason',
          'priority',
          'tokens',
          'maxChecks',
          'notVerified',
          'operationId',
        ].includes(key),
    ),
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
  const source = finishSourceSelection(command);
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
  const checkoutLaneId =
    !command.laneId && !command.candidateId && !command.inputs ? marker?.selection.laneId : undefined;
  const readSelection = () => {
    if (!checkoutPathExists(index)) return undefined;
    const selection = selectionSchema.parse(readAgentJson(index));
    if (selection.checkoutLaneId !== undefined)
      return selection.checkoutLaneId === checkoutLaneId ? selection : undefined;
    // A matching legacy fingerprint already includes this Lane's id. After an in-place resolution,
    // a different fingerprint needs a retained pin before it can replay a shorthand operation.
    if (
      checkoutLaneId &&
      selection.fingerprint !== fingerprint &&
      inPlaceOrigin(root) &&
      legacyFinishLane(root, directory, selection.operationId) !== checkoutLaneId
    )
      return undefined;
    return selection;
  };
  const previous = readSelection();
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
    // A refusal before anything was submitted (nothing to land, an unanswered gate) ended that
    // operation: new source is new work. No server read (ac13de6b).
    if (saved.values['finish-source-failed'] || saved.values[finishRefusedKey]) return true;
    const run = saved.values['finish-check-run'] as { id: string } | undefined;
    // A check-only finish is never a landing, so the landing page has no row for it: without a run
    // it is still preparing (or its enqueue reply was lost) and is replayed, at zero reads.
    if (!run && prior.command.accept === false) return false;
    try {
      const observed = await observe(prior.operationId, run?.id);
      return observed.status
        ? checkTerminal(observed.status)
        : Boolean(observed.submission && observed.submission.observation?.state !== 'pending');
    } catch (error) {
      // A hosted read throws the server's code inside ConvexError data, not on the error itself.
      if (hostedActionError(error, 'observation').code === 'NOT_FOUND') return false;
      throw error;
    }
  };
  const staleRefused = (prior: FinishSelection) => {
    const path = join(directory, `${prior.operationId}.json`);
    return (
      checkoutPathExists(path) &&
      (readAgentJson(path) as { values: Record<string, unknown> }).values[finishRefusedKey] === 'WORK_STALE'
    );
  };
  // Refused over maxChecks before it submitted: another maxChecks (or none) is new work (ad80e037).
  const roomRefused = (prior: FinishSelection) => {
    const path = join(directory, `${prior.operationId}.json`);
    const refused =
      checkoutPathExists(path) &&
      (readAgentJson(path) as { values: Record<string, unknown> }).values[finishRefusedKey];
    return (
      (refused === 'NO_QUEUE_ROOM' || refused === 'MAX_CHECKS_UNSUPPORTED') &&
      prior.command.maxChecks !== command.maxChecks
    );
  };
  let selected = operationId;
  if (!selected && previous && !sameSource && !(await terminal(previous))) selected = previous.operationId;
  if (!selected && previous && sameSource && previous.command.accept === command.accept) {
    // A pre-submit WORK_STALE pinned that operation to Lane pins that moved on: never replay it.
    if (!command.retry) {
      if (!staleRefused(previous) && !roomRefused(previous)) selected = previous.operationId;
    } else if (canonicalPayload(previous.command) === canonicalPayload(command)) {
      if (!(await terminal(previous))) selected = previous.operationId;
    }
  }
  selected ??= randomUUID();
  // A claim belongs to the operation, not the source lookup used to find a prior check.
  const sameClaim = (retained: FinishSelection) =>
    invariant(
      JSON.stringify(retained.command.notVerified) === JSON.stringify(command.notVerified),
      'WORK_OPERATION_CHANGED',
      `Landing operation ${retained.operationId} already has its original notVerified value. Replay its original request, or use a fresh operationId once it ends.`,
    );
  const reservation = workLocked(join(directory, 'lock'), () => {
    const latest = readSelection();
    // Another caller may have reserved the next generation while terminality
    // was observed outside the lock. Reconcile that unknown outcome first.
    if (
      !operationId &&
      latest &&
      latest.operationId !== previous?.operationId &&
      latest.fingerprint === fingerprint &&
      latest.command.accept === command.accept &&
      latest.command.priority === command.priority &&
      latest.command.maxChecks === command.maxChecks
    ) {
      sameClaim(latest);
      return latest;
    }
    if (!operationId && previous && selected === previous.operationId) sameClaim(previous);
    const retainedCommand =
      !operationId && previous && selected === previous.operationId ? previous.command : command;
    const value = {
      operationId: selected!,
      fingerprint: previous && selected === previous.operationId ? previous.fingerprint : fingerprint,
      command: retainedCommand,
      ...(checkoutLaneId ? { checkoutLaneId } : {}),
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
