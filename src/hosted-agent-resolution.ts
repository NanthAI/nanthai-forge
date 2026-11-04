// SPDX-License-Identifier: Apache-2.0
import {
  rememberConflictPaths,
  pendingConflictPaths,
  completeConflictRecovery,
  resolutionContinuation,
  rememberConflictFinishOptions,
  resolutionFinishOptions,
} from './hosted-conflict-precheck.js';
import { conflictFinishOptions } from './hosted-conflict-finish-options.js';
import { clientCacheRoot } from './root-paths.js';
import { retainSyncHandoff, clearSyncHandoff } from './hosted-sync-handoff.js';
import { hostedActionError } from './hosted-action-error.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { resolutionFinishSelection } from './hosted-resolution-selection.js';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { HostedObjectStore } from './hosted-object-store.js';
import { composeConflictPageSchema } from './hosted-compose.js';
import { hostedRecordSchema } from './hosted-records.js';
import { saveExpectedSchema, saveResultSchema } from './hosted-save.js';
import { syncRequestSchema, syncResultSchema } from './hosted-sync.js';
import { saveHostedLane } from './hosted-save-client.js';
import { driveAgentSource, syncAgentSource } from './hosted-agent-source.js';
import { openHostedRootLane, hostedRootLanePath } from './hosted-root-checkout.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { markerAt, retainedLocalApplyBlocked } from './hosted-apply-recovery-records.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { readSource } from './files.js';
import { safeRelative } from './safe-relative.js';
import { readLaneEntry, recordLane } from './lane-registry.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
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
  // Recheck current access even when every source object is cached.
  await session.query('projectHostedLanes:select', { laneId: source.lane.laneId });
  const objects = new HostedObjectStore(
    join(clientCacheRoot(session.root), 'conflict-objects'),
    session.exchange,
  );
  const paths: string[] = [],
    seen = new Set<string>();
  let pin: { sha256: string; size: number } | null = source.resolution.conflicts;
  while (pin) {
    invariant(!seen.has(pin.sha256), 'SOURCE_HASH_MISMATCH', 'Conflict pages must advance.');
    seen.add(pin.sha256);
    const bytes = await objects.get(pin.sha256);
    invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Conflict page size changed.');
    const page = composeConflictPageSchema.parse(JSON.parse(bytes.toString('utf8')));
    invariant(
      page.left === source.resolution.left && page.right === source.resolution.right,
      'SOURCE_HASH_MISMATCH',
      'Conflict pages select different source.',
    );
    for (const file of page.paths) {
      invariant(safeRelative(file.path), 'UNSAFE_PATH', 'Conflict paths must be relative source files.');
      paths.push(file.path);
    }
    pin = page.next;
  }
  if (!apply) {
    const root = hostedRootLanePath(session.root, session.address, source.lane.laneId);
    rememberConflictPaths(root, source.lane.laneId, paths);
    rememberConflictFinishOptions(root, source.lane.laneId, session.journal.get('resolution-finish-options'));
    const next = { laneId: source.lane.laneId };
    return {
      source: value,
      conflict: {
        laneId: source.lane.laneId,
        paths: paths.slice(0, 100),
        more: Math.max(0, paths.length - 100),
        next: { action: 'open', ...next },
        command: hostedRecoveryCommand(session.root, 'open', next),
      },
    };
  }
  const opened = await openHostedRootLane(session.root, session.address, session.exchange, {
    operationId: await session.journal.id('conflict-checkout'),
    laneId: source.lane.laneId,
    expected: {
      head: source.lane.head,
      version: source.lane.version,
      sourceVersion: source.lane.sourceVersion,
    },
    paths,
  });
  recordLane({ laneId: source.lane.laneId, root: opened.root, ...session.address });
  let remaining = 128 * 1024;
  const files = paths.slice(0, 100).map(path => {
    let bytes: Buffer | null;
    try {
      bytes = readSource(opened.root, path, remaining);
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
  rememberConflictPaths(opened.root, source.lane.laneId, paths, command);
  rememberConflictFinishOptions(
    opened.root,
    source.lane.laneId,
    session.journal.get('resolution-finish-options'),
  );
  return {
    source: value,
    conflict: {
      ...resolutionContinuation(opened.root, source.lane.laneId, paths.slice(0, 100), command.operationId),
      laneId: source.lane.laneId,
      head: source.lane.head,
      paths: paths.slice(0, 100),
      more: Math.max(0, paths.length - 100),
      files,
      automatic: {
        summary: 'Opened a sibling Lane containing the conflict files.',
        undo: 'The original Lane and accepted main are unchanged; continue in the original Lane to discard this draft.',
      },
    },
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
    let root = join(clientCacheRoot(session.root), 'lanes', command.laneId);
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
  const saveOperationId = await session.journal.id('resolution-save');
  const save = () =>
    saveHostedLane(
      session.root,
      { operationId: saveOperationId, message: command.message },
      session.exchange,
      session.capabilities.overlapEvidenceVersion === 1,
      false,
      { action: 'resolve', parameters: { ...command, operationId: session.journal.operationId } },
    );
  let saved = await save();
  if (!completed(saved)) {
    saved = await session.waitSource(saveOperationId, saved, 'Saves');
    if (!completed(saved)) return { phase: 'save', saveOperationId, progress: saved, ...continuation };
    // Reconcile the marker from the original capture before resolving its exact head.
    saved = await save();
  }
  const request = await session.journal.retain('resolve-request', async () => {
    const lane = saveResultSchema.parse(completed(saved));
    return syncRequestSchema.parse({
      kind: 'resolve',
      operationId: session.journal.operationId,
      authorityEpoch: session.capabilities.authority.epoch,
      laneId: marker.selection.laneId,
      expected: saveExpectedSchema.parse({
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: marker.selection.lifecycleVersion,
      }),
      message: command.message,
    });
  });
  const handoff = await retainSyncHandoff(session, 'resolve', command);
  let progress;
  try {
    progress = await driveAgentSource(session, 'Sync', session.journal.operationId, request);
    progress = await session.waitSource(session.journal.operationId, progress);
  } catch (error) {
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
  const selection = await resolutionFinishSelection(session, source);
  if ('pending' in selection) return { source: progress, applied, ...selection.pending, ...continuation };
  const options = resolutionFinishOptions(session.root, source.lane.laneId);
  const next = {
    ...options,
    ...selection,
    operationId: await session.journal.id('next-finish'),
    accept: options?.accept ?? true,
  };
  return {
    source: progress,
    applied,
    next: { action: 'finish', ...next },
    command: hostedRecoveryCommand(session.root, 'finish', next),
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
      next: { action: 'sync', ...command },
      command: hostedRecoveryCommand(session.root, 'sync', command),
    },
  };
}
