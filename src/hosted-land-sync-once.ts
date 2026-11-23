// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { shellQuote } from './shell-quote.js';

type Call = (action: string, body: Record<string, unknown>) => Promise<HostedAgentResponse>;
type Result = {
  code?: string;
  submission?: { id?: string };
  syncRequired?: { laneId?: string };
  instruction?: string;
};
const resultOf = (response: HostedAgentResponse) => (response.result ?? {}) as Result;
type SyncOutcome =
  | { state: 'completed'; status: string | undefined }
  | { state: 'failed'; error: unknown }
  | { state: 'unfinished'; progress: unknown };

/** The sync reply's own outcome. Its apply and conflict guidance wrap the source result as `source`;
 * a sync that outlived its wait (submitted, running or retryable) returns the source progress itself. */
function syncOutcome(response: HostedAgentResponse): SyncOutcome {
  const reply = (response.result ?? {}) as { source?: unknown };
  const value = (reply.source ?? reply) as {
    outcome?: { status?: string; result?: { status?: string }; error?: unknown };
  };
  if (value?.outcome?.status === 'completed')
    return { state: 'completed', status: value.outcome.result?.status };
  if (value?.outcome?.status === 'failed') return { state: 'failed', error: value.outcome.error };
  return { state: 'unfinished', progress: reply };
}

/** A land whose finish rejoined a queued entry main already marked SYNC_REQUIRED (Item 36fd3295):
 * landing the same Lane head again only joins that same entry, so `land --save` looped until the
 * rest of an early-resolution stack landed. Now land syncs
 * main into the Lane once and lands its new head, which supersedes the entry. Never more than one
 * sync per land. Every outcome is a reply land already knows, never a landing to observe:
 * - merged: the new landing (tagged `syncOnce.relanded`);
 * - conflict: COMPOSITION_CONFLICT carrying the sync's own resolve guidance;
 * - unfinished: source work in progress, resumed by replaying that same sync operation;
 * - failed: the sync's failure with a fresh sync to retry;
 * - completed without movement, or the new landing is still the same entry: a capped stop (exit 2)
 *   with the reason instead of land --save again.
 * Returns undefined when not needed. */
export async function syncRequiredOnce(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
  call: Call,
  log: (line: string) => void,
): Promise<HostedAgentResponse | undefined> {
  const first = resultOf(response);
  if (first.code !== 'SYNC_REQUIRED' || !first.submission?.id) return undefined;
  const stale = first.submission.id;
  const laneId =
    first.syncRequired?.laneId ?? (typeof command.laneId === 'string' ? command.laneId : undefined);
  const lane = laneId ? { laneId } : {};
  log(`land: SYNC_REQUIRED on queued entry ${stale}; syncing main into this Lane once, then landing again.`);
  const synced = await call('sync', lane);
  const outcome = syncOutcome(synced);
  const syncOperationId = synced.operationId;
  const syncOnce = { submissionId: stale, ...(syncOperationId ? { syncOperationId } : {}) };
  const sync = (parameters: Record<string, unknown>) => ({
    next: { action: 'sync', ...parameters },
    command: `nforge agent ${shellQuote(root)} save --sync ${shellQuote(JSON.stringify(parameters))}`,
  });
  if (outcome.state === 'unfinished') {
    // Still changing the Lane: resume this exact sync, then land --save (MUST 2, review 73d4db6d).
    const resume = sync({ ...lane, ...(syncOperationId ? { operationId: syncOperationId } : {}) });
    return {
      ...response,
      result: {
        phase: 'sync',
        progress: outcome.progress,
        ...resume,
        nextCommand: resume.command,
        inProgress: true,
        syncOnce: { ...syncOnce, sync: 'unfinished' },
        instruction: `The automatic sync of main into this Lane is still running. Resume it with ${resume.command}, then run land --save.`,
      },
    };
  }
  if (outcome.state === 'failed') {
    const retry = sync(lane);
    return {
      ...response,
      result: {
        phase: 'sync',
        status: 'failed',
        error: outcome.error,
        ...retry,
        nextCommand: retry.command,
        retryCommand: retry.command,
        inProgress: false,
        syncOnce: { ...syncOnce, sync: 'failed' },
        instruction: `The automatic sync of main into this Lane failed. Retry it with ${retry.command}, then run land --save.`,
      },
    };
  }
  if (outcome.status === 'conflict') {
    // The sync placed a resolution: hand over its own guidance as this land's conflict (MUST 1).
    const conflict = (synced.result as { conflict?: unknown } | undefined)?.conflict;
    return {
      ...response,
      result: {
        phase: 'conflict',
        recovery: { conflict },
        inProgress: false,
        syncOnce: { ...syncOnce, sync: 'conflict' },
      },
    };
  }
  if (outcome.status !== 'merged')
    return stop(
      response,
      stale,
      `land synced main into this Lane once (${outcome.status ?? 'unknown'}) and its head did not move, so ` +
        'landing again would rejoin the same queued entry. Not retrying.',
    );
  const { operationId: _previous, ...rest } = command;
  void _previous;
  const relanded = await call('finish', { ...rest, operationId: randomUUID() });
  const again = resultOf(relanded);
  if (again.code === 'SYNC_REQUIRED' && again.submission?.id === stale)
    return stop(
      relanded,
      stale,
      'land synced main in once and landed again, but the landing rejoined the same queued entry. Not retrying.',
    );
  return {
    ...relanded,
    result: { ...(relanded.result as object), syncOnce: { ...syncOnce, sync: 'merged', relanded: true } },
  };
}

type Tagged = { syncOnce?: { stopped?: boolean; relanded?: boolean } } | undefined;
/** True for the capped outcome below; land exits 2 for it. */
export const syncOnceStopped = (response: HostedAgentResponse) =>
  (response.result as Tagged)?.syncOnce?.stopped === true;
/** True for the new landing after the one sync: land announces its operation like any submission. */
export const syncOnceRelanded = (response: HostedAgentResponse) =>
  (response.result as Tagged)?.syncOnce?.relanded === true;
/** The capped outcome: the reason, and no land --save continuation to loop on. */
function stop(response: HostedAgentResponse, submissionId: string, reason: string): HostedAgentResponse {
  const result = resultOf(response);
  const {
    next: _next,
    command: _command,
    nextCommand: _nextCommand,
    ...rest
  } = result as Result & {
    next?: unknown;
    command?: unknown;
    nextCommand?: unknown;
  };
  void _next;
  void _command;
  void _nextCommand;
  return {
    ...response,
    result: {
      ...rest,
      code: 'SYNC_REQUIRED',
      inProgress: false,
      // Final for this land command: it neither waits again nor offers land --save (exit 2).
      terminal: true,
      syncOnce: { submissionId, stopped: true },
      instruction: `SYNC_REQUIRED on queued entry ${submissionId}: ${reason} Read the entry with wait or observe and report it; do not run land --save again for the same head.`,
    },
  };
}
