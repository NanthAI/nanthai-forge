// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { durableReplace } from './state/durability.js';
import { safeRelative } from './safe-relative.js';
import { SourceFileReader } from './source-file-reader.js';
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import { shellQuote } from './shell-quote.js';
import { ForgeError } from './errors.js';
import { conflictFinishOptions, type ConflictFinishOptions } from './hosted-conflict-finish-options.js';
import { cliVerb } from './agent-verbs.js';

const pathFor = (root: string) => join(clientCacheRoot(root), 'conflict-paths.json');
export type ConflictContinuation = {
  action: 'save' | 'sync' | 'finish' | 'resolve' | 'abandon';
  parameters: Record<string, unknown>;
};
type ResolveParameters = { laneId?: string | undefined; message?: string | undefined; operationId: string };
type ConflictContext = {
  laneId: string;
  paths: string[];
  resolveParameters?: ResolveParameters | undefined;
  resolved?: boolean;
  finishOptions?: ConflictFinishOptions | undefined;
  /** The landing step a completed resolve returned; replays point here instead of resolve. */
  finishParameters?: Record<string, unknown> | undefined;
  /** Set when this folder itself became the resolution Lane of its own conflicted Lane. */
  originLaneId?: string | undefined;
  /** Earlier Lanes of a chain of in-place resolutions in this folder, oldest first (b5e8e2d5). */
  earlierOrigins?: string[] | undefined;
  /** The head the sync merged in (main, or the stack parent), and the resolution Lane's recorded base
   * at that time: its own change is measured from the merged head, not from that older base. */
  merged?: { head: string; base: string } | undefined;
  /** The conflict draft this record belongs to (head, and the Lane version that holds it): a Lane that
   * takes a new draft in place (b5e8e2d5) keeps one record, so older replays must not write it. */
  draft?: ConflictDraft | undefined;
};
const sha256 = /^[a-f0-9]{64}$/;
type ConflictDraft = { head: string; version: number };
function context(root: string, laneId?: string): ConflictContext | undefined {
  try {
    const saved = JSON.parse(readFileSync(pathFor(root), 'utf8'));
    if (
      (laneId && saved.laneId !== laneId) ||
      typeof saved.laneId !== 'string' ||
      !Array.isArray(saved.paths)
    )
      return undefined;
    const parameters = saved.resolveParameters;
    const valid =
      parameters &&
      z.uuid().safeParse(parameters.operationId).success &&
      (parameters.laneId === undefined || parameters.laneId === saved.laneId) &&
      (parameters.message === undefined || typeof parameters.message === 'string');
    return {
      laneId: saved.laneId,
      paths: saved.paths.filter(
        (path: unknown): path is string => typeof path === 'string' && safeRelative(path),
      ),
      resolveParameters: valid
        ? {
            operationId: parameters.operationId,
            ...(parameters.laneId === undefined ? {} : { laneId: parameters.laneId }),
            ...(parameters.message === undefined ? {} : { message: parameters.message }),
          }
        : undefined,
      resolved: saved.resolved === true,
      finishOptions: conflictFinishOptions(saved.finishOptions),
      finishParameters:
        saved.finishParameters &&
        typeof saved.finishParameters === 'object' &&
        z.uuid().safeParse(saved.finishParameters.operationId).success &&
        (saved.finishParameters.laneId === undefined || saved.finishParameters.laneId === saved.laneId)
          ? saved.finishParameters
          : undefined,
      originLaneId: z.uuid().safeParse(saved.originLaneId).success ? saved.originLaneId : undefined,
      earlierOrigins: Array.isArray(saved.earlierOrigins)
        ? saved.earlierOrigins.filter((id: unknown) => z.uuid().safeParse(id).success).slice(-8)
        : undefined,
      merged:
        sha256.test(saved.merged?.head) && sha256.test(saved.merged?.base)
          ? { head: saved.merged.head, base: saved.merged.base }
          : undefined,
      draft:
        sha256.test(saved.draft?.head) && Number.isSafeInteger(saved.draft?.version)
          ? { head: saved.draft.head, version: saved.draft.version }
          : undefined,
    };
  } catch {
    return undefined;
  }
}
export function rememberConflictPaths(
  root: string,
  laneId: string,
  paths: string[],
  resolveParameters?: ResolveParameters,
  replaceOperation = false,
  originLaneId?: string,
  merged?: { head: string; base: string },
  /** The draft this conflict placed. `restart`: the server put it in this same Lane (b5e8e2d5), so a
   * record of an earlier draft starts over (resolve, resolved, finish), keeping the chain; the same
   * draft's replay keeps it. */
  draft?: ConflictDraft & { restart: boolean },
) {
  const retained = context(root, laneId);
  const prior = draft?.restart && retained && retained.draft?.head !== draft.head ? undefined : retained;
  resolveParameters = (!replaceOperation && prior?.resolveParameters) || resolveParameters;
  // This folder was already a resolution Lane and now resolves it in turn: keep the chain, so a
  // command naming any earlier Lane of it still finds this one.
  const previous = !prior && originLaneId ? context(root) : undefined;
  const earlierOrigins =
    previous && previous.laneId === originLaneId && previous.originLaneId
      ? [...(previous.earlierOrigins ?? []), previous.originLaneId].slice(-8)
      : retained?.earlierOrigins;
  durableReplace(
    pathFor(root),
    JSON.stringify({
      laneId,
      paths,
      resolveParameters,
      resolved: prior?.resolved,
      finishOptions: prior?.finishOptions,
      finishParameters: prior?.finishParameters,
      originLaneId: originLaneId ?? retained?.originLaneId,
      ...(earlierOrigins?.length ? { earlierOrigins } : {}),
      merged: merged ?? prior?.merged,
      draft: draft ? { head: draft.head, version: draft.version } : retained?.draft,
    }),
  );
}
/** The State a Lane's own change is measured from (preflight selection, weakened tests). A resolution
 * Lane a sync made keeps its conflicted Lane's older base, so measured from there all of main since
 * would count as its change (593fc2d7: 582 unrunnable tests, 18 main test edits flagged). While that
 * base is unchanged, it is the head the sync merged in. Local read only. */
