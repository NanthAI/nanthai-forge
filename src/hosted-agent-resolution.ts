// SPDX-License-Identifier: Apache-2.0
import {
  rememberConflictPaths,
  pendingConflictPaths,
  completeConflictRecovery,
  resolutionContinuation,
  rememberConflictFinishOptions,
  resolutionFinishOptions,
  rememberResolutionFinish,
  resolvedFinishContinuation,
} from './hosted-conflict-precheck.js';
import { shareDependencies, installScriptsNotice } from './shared-dependencies.js';
import { announceRegistryHosts } from './install-registry-hosts.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { randomUUID } from 'node:crypto';
import { conflictFinishOptions } from './hosted-conflict-finish-options.js';
import { UNCHANGED_SIDE, failedCode, unchangedSideRefusal } from './hosted-unchanged-side.js';
import { clientCacheRoot } from './root-paths.js';
import { retainSyncHandoff, clearSyncHandoff } from './hosted-sync-handoff.js';
import { hostedActionError } from './hosted-action-error.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { resolutionFinishSelection } from './hosted-resolution-selection.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { HostedObjectStore } from './hosted-object-store.js';
import { composeConflictPageSchema } from './hosted-compose.js';
import { hostedRecordSchema } from './hosted-records.js';
import { syncResultSchema } from './hosted-sync.js';
import { chainSettle, resolveSyncRequest } from './hosted-resolve-chain.js';
import { syncTiming } from './sync-timing.js';
import { applyObservedSaveOutcome, saveContract, saveHostedLane } from './hosted-save-client.js';
import { driveAgentSource, syncAgentSource } from './hosted-agent-source.js';
import { hostedRootLanePath } from './hosted-root-checkout.js';
import { placeResolution } from './hosted-resolution-placement.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { markerAt, retainedLocalApplyBlocked } from './hosted-apply-recovery-records.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { readSource } from './files.js';
import { safeRelative } from './safe-relative.js';
import { readLaneEntry, recordLane } from './lane-registry.js';
import { sessionAgentSlug } from './agent-slug-session.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
/** Why Forge reports a file the line merge accepted (it no longer parses) or declined (too large). */
export const conflictReasons = (files: readonly { path: string; reason?: string | undefined }[]) =>
  files.flatMap(file => (file.reason ? [{ path: file.path, reason: file.reason }] : []));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function hostedRecoveryCommand(root: string, action: string, command: object) {
  return `nforge agent ${quote(root)} ${action} ${quote(JSON.stringify(command))}`;
}
const completed = (value: unknown) => {
  const parsed = z
    .object({ outcome: z.object({ status: z.string(), result: z.unknown().optional() }) })
    .safeParse(value);
  return parsed.success && parsed.data.outcome.status === 'completed' ? parsed.data.outcome.result : null;
};
/** Conflict metadata is paged; only the affected files are materialized. The
 * response caps paths and inline bytes, never the editable checkout or resolution. */
