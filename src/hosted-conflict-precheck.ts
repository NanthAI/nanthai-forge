// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { durableReplace } from './native-durability.js';
import { safeRelative } from './safe-relative.js';
import { SourceFileReader } from './source-file-reader.js';
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import { shellQuote } from './agent-brief-render.js';
import { ForgeError } from './errors.js';
import { conflictFinishOptions, type ConflictFinishOptions } from './hosted-conflict-finish-options.js';

const pathFor = (root: string) => join(clientCacheRoot(root), 'conflict-paths.json');
export type ConflictContinuation = {
  action: 'save' | 'finish' | 'resolve';
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
};
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
) {
  const prior = context(root, laneId);
  resolveParameters = (!replaceOperation && prior?.resolveParameters) || resolveParameters;
  durableReplace(
    pathFor(root),
    JSON.stringify({
      laneId,
      paths,
      resolveParameters,
      resolved: prior?.resolved,
      finishOptions: prior?.finishOptions,
      finishParameters: prior?.finishParameters,
      originLaneId: originLaneId ?? prior?.originLaneId,
    }),
  );
}
/** The resolution Lane this folder became for `originLaneId`, with its retained paths. */
export function inPlaceResolution(root: string, originLaneId: string) {
  const saved = context(root);
  return saved?.originLaneId === originLaneId
    ? { laneId: saved.laneId, paths: saved.paths, resolved: saved.resolved === true }
    : undefined;
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
  const command = `nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify(parameters))}`;
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
export function requireResolution(root: string, laneId: string) {
  if (!pendingConflictPaths(root, laneId).length) return;
  const recovery = resolutionContinuation(root, laneId, []);
  recovery.instruction = `Complete the edited resolution before landing: ${recovery.command}`;
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
  const command = `nforge agent ${shellQuote(root)} ${next.action} ${shellQuote(JSON.stringify(parameters))}`;
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
  const paths = pendingConflictPaths(root, laneId);
  if (!paths.length) return;
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
  assertNoConflictMarkers(root, laneId, marked, true);
}