export function laneChangeBase(root: string, selection: { laneId: string; base: { head: string } }) {
  const merged = context(root, selection.laneId)?.merged;
  return merged && merged.base === selection.base.head ? merged.head : selection.base.head;
}
/** The original Lane this folder's retained resolution was made for, when known. */
export function inPlaceOrigin(root: string) {
  return context(root)?.originLaneId;
}
/** The resolution Lane this folder became for `originLaneId`, with its retained paths. `chain` also
 * matches an earlier Lane of a chain of in-place resolutions here (b5e8e2d5). */
export function inPlaceResolution(root: string, originLaneId: string, chain = false) {
  const saved = context(root);
  return saved?.originLaneId === originLaneId || (chain && saved?.earlierOrigins?.includes(originLaneId))
    ? { laneId: saved.laneId, paths: saved.paths, resolved: saved.resolved === true }
    : undefined;
}
/** A sync or resolve result of an earlier draft than the one this folder's record holds: a Lane that
 * took a new draft in place (b5e8e2d5) keeps one record, so replaying an older operation never
 * reinstalls, settles or lands that older draft. */
export function earlierDraft(
  root: string,
  source: { lane: { laneId: string; version: number }; resolution: { draftHead: string } | null },
) {
  const draft = context(root, source.lane.laneId)?.draft;
  return (
    !!draft &&
    !!source.resolution &&
    draft.head !== source.resolution.draftHead &&
    draft.version > source.lane.version
  );
}
/** The resolve operation this folder's conflict record names, when retained. */
export function conflictResolveParameters(root: string, laneId: string) {
  return context(root, laneId)?.resolveParameters;
}
/** The folder's current conflict step, said for a reply of an earlier draft (`earlierDraft`). */
export function currentDraftContinuation(root: string, laneId: string) {
  const current =
    resolvedFinishContinuation(root, laneId) ??
    resolutionContinuation(root, laneId, pendingConflictPaths(root, laneId));
  return {
    ...current,
    earlierDraft: true,
    instruction: `This reply is of an earlier conflict draft of Lane ${laneId}; ${root} holds the newer one. ${current.instruction}`,
  };
}
/** Retain the exact finish a completed resolve handed out, with its operationId. */
export function rememberResolutionFinish(root: string, laneId: string, parameters: Record<string, unknown>) {
  const saved = context(root, laneId);
  if (saved)
    durableReplace(pathFor(root), JSON.stringify({ ...saved, resolved: true, finishParameters: parameters }));
}
/** After resolve completed here, the one next step is landing the resolution Lane. */
export function resolvedFinishContinuation(root: string, laneId: string) {
  const saved = context(root, laneId);
  if (!saved?.resolved || !saved.finishParameters) return undefined;
  const parameters = saved.finishParameters;
  const command = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify(parameters))}`;
  return {
    root,
    paths: [] as string[],
    resolved: true,
    next: { action: 'finish', ...parameters },
    command,
    instruction: `The conflict is resolved and saved in Lane ${laneId}. Land it (a replay is safe; it never lands twice): ${command}`,
  };
}
export function rememberConflictFinishOptions(root: string, laneId: string, options: unknown) {
  const saved = context(root, laneId),
    finishOptions = conflictFinishOptions(options);
  if (saved && !saved.finishOptions && finishOptions)
    durableReplace(pathFor(root), JSON.stringify({ ...saved, finishOptions }));
}
export function resolutionFinishOptions(root: string, laneId: string) {
  return context(root, laneId)?.finishOptions;
}
/** Retain the successful operation for immutable conflict-receipt replays, but
 * no longer scan or require resolution for an already installed result. */
export function completeConflictRecovery(root: string) {
  const saved = context(root);
  if (saved) durableReplace(pathFor(root), JSON.stringify({ ...saved, resolved: true }));
}
export function pendingConflictLane(root: string): string | undefined {
  const saved = context(root);
  return saved?.resolved ? undefined : saved?.laneId;
}
export function pendingConflictPaths(root: string, laneId: string): string[] {
  const saved = context(root, laneId);
  return saved?.resolved ? [] : (saved?.paths ?? []);
}
export function resolutionContinuation(
  root: string,
  laneId: string,
  paths: string[],
  operationId?: string,
  reasons: readonly { path: string; reason: string }[] = [],
) {
  const parameters = context(root, laneId)?.resolveParameters ?? {
    laneId,
    ...(operationId ? { operationId } : {}),
  };
  const command = `nforge agent ${shellQuote(root)} resolve ${shellQuote(JSON.stringify(parameters))}`;
  // Syntax conflicts: both sides parse and the line merge did not, so the file needs a
  // real merge even where no hunk overlaps. Say so instead of leaving a marker hunt.
  const why = reasons.length
    ? ` Forge flagged ${reasons.map(item => `${item.path} (${item.reason})`).join('; ')}: merge both sides so the file parses.`
    : '';
  return {
    root,
    paths,
    next: { action: 'resolve', ...parameters },
    command,
    instruction: `Edit ${paths.join(', ')} in ${root} to resolve each conflict hunk, then run: ${command}${why}`,
  };
}
export function requireResolution(root: string, laneId: string, refused: string = 'finish') {
  if (!pendingConflictPaths(root, laneId).length) return;
  const recovery = resolutionContinuation(root, laneId, []);
  // Name what was refused and what resolve does, so a sync or save --sync refusal is no dead end
  // (ad80e037): resolve completes the conflicted sync; it never lands.
  const what = refused === 'finish' ? 'land' : refused === 'sync' ? 'sync (and save --sync)' : refused;
  recovery.instruction = `Complete the edited resolution first (${what} is refused until then): ${recovery.command}. resolve saves the edited files and completes the sync; it does not land, so run land --save after it.`;
  throw new ForgeError('RESOLUTION_REQUIRED', recovery.instruction, undefined, recovery);
}
/** The command follows the edit, never advertises another compose/check as recovery. */
export function assertNoConflictMarkers(
  root: string,
  laneId: string,
  paths: string[],
  resolve = false,
  continuation?: ConflictContinuation,
) {
  if (!paths.length) return;
  const parameters = resolve
    ? (context(root, laneId)?.resolveParameters ?? { laneId })
    : (continuation?.parameters ?? { laneId });
  const next = { action: resolve ? 'resolve' : (continuation?.action ?? 'save'), ...parameters };
  const command = `nforge agent ${shellQuote(root)} ${cliVerb(next.action, parameters)} ${shellQuote(JSON.stringify(parameters))}`;
  const instruction = `Edit ${paths.join(', ')} in ${root} to resolve each conflict hunk, then run: ${command}`;
  throw new ForgeError('CONFLICT_MARKERS', instruction, undefined, {
    root,
    laneId,
    paths,
    next,
    command,
    instruction,
  });
}
/** Generated drafts can match their checkout baseline and bypass ordinary dirty
 * capture. Revisit only their retained conflict paths, with a 64 KiB buffer. */
export function precheckPendingConflicts(root: string, laneId: string) {
  assertNoConflictMarkers(root, laneId, markedPendingPaths(root, laneId), true);
}
/** Retained conflict paths that still hold markers (each scanned with one 64 KiB buffer). */
export function markedPendingPaths(root: string, laneId: string) {
  const paths = pendingConflictPaths(root, laneId);
  const marked: string[] = [],
    scratch = Buffer.allocUnsafe(64 * 1024);
  for (const path of paths) {
    try {
      if (!lstatSync(join(root, path)).isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const reader = new SourceFileReader(root, path, 'SOURCE_CHANGED');
    const scan = conflictMarkerScan();
    try {
      reader.scan(bytes => scanConflictMarkers(scan, bytes), undefined, scratch);
    } finally {
      reader.close();
    }
    if (conflictMarkersFound(scan)) marked.push(path);
  }
  return marked;
}
/** A new landing of the conflicted origin Lane from the folder that became its resolution, after
 * every conflict path was edited free of markers but before resolve ran, would land the origin's
 * pre-resolution head and re-fail the same conflict after a full queue wait (friction 41fc0c29).
 * Refuse locally and name the one resolve command. Unedited markers keep the server path (a
 * main-moved retry can compose cleanly; an abandoned resolution gets a fresh sync). */
export function refuseUnsavedResolution(root: string, originLaneId: string) {
  const here = inPlaceResolution(root, originLaneId);
  if (!here || here.resolved || !here.paths.length || markedPendingPaths(root, here.laneId).length) return;
  requireResolution(root, here.laneId);
}