export async function guideHostedSync(session: HostedAgentSession, value: unknown, apply = true) {
  const parsed = syncResultSchema.safeParse(completed(value));
  if (!parsed.success || parsed.data.status !== 'conflict') return value;
  const source = parsed.data;
  invariant(source.resolution, 'SOURCE_UNAVAILABLE', 'Retain the exact resolution pins.');
  // Recheck current access even when every source object is cached. The same read says
  // whether the resolution Lane already landed or was dropped, so a replay never sends the
  // agent back to resolve settled work.
  const current = hostedLaneSelectionSchema.safeParse(
    parseValue(await session.query('projectHostedLanes:select', { laneId: source.lane.laneId })),
  );
  if (current.success && current.data.state !== 'active')
    return { source: value, conflict: settledResolution(session.root, source, current.data.state) };
  const objects = new HostedObjectStore(
    join(clientCacheRoot(session.root), 'conflict-objects'),
    session.exchange,
  );
  const selection = current.success ? current.data : undefined;
  if (!apply) {
    const { paths, reasons } = await conflictPages(objects, source);
    const root = hostedRootLanePath(session.root, session.address, source.lane.laneId);
    // The open step creates the folder; its client record must exist before then.
    mkdirSync(clientCacheRoot(root), { recursive: true, mode: 0o700 });
    rememberConflictPaths(root, source.lane.laneId, paths);
    rememberConflictFinishOptions(root, source.lane.laneId, session.journal.get('resolution-finish-options'));
    const next = { laneId: source.lane.laneId };
    return {
      source: value,
      conflict: {
        laneId: source.lane.laneId,
        paths: paths.slice(0, 100),
        more: Math.max(0, paths.length - 100),
        ...(reasons.length ? { reasons: reasons.slice(0, 100) } : {}),
        next: { action: 'open', ...next },
        command: hostedRecoveryCommand(session.root, 'open', next),
      },
    };
  }
  // The conflict pages download while the resolution is placed; the placement reuses the Lane
  // read above instead of selecting the same Lane again.
  const listed = conflictPages(objects, source);
  listed.catch(() => {});
  const placed = await placeResolution(session, source, selection);
  const { paths, reasons } = await listed;
  const { root } = placed;
  // The run that resolves owns the resolution Lane's idle listing (d730121f).
  recordLane({ laneId: source.lane.laneId, root, ...session.address, agent: sessionAgentSlug() ?? null });
  const dependencies = await shareDependencies(root, {
    announce: announceRegistryHosts,
  }).catch((error: unknown) => ({
    status: 'failed' as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  const skippedNotice = installScriptsNotice(dependencies);
  if (skippedNotice) process.stderr.write(`${skippedNotice}\n`);
  let remaining = 128 * 1024;
  const files = paths.slice(0, 100).map(path => {
    let bytes: Buffer | null;
    try {
      bytes = readSource(root, path, remaining);
    } catch (error) {
      if (!(error instanceof ForgeError) || error.code !== 'FILE_LIMIT') throw error;
      return { path, content: null };
    }
    if (!bytes) return { path, content: null };
    remaining -= bytes.length;
    try {
      return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { path, content: null };
    }
  });
  const command = { laneId: source.lane.laneId, operationId: await session.journal.id('next-resolve') };
  rememberConflictPaths(
    root,
    source.lane.laneId,
    paths,
    command,
    false,
    'origin' in placed ? placed.origin : undefined,
  );
  rememberConflictFinishOptions(root, source.lane.laneId, session.journal.get('resolution-finish-options'));
  const shown = reasons.slice(0, 100);
  const origin = source.resolution.origin?.laneId;
  return {
    source: value,
    conflict: {
      ...(resolvedFinishContinuation(root, source.lane.laneId) ??
        resolutionContinuation(root, source.lane.laneId, paths.slice(0, 100), command.operationId, shown)),
      laneId: source.lane.laneId,
      head: source.lane.head,
      paths: paths.slice(0, 100),
      more: Math.max(0, paths.length - 100),
      ...(shown.length ? { reasons: shown } : {}),
      files,
      dependencies,
      workIn: placed.workIn,
      ...(placed.kept ? { kept: placed.kept } : {}),
      automatic: {
        summary: placed.inPlace
          ? `This folder now holds resolution Lane ${source.lane.laneId} (main merged into your saved work, conflict markers in the listed files); only those files need edits.`
          : `Opened resolution Lane ${source.lane.laneId} beside the original Lane, with the whole tree; only the listed files need edits.`,
        undo: origin
          ? `Accepted main is unchanged. When this resolution Lane lands, Forge completes the original Lane ${origin} (reopen it to undo); abandon this Lane to keep working in the original instead.`
          : 'The original Lane and accepted main are unchanged; abandon this Lane to keep working in the original instead.',
      },
    },
  };
}
/** Every conflict path of the exact resolution, page by page; reads only the immutable pages. */
async function conflictPages(objects: HostedObjectStore, source: z.infer<typeof syncResultSchema>) {
  const resolution = source.resolution!,
    paths: string[] = [],
    reasons: { path: string; reason: string }[] = [],
    seen = new Set<string>();
  let pin: { sha256: string; size: number } | null = resolution.conflicts;
  while (pin) {
    invariant(!seen.has(pin.sha256), 'SOURCE_HASH_MISMATCH', 'Conflict pages must advance.');
    seen.add(pin.sha256);
    const bytes = await objects.get(pin.sha256);
    invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Conflict page size changed.');
    const page = composeConflictPageSchema.parse(JSON.parse(bytes.toString('utf8')));
    invariant(
      page.left === resolution.left && page.right === resolution.right,
      'SOURCE_HASH_MISMATCH',
      'Conflict pages select different source.',
    );
    for (const file of page.paths) {
      invariant(safeRelative(file.path), 'UNSAFE_PATH', 'Conflict paths must be relative source files.');
      paths.push(file.path);
      reasons.push(...conflictReasons([file]));
    }
    pin = page.next;
  }
  return { paths, reasons };
}
const parseValue = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
/** A replayed recovery whose resolution Lane is no longer active. Completed: its landing
 * (or an explicit complete) settled the conflict, so there is nothing to resolve. Abandoned:
 * the draft was dropped, so the one step is a fresh resolution with a new operation. */
function settledResolution(
  root: string,
  source: z.infer<typeof syncResultSchema>,
  state: 'completed' | 'abandoned',
) {
  const laneId = source.lane.laneId;
  if (state === 'completed')
    return {
      laneId,
      state,
      resolved: true,
      instruction: `This conflict was resolved in Lane ${laneId}, which is completed; nothing is left to do for it.`,
    };
  const candidateId = source.resolution?.candidateId;
  const fresh = candidateId
    ? { candidateId, operationId: randomUUID() }
    : source.from
      ? { laneId: source.from.laneId, operationId: randomUUID() }
      : null;
  if (!fresh)
    return {
      laneId,
      state,
      instruction: `The resolution Lane ${laneId} was abandoned and its original source is unknown.`,
      terminal: true,
    };
  const command = hostedRecoveryCommand(root, 'sync', fresh);
  return {
    laneId,
    state,
    next: { action: 'sync', ...fresh },
    command,
    instruction: `The resolution Lane ${laneId} was abandoned. Start a new resolution with: ${command}`,
  };
}
export async function resolveHostedAgent(session: HostedAgentSession, input: unknown) {
  const command = hostedAgentCommandSchemas.resolve.parse(input),
    marker = markerAt(session.root);
  const parameters = { ...command, operationId: session.journal.operationId };
  const continuation = {
    next: { action: 'resolve', ...parameters },
    command: hostedRecoveryCommand(session.root, 'resolve', parameters),
  };
  if (!marker) {
    const blocked = retainedLocalApplyBlocked(
      session.root,
      session.journal.get<string>('id:sync-handoff-apply'),
    );
    if (blocked) throw blocked;
  }
  if (!marker || (command.laneId && command.laneId !== marker.selection.laneId)) {
    invariant(
      command.laneId,
      'BAD_ARGUMENT',
      `Select the resolution laneId, or run resolve in its returned Lane root; ${session.root} is not a Lane checkout.`,
    );
    const known = readLaneEntry(command.laneId);
    const placed = hostedRootLanePath(session.root, session.address, command.laneId);
    let root =
      placed === session.root ? join(clientCacheRoot(session.root), 'lanes', command.laneId) : placed;
    const matches = (local: ReturnType<typeof markerAt>) =>
      !!local &&
      local.selection.laneId === command.laneId &&
      local.url === session.address.url &&
      local.selection.projectId === session.address.projectId;
    if (known && matches(markerAt(known.root))) root = known.root;
    const validLocal = matches(markerAt(root));
    const next = validLocal
      ? { action: 'resolve', ...command, operationId: session.journal.operationId }
      : { action: 'open', laneId: command.laneId };
    const instruction = validLocal ? `Run resolve in ${root}:` : `Open the resolution Lane in ${root}:`;
    const shell = hostedRecoveryCommand(root, next.action, { ...session.address, ...next });
    throw new ForgeError('HOSTED_CHECKOUT_REQUIRED', `${instruction} ${shell}`, undefined, {
      root,
      next,
      command: shell,
    });
  }
  const conflictPaths = pendingConflictPaths(session.root, marker.selection.laneId);
  if (conflictPaths.length)
    rememberConflictPaths(
      session.root,
      marker.selection.laneId,
      conflictPaths,
      { ...command, operationId: session.journal.operationId },
      true,
    );
  // Phase split in this process (clock reads only), as on sync receipts.
  const timing = syncTiming(),
    saveTiming = syncTiming();
  const saveOperationId = await session.journal.id('resolution-save');
  // The resolve's sync, from the save's result. With save-then-resolve the save carries it and the
  // server starts it when the save completes; the CLI builds the identical request either way.
  // Retained before the save (review 0f10873e R3): a retry after an epoch or lifecycle change
  // still builds both requests from the one `then` the saved request carries.
  const then = await session.journal.retain('resolve-then', async () => ({
    kind: 'resolve' as const,
    operationId: session.journal.operationId,
    authorityEpoch: session.capabilities.authority.epoch,
    lifecycleVersion: marker.selection.lifecycleVersion,
    message: command.message,
    ...(command.keep ? { keep: [...new Set(command.keep)].sort() } : {}),
  }));
  const chain = session.capabilities.features?.includes('save-then-resolve') ?? false;
  // source-run-publish: the save's own action replies with its outcome and, run there, the chain.
  let reply: unknown;
  const save = () =>
    saveHostedLane(
      session.root,
      { operationId: saveOperationId, message: command.message },
      session.exchange,
      { ...saveContract(session.capabilities), ...(chain ? { then } : {}) },
      false,
      { action: 'resolve', parameters: { ...command, operationId: session.journal.operationId } },
      undefined,
      saveTiming,
      value => {
        reply = value;
      },
    );
  let saved = await save();
  let chained: { terminal: unknown; state: unknown } | undefined;
  const direct = chain && completed(saved) && reply ? chainSettle(reply) : undefined;
  if (direct && 'value' in direct) chained = direct.value.chained;
  else if (direct) {
    // The save published in its action but the chained resolve is still running: its receipt
    // arrives on the save's subscription, bounded by the same stall rule.
    const waited = await session.waitSource(
      saveOperationId,
      { status: 'submitted' },
      'Saves',
      undefined,
      undefined,
      chainSettle,
    );
    if (waited && typeof waited === 'object' && 'chained' in waited)
      chained = (waited as { chained: typeof chained }).chained;
    saveTiming.mark('hostedWait');
  }
  if (!completed(saved)) {
    let observed: unknown;
    saved = await session.waitSource(
      saveOperationId,
      saved,
      'Saves',
      undefined,
      value => {
        observed = value;
      },
      chain ? chainSettle : undefined,
    );
    if (saved && typeof saved === 'object' && 'chained' in saved) {
      chained = (saved as { chained: typeof chained }).chained;
      saved = (saved as { save: unknown }).save;
    }
    saveTiming.mark('hostedWait');
    saveTiming.server(observed);
    if (!completed(saved)) return { phase: 'save', saveOperationId, progress: saved, ...continuation };
    // Advance the marker from the original capture and the observed receipt before resolving its
    // exact head, as a plain save does: no replay of the save's preparation.
    applyObservedSaveOutcome(session.root, saveOperationId, saved as { outcome: { status: string } });
    saveTiming.mark('apply');
  }
  timing.nest(saveTiming.value());
  const request = await session.journal.retain('resolve-request', async () =>
    resolveSyncRequest(then, marker.selection.laneId, completed(saved)),
  );
  const handoff = await retainSyncHandoff(session, 'resolve', command);
  timing.mark('save');
  let progress;
  try {
    if (chained) {
      // The server ran the resolve from the save: its receipt arrived on the save's subscription.
      progress = chained.terminal;
      timing.mark('hostedWait');
      timing.server({ state: chained.state });
    } else {
      progress = await driveAgentSource(session, 'Sync', session.journal.operationId, request);
      timing.mark('submit');
      let observed: unknown;
      progress = await session.waitSource(session.journal.operationId, progress, 'Sync', undefined, value => {
        observed = value;
      });
      timing.mark('hostedWait');
      timing.server(observed);
    }
  } catch (error) {
    if (error instanceof ForgeError && error.code === UNCHANGED_SIDE)
      throw unchangedSideRefusal(session.root, marker.selection.laneId, command, error.recovery);
    const safe = hostedActionError(error, 'resolution');
    if (safe.code !== 'HOSTED_ACTION_FAILED' || safe.recovery) throw safe;
    throw new ForgeError(
      safe.code,
      `Resolution outcome is unknown. Continue: ${continuation.command}`,
      undefined,
      {
        root: session.root,
        ...continuation,
      },
    );
  }
  if (failedCode(progress) === UNCHANGED_SIDE)
    throw unchangedSideRefusal(session.root, marker.selection.laneId, command);
  const parsed = syncResultSchema.safeParse(completed(progress));
  if (!parsed.success || parsed.data.status !== 'resolved' || !parsed.data.from)
    return { ...(progress as object), ...continuation };
  const source = parsed.data;
  const applied = await applyHostedSync(
    session.root,
    {
      operationId: handoff.applyOperationId,
      url: session.address.url,
      from: source.from,
      lane: source.lane,
      status: source.status,
    },
    new ConvexLaneTransport(session.exchange),
  );
  clearSyncHandoff(session.root, session.journal.operationId);
  completeConflictRecovery(session.root);
  timing.mark('apply');
  const selection = await resolutionFinishSelection(session, source);
  timing.mark('select');
  if ('pending' in selection)
    return { source: progress, applied, ...selection.pending, ...continuation, timing: timing.value() };
  const options = resolutionFinishOptions(session.root, source.lane.laneId);
  const next = {
    ...options,
    ...selection,
    operationId: await session.journal.id('next-finish'),
    accept: options?.accept ?? true,
  };
  // A later replay of the original Lane's recovery points straight at this landing.
  rememberResolutionFinish(session.root, source.lane.laneId, next);
  return {
    source: progress,
    applied,
    next: { action: 'finish', ...next },
    command: hostedRecoveryCommand(session.root, 'finish', next),
    timing: timing.value(),
  };
}
/** Called only by finish, never by a status/observe read. Original selections and
 * terminal outcomes stay immutable; recovery gets its own retained operation. */
export async function recoverHostedFinish(session: HostedAgentSession, value: unknown) {
  const result = value as { submission?: { id: string; error?: { code: string } | null } };
  if (
    result?.submission?.error?.code !== 'COMPOSITION_CONFLICT' ||
    !session.capabilities.actions.includes('resolve')
  )
    return value;
  const status = await session.query<{ attempt: { candidate: { id: string } } }>(
    'projectHostedLanding:status',
    { submissionId: result.submission.id },
  );
  const candidateId = status.attempt.candidate.id;
  return { ...(value as object), recovery: await recoverHostedCandidate(session, candidateId) };
}
export async function recoverHostedCandidate(session: HostedAgentSession, candidateId: string) {
  // Use the ordinary sync journal: following either the exact continuation or
  // the canonical error's sync instruction resumes this operation. An explicit
  // new operationId still creates an independent draft.
  const command = hostedAgentCommandSchemas.sync.parse({ candidateId });
  const journal = new HostedAgentJournal(
    session.root,
    session.address,
    session.capabilities.actor,
    'sync',
    command,
  );
  const recovery = { ...session, journal };
  const original = session.journal.get<{ command: unknown }>('finish-context')?.command;
  const options = conflictFinishOptions(original);
  if (options) await journal.retain('resolution-finish-options', () => options);
  const operationId = journal.operationId;
  const next = { action: 'sync', ...command, operationId };
  let progress;
  try {
    progress = await syncAgentSource(recovery, command, operationId);
  } catch (error) {
    const safe = hostedActionError(error, 'conflict recovery');
    if (safe.code !== 'HOSTED_ACTION_FAILED') throw safe;
    // The canonical conflict is known even when preparation's reply was lost.
    return {
      operationId,
      phase: 'sync',
      status: 'unknown',
      error: { code: safe.code, message: safe.message },
      next,
      command: hostedRecoveryCommand(session.root, 'sync', next),
    };
  }
  const guided = await guideHostedSync(recovery, progress);
  if (completed(progress)) return { operationId, ...(guided as object) };
  return {
    operationId,
    phase: 'sync',
    source: progress,
    next,
    command: hostedRecoveryCommand(session.root, 'sync', next),
  };
}
/** Read-only advice keeps the current rejected attempt (including batch members),
 * rather than guessing from the original clean submission Candidate. */
export async function hostedConflictAdvice(
  session: Pick<HostedAgentSession, 'root' | 'exchange' | 'query'>,
  value: unknown,
) {
  const result = value as { submission?: { id: string; error?: { code: string } | null } };
  if (
    result?.submission?.error?.code !== 'COMPOSITION_CONFLICT' ||
    (value && typeof value === 'object' && 'recovery' in value)
  )
    return value;
  const status = await session.query<{ attempt: { candidate: { id: string } } }>(
    'projectHostedLanding:status',
    { submissionId: result.submission.id },
  );
  const candidate = hostedRecordSchema.options[3].parse(
    await session.query('projectHostedCompose:candidate', { candidateId: status.attempt.candidate.id }),
  );
  if (candidate.result.status !== 'conflict') return value;
  const objects = new HostedObjectStore(
    join(clientCacheRoot(session.root), 'conflict-objects'),
    session.exchange,
  );
  const page = composeConflictPageSchema.parse(
    JSON.parse((await objects.get(candidate.result.conflicts.sha256)).toString('utf8')),
  );
  const command = { candidateId: candidate.id };
  return {
    ...(value as object),
    conflict: {
      candidateId: candidate.id,
      paths: page.paths.map(file => file.path),
      more: page.next !== null,
      ...(conflictReasons(page.paths).length ? { reasons: conflictReasons(page.paths) } : {}),
      next: { action: 'sync', ...command },
      command: hostedRecoveryCommand(session.root, 'sync', command),
    },
  };
}
