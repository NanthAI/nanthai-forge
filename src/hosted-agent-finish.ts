// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { LandingReview } from './hosted-landing-hold.js';
import { reconcileSourceRequest } from './hosted-source-request.js';
import { join } from 'node:path';
import { z } from 'zod';
import { landingNote } from './landing-message.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { unadvertisedActionError } from './hosted-agent-version.js';
import { hostedLandingDesiredSchema } from './hosted-landing-desired.js';
import {
  hostedLandingRequestSchema,
  landingHoldMsSchema,
  type HostedLandingState,
} from './hosted-landing.js';
import { sourceWaitSnapshot } from './hosted-agent-source-wait.js';
import { hostedCheckRequestSchema, hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';
import { hostedRecordSchema } from './hosted-records.js';
import { saveContract, saveHostedLane } from './hosted-save-client.js';
import { capturedNotSaved, type NotSaved } from './save-not-saved.js';
import { assertSavedCheckout } from './hosted-save-receipt-state.js';
import { composeAgentSource, composedRevertOf, selectAgentLane } from './hosted-agent-source.js';
import { hostedRecoveryCommand, recoverHostedCandidate } from './hosted-agent-resolution.js';
import { settleCheckOnlyCompose } from './hosted-check-only-compose.js';
import {
  inPlaceResolution,
  preflightBaseRefusal,
  refuseUnsavedResolution,
} from './hosted-conflict-precheck.js';
import {
  agentSourceOutcome,
  checkLogsKey,
  checkSelection,
  landingAdviceKey,
} from './hosted-agent-actions.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import {
  hostedActionError,
  hostedFailureCause,
  hostedFailureCauseOf,
  transientFailureCause,
} from './hosted-action-error.js';
import { shellQuote } from './shell-quote.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import {
  FINISH_REFUSALS,
  finishRefusedKey,
  finishStoppedKey,
  finishTransientKey,
  finishRetryHint,
  type FinishContext,
} from './hosted-agent-finish-identity.js';
import { landWaitCommand } from './hosted-land-wait.js';
import type { QueueProofDetail } from '../scripts/test-queue-proof.mjs';
import { LAND_HELD_MS_ENV, markLandStep, noteLandCompose } from './land-timing.js';
import {
  changedPathsAgainstBase,
  finishChangedPathsKey,
  inspectLaneCheckout,
  nothingToLandError,
  unsavedEditsError,
} from './hosted-finish-guard.js';
import { syncRequiredAdvice, syncRequiredContinuation, type WouldConflict } from './hosted-would-conflict.js';
import type { HostedAgentResponse, HostedAgentSession } from './hosted-agent-transport.js';
import { landedPathCountFeature } from './hosted-contract-features.js';
import {
  AuthorityPinRefused,
  beganAtOlderEpoch,
  BeganAtOlderEpoch,
  MAIN_PIN_TRIES,
  MainPinRefused,
  authorityCode,
  authorityPinRefusal,
  mainPinRefusal,
  olderEpochRefusal,
} from './hosted-main-pin.js';
import { hostedRunSubscription } from './hosted-agent-observe.js';
import { makeFunctionReference } from 'convex/server';

const finishNotSavedKey = 'finish-not-saved';

type FinishCommand = z.infer<typeof hostedAgentCommandSchemas.finish>;
type LandingSubmitReply = HostedLandingState & { changedPaths?: number | null };

function finishSubmission({ changedPaths, ...submission }: LandingSubmitReply) {
  return { submission, ...(changedPaths === undefined ? {} : { changedPaths }) };
}

const landedCountArg = (session: HostedAgentSession) =>
  session.capabilities.features?.includes(landedPathCountFeature) ? { landedPathCount: 1 } : {};

/** Enqueue a landing request. A moved main refuses it inside the transaction that would begin it, so
 * nothing began: its Candidate composed on a main that has since moved, and resending it can never
 * succeed (b8c0a4f6). Unless the caller pinned that Candidate, drop the request and this finish's
 * compose, so the next pass composes again on the current main under a new compose operation (the
 * old Candidate stays, unlanded), and report MainPinRefused. */
/** The retained land gate result (feature land-gates, Issue 029138ef), outside the request like
 * `agent`; a replay sends the same one. */
const landGatesArg = (session: HostedAgentSession) => {
  const gates = session.journal.get<string | null>('finish-gates');
  return gates ? { gates } : {};
};
/** The agent's reported tokens (feature landing-tokens, Item a61d3c91), outside the request like `gates`; a replay
 * sends the same. */
const tokensArg = (session: HostedAgentSession) => {
  const tokens = session.landingTokens ? session.journal.get<number>('finish-tokens') : undefined;
  return typeof tokens === 'number' ? { tokens } : {};
};
const clientHoldArg = (session: HostedAgentSession) => {
  if (!session.capabilities.features?.includes('landing-client-hold')) return {};
  const heldMs = session.journal.get<number>('finish-held-ms');
  return heldMs === undefined ? {} : { heldMs };
};
async function retainLandGates(session: HostedAgentSession, composeOperationId: string) {
  if (session.landGates)
    await session.journal.retain('finish-gates', async () => session.landGates!(composeOperationId) ?? null);
}
/** The new finish an older-epoch refusal names (N3): the same command without its compose
 * operation, which can never finish at the new epoch, so the new finish composes again. */
function freshFinish<T extends { composeOperationId?: string | undefined }>(command: T) {
  const { composeOperationId: _never, ...fresh } = command;
  void _never;
  return fresh;
}

/** Forget this finish's compose and the request built on it, so the next pass composes again under a
 * new compose operation (the old Candidate stays, unlanded). */
function forgetFinishSource(session: HostedAgentSession, request: string) {
  const composeOperationId =
    session.journal.get<string>('finish-compose-operation') ?? session.journal.get<string>('id:compose');
  for (const key of [
    request,
    'finish-compose-operation',
    'id:compose',
    ...(composeOperationId ? [`compose:${composeOperationId}`] : []),
  ])
    session.journal.forget(key);
}
/** N3, refused before it began: the server checks a landing request's (or desired landing's) epoch
 * only for one it has not seen, so a refusal of an older epoch than this command's began nothing. */
const olderEpochPin = (session: HostedAgentSession, error: unknown, request: unknown) =>
  authorityPinRefusal(error, 'finish') &&
  (request as { authorityEpoch?: number }).authorityEpoch !== session.capabilities.authority.epoch;
/** `land {maxChecks:N}` (ad80e037), retained with the operation so a replay keeps it. */
const whenRoomKey = 'finish-when-checks-below';
/** finishRefusedKey values for a land refused over maxChecks before it submitted (selection reads them). */
const NO_QUEUE_ROOM = 'NO_QUEUE_ROOM',
  MAX_CHECKS_UNSUPPORTED = 'MAX_CHECKS_UNSUPPORTED';
const roomSchema = z.object({ checks: z.number(), groups: z.number(), preparing: z.number() });
/**
 * Submit with the land's queue-room condition. The server admits the submission only while the
 * queue holds fewer than N checks, judged in the submitting mutation (convex/projectHostedQueueRoom.ts),
 * so a builder's queue read and its submit cannot race past a project's check cap. Refused for room
 * (WORK_BUSY, nothing written), the land subscribes to the queue's room query: the server re-runs it
 * only when the queue's order, phases or holds change and pushes the count, so a waiting land wakes
 * when a check ends, with no polling and no 240 s loop. It submits again on room; past the command's
 * wait budget it refuses with the replay that keeps waiting. A WORK_BUSY while the count already
 * showed room twice running is some other refusal, reported as it came.
 */
const unmark = (session: HostedAgentSession) => {
  if (session.journal.get(finishRefusedKey) !== undefined) session.journal.forget(finishRefusedKey);
};
async function submitWhenRoom<T>(
  session: HostedAgentSession,
  submit: (room: { maxChecks?: number }) => Promise<T>,
  waited?: () => void,
): Promise<T> {
  // From a submit attempt on, this operation may run on the server (a lost reply, a crash): no
  // earlier pre-submit refusal mark survives it, so new source is never a second landing. Only a
  // refusal the server just answered marks it again.
  unmark(session);
  const limit = session.journal.get<number | null>(whenRoomKey) ?? undefined;
  if (limit === undefined) return submit({});
  const refused = async (mark: string) => {
    unmark(session);
    await session.journal.retain(finishRefusedKey, () => mark);
  };
  for (let open = 0; ;) {
    try {
      return await submit({ maxChecks: limit });
    } catch (error) {
      const code = hostedActionError(error, 'finish').code;
      // The server's switch is off: refused before anything was written.
      if (code === 'HOSTED_ACTION_UNSUPPORTED') await refused(MAX_CHECKS_UNSUPPORTED);
      if (code !== 'WORK_BUSY') throw error;
      // Nothing was submitted: new source or another maxChecks is new work, not this replay.
      await refused(NO_QUEUE_ROOM);
      const room = await waitForQueueRoom(session, limit);
      if (!room.immediate) waited?.();
      open = room.immediate ? open + 1 : 0;
      if (open > 1) throw error;
      unmark(session);
    }
  }
}
async function waitForQueueRoom(session: HostedAgentSession, limit: number) {
  const refuse = (checks: number | undefined) =>
    new ForgeError(
      'WORK_BUSY',
      `No queue room within this command's wait: ${checks ?? `at least ${limit}`} checks are running or waiting, so maxChecks ${limit} admits no more. Nothing was submitted. Replay the same land command (same operationId) to keep waiting; it wakes when a check ends. Landing with another maxChecks, without it, or on new saved source is new work.`,
    );
  const cancelled = () =>
    new ForgeError(
      'CANCELLED',
      `Cancelled while waiting for queue room (maxChecks ${limit}). Nothing was submitted. Replay the same land command (same operationId) to keep waiting.`,
    );
  const signal = session.signal;
  if (signal?.aborted) throw cancelled();
  const remaining = session.waitUntil - Date.now();
  if (remaining <= 0) throw refuse(undefined);
  const client = hostedRunSubscription(session.address);
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    const room = await new Promise<{ immediate: boolean; checks: number }>((resolve, reject) => {
      let first = true,
        last: number | undefined;
      stop = () => reject(cancelled());
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => reject(refuse(last)), remaining);
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedQueueRoom:room'),
        { projectId: session.address.projectId, limit },
        value => {
          try {
            const room = roomSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
            last = room.checks;
            if (room.checks < limit) resolve({ immediate: first, checks: room.checks });
            first = false;
          } catch (error) {
            reject(error);
          }
        },
        error => reject(hostedActionError(error, 'finish')),
      );
    });
    // Room showed as the command was cancelled: never submit after a cancel.
    if (signal?.aborted) throw cancelled();
    return room;
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}
class RoomMainPinRefused extends MainPinRefused {}

async function enqueueLanding(session: HostedAgentSession, request: unknown, pinnedCandidate: boolean) {
  let waited = false;
  try {
    return await submitWhenRoom(
      session,
      room =>
        session.mutation<LandingSubmitReply>('projectHostedLanding:enqueue', {
          request: canonicalPayload({ ...(request as object), governanceVersion: 1 }),
          ...(session.landingAgent ? { agent: session.landingAgent } : {}),
          ...(session.landingClient ? { agentClient: session.landingClient } : {}),
          ...landGatesArg(session),
          ...tokensArg(session),
          ...clientHoldArg(session),
          ...landedCountArg(session),
          ...room,
        }),
      () => {
        waited = true;
      },
    );
  } catch (error) {
    // An older epoch: the request rebuilds at this command's epoch; one this finish composed is
    // composed again first, so the landing and its Candidate share an epoch (a named one is kept).
    if (olderEpochPin(session, error, request)) {
      if (pinnedCandidate) session.journal.forget('finish-request');
      else forgetFinishSource(session, 'finish-request');
      throw new AuthorityPinRefused(error);
    }
    if (pinnedCandidate || !mainPinRefusal(error, 'finish')) throw error;
    forgetFinishSource(session, 'finish-request');
    throw waited ? new RoomMainPinRefused(error) : new MainPinRefused(error);
  }
}

/** A check-only finish's check request, as enqueueLanding's landing request: the server checks its
 * epoch only for a new operation, so one refused at an older epoch began nothing. It is dropped and
 * this finish composes again at the current epoch (N3). */
async function enqueueCheck(session: HostedAgentSession, request: unknown, pinnedCandidate: boolean) {
  try {
    return await session.mutation<HostedCheckRun>('projectHostedChecks:enqueue', {
      request: canonicalPayload(request),
    });
  } catch (error) {
    if (!olderEpochPin(session, error, request)) throw error;
    if (pinnedCandidate) session.journal.forget('finish-request');
    else forgetFinishSource(session, 'finish-request');
    throw new AuthorityPinRefused(error);
  }
}

async function replayFinish(session: HostedAgentSession, pinnedCandidate: boolean, command: FinishCommand) {
  const composeOperationId =
    session.journal.get<string>('finish-compose-operation') ?? session.journal.get<string>('id:compose');
  const desired = session.journal.get<{ authorityEpoch: number }>('desired-landing');
  if (desired) {
    let submission: LandingSubmitReply;
    try {
      submission = await submitWhenRoom(session, room =>
        session.mutation<LandingSubmitReply>('projectHostedLandingDesired:submit', {
          request: canonicalPayload(desired),
          ...(session.landingAgent ? { agent: session.landingAgent } : {}),
          ...(session.landingClient ? { agentClient: session.landingClient } : {}),
          ...landGatesArg(session),
          ...tokensArg(session),
          ...clientHoldArg(session),
          ...landedCountArg(session),
          ...room,
        }),
      );
    } catch (error) {
      if (!olderEpochPin(session, error, desired)) throw error;
      // Never began, and its compose shares its older epoch: this pass composes again (N3).
      forgetFinishSource(session, 'desired-landing');
      return null;
    }
    // Began at an older epoch: a desired landing still composing can never be admitted (its compose
    // and enqueue are refused), and the cutover drained every queued one. Name a new finish (N3).
    const epoch = session.capabilities.authority.epoch;
    if (
      desired.authorityEpoch !== epoch &&
      (submission.phase === 'composing' ||
        (submission.phase === 'terminal-failed' && authorityCode(submission.error?.code)))
    )
      throw olderEpochRefusal(
        session.root,
        'SOURCE_AUTHORITY_CHANGED',
        'This landing',
        desired.authorityEpoch,
        epoch,
        { action: 'finish', parameters: freshFinish(command) },
      );
    // Only a still-preparing submission needs source recovery. Terminal replay
    // remains discovery plus the original admission, without probing old jobs.
    let progress: unknown;
    if (submission.observation.state === 'pending' && submission.phase === 'composing') {
      const observed = await session.query<{ status?: string }>('projectHostedCompose:progress', {
        operationId: composeOperationId,
      });
      progress =
        observed.status === 'retryable'
          ? await reconcileSourceRequest(
              composeOperationId!,
              () => session.mutation('projectHostedComposeJobs:submit', { operationId: composeOperationId }),
              () =>
                session.waitSource(
                  composeOperationId!,
                  observed,
                  'Compose',
                  Math.max(0, (session.waitUntil - Date.now()) / 1000),
                ),
            )
          : observed.status
            ? sourceWaitSnapshot(observed)
            : undefined;
    }
    return {
      phase: 'finish',
      composeOperationId,
      ...(progress === undefined ? {} : { progress }),
      ...finishSubmission(submission),
      ...(await queuedConflict(session, submission)),
    };
  }
  const request = session.journal.get<Record<string, unknown>>('finish-request');
  if (!request) return null;
  if (!request.channel) {
    let run: HostedCheckRun;
    try {
      run = await enqueueCheck(session, request, pinnedCandidate);
    } catch (error) {
      // The retained check request was older than this epoch and is dropped: compose again.
      if (error instanceof AuthorityPinRefused) return null;
      throw error;
    }
    // Began at an older epoch: after the cutover every runner write to this run is refused, so a
    // still-running one never ends, and a wait on it would never return. Name a new finish (N3).
    const began = (request as { authorityEpoch?: number }).authorityEpoch,
      epoch = session.capabilities.authority.epoch;
    if (beganAtOlderEpoch(began, epoch, hostedCheckTerminal(run)))
      throw olderEpochRefusal(
        session.root,
        'SOURCE_AUTHORITY_CHANGED',
        "This finish's check",
        began!,
        epoch,
        {
          action: 'finish',
          parameters: freshFinish(command),
        },
      );
    await session.journal.retain('finish-check-run', () => run);
    return { phase: 'check', composeOperationId, run };
  }
  let submission: LandingSubmitReply;
  try {
    submission = await enqueueLanding(session, request, pinnedCandidate);
  } catch (error) {
    // A stale pin after a room wait goes through the command budget check on replays too.
    if (error instanceof RoomMainPinRefused) throw error;
    // The retained request was stale and is dropped: this pass composes on the current main and epoch.
    if (error instanceof MainPinRefused || error instanceof AuthorityPinRefused) return null;
    throw error;
  }
  return {
    phase: 'finish',
    composeOperationId,
    ...finishSubmission(submission),
    ...(await queuedConflict(session, submission)),
  };
}

/** A replay of a queued, not-yet-checked landing reports when main has since changed its files. */
export async function queuedConflict(session: HostedAgentSession, submission: HostedLandingState) {
  if (submission.phase !== 'queued') return {};
  try {
    const read = await session.query<{
      request: HostedLandingState;
      approver?: LandingReview['approver'];
      url?: LandingReview['url'];
      queuePosition?: number | null;
      queue?: unknown;
      queueAheadSelection?: unknown;
      wouldConflict?: WouldConflict;
    }>('projectHostedLanding:status', { submissionId: submission.id });
    const { wouldConflict } = read;
    // The read can settle the submission while enqueue's reply is in flight.
    // Never combine its newer metadata with the older admission snapshot.
    const current = {
      submission: {
        ...(read.request ?? submission),
        ...(read.approver ? { approver: read.approver } : {}),
        ...(read.url ? { url: read.url } : {}),
      },
      queuePosition: read.queuePosition,
      ...(read.queue ? { queue: read.queue } : {}),
      ...(read.queueAheadSelection ? { queueAheadSelection: read.queueAheadSelection } : {}),
    };
    if (!wouldConflict || current.submission.phase !== 'queued') return current;
    // Main already took files this entry changes: waiting does not land it. Name the one recovery,
    // the same Lane's land --save, which supersedes this entry (f7539ebb).
    const sync = syncRequiredAdvice(wouldConflict, current.submission);
    if (sync)
      return {
        ...current,
        wouldConflict,
        ...syncRequiredContinuation(session.root, sync),
      };
    // An optional predecessor decision leaves the live submission pending. Follow its canonical
    // wait; the reply still exposes the exact conflict and optional pinned sync.
    const parameters = { operationIds: [current.submission.operationId] };
    const command = `nforge agent ${shellQuote(session.root)} wait ${shellQuote(JSON.stringify(parameters))}`;
    return {
      ...current,
      wouldConflict,
      next: { action: 'wait', ...parameters },
      command,
      nextCommand: command,
    };
  } catch {
    return {}; /* Advisory read; the replay result stands. */
  }
}

async function reuseCheckedFinish(session: HostedAgentSession, command: FinishCommand) {
  const prior = session.journal.get<FinishContext>('finish-context')?.previous;
  if (!prior || prior.command.accept !== false || command.accept === false) return null;
  const journal = readAgentJson(join(hostedAgentDirectory(session.root), `${prior.operationId}.json`)) as {
    values: Record<string, unknown>;
  };
  const request = journal.values['finish-request'] as z.infer<typeof hostedCheckRequestSchema> | undefined;
  const run = journal.values['finish-check-run'] as { id: string } | undefined;
  const composeOperationId = journal.values['finish-compose-operation'] ?? journal.values['id:compose'];
  if (!request || !run || typeof composeOperationId !== 'string') return null;
  const checked = await session.query<{ status: string }>('projectHostedCheckRead:status', { runId: run.id });
  if (checked.status !== 'passed') return null;
  const current = await checkSelection(
    session,
    command.check,
    undefined,
    session.capabilities.features?.includes('checkless-landing'),
  );
  if (
    !current ||
    request.checkId !== current.checkId ||
    request.expectedDefinition !== current.expectedDefinition ||
    request.expectedConfiguration !== current.expectedConfiguration ||
    request.expectedEnvironment !== current.expectedEnvironment
  )
    return null;
  const candidate = hostedRecordSchema.options[3].parse(
    await session.query('projectHostedCompose:candidate', { candidateId: request.candidateId }),
  );
  const main = await session.main();
  if (candidate.base.head !== main.head || candidate.base.receiptId !== main.receipt.id) return null;
  return { candidateId: candidate.id, composeOperationId, check: { kind: 'run' as const, runId: run.id } };
}

function staleBeforeCompose(session: HostedAgentSession, error: unknown) {
  const compose = session.journal.get<string>('finish-compose-operation');
  return (
    hostedActionError(error, 'finish').code === 'WORK_STALE' &&
    !session.journal.get('finish-check-run') &&
    session.journal.get('finish-request') === undefined &&
    session.journal.get('desired-landing') === undefined &&
    (!compose || session.journal.get(`compose:${compose}`) === undefined)
  );
}

/** Every stop before submission keeps its code in the journal, so extra land runs can be counted by
 * cause (friction, Item 168e4ed8); a transient hosted failure also marks the operation resumable. */
async function recordFinishStop(session: HostedAgentSession, error: unknown) {
  if (submittedFinish(session)) return;
  const safe = hostedActionError(error, 'finish');
  // retain() never overwrites: each stop replaces the last one's markers, so a resumed run that
  // then stops for good is never resumed again.
  session.journal.forget(finishStoppedKey);
  session.journal.forget(finishTransientKey);
  if (session.journal.get(finishRefusedKey) === 'PREFLIGHT_BUDGET_EXCEEDED')
    session.journal.forget(finishRefusedKey);
  const localPreflight = safe.recovery?.localPreflight;
  await session.journal.retain(finishStoppedKey, () =>
    localPreflight ? { code: safe.code, localPreflight } : safe.code,
  );
  // An already coded failure names its cause in its message (Item 3f76a3df).
  const cause = hostedFailureCauseOf(safe.message) ?? hostedFailureCause(error);
  if (safe.code === 'HOSTED_ACTION_FAILED' && transientFailureCause(cause))
    await session.journal.retain(finishTransientKey, () => cause);
}
/** The code a pre-submit refusal ends its operation with: WORK_STALE whenever the cheap pass named
 * stale pins among several, so the next land never replays those pins (593fc2d7). */
function refusedCode(error: unknown, code: unknown) {
  const refusals = (error as { recovery?: { refusals?: { code?: unknown }[] } }).recovery?.refusals;
  return Array.isArray(refusals) && refusals.some(refusal => refusal?.code === 'WORK_STALE')
    ? 'WORK_STALE'
    : code;
}
const submittedFinish = (session: HostedAgentSession) =>
  session.journal.get('desired-landing') !== undefined ||
  session.journal.get('finish-request') !== undefined ||
  session.journal.get('finish-check-run') !== undefined;

export async function executeHostedFinish(session: HostedAgentSession, input: unknown) {
  let result: unknown;
  for (let tries = 1; ;)
    try {
      result = await executeFinishWork(session, input);
      break;
    } catch (error) {
      // Main moved, or the epoch rose, before the landing began: the stale request is dropped, compose
      // again (b8c0a4f6, N3).
      if (error instanceof RoomMainPinRefused) {
        // A check can move main while this request waits for admission. Refresh its Candidate
        // within the existing command budget and keep the ordinary pin-race attempts for fresh pins.
        if (Date.now() < session.waitUntil) continue;
        throw new ForgeError(
          'CHANNEL_CHANGED',
          'Main moved while this landing waited for queue room. Nothing began. Replay the same operation to compose on current main.',
        );
      }
      if (error instanceof MainPinRefused || error instanceof AuthorityPinRefused) {
        if (tries < MAIN_PIN_TRIES) {
          tries++;
          continue;
        }
        throw new ForgeError(
          'CHANNEL_CHANGED',
          `Main moved during each of ${tries} tries to land on its current head. Nothing began, and the stale request was dropped: a replay of this same operation composes on the new main.`,
        );
      }
      await recordFinishStop(session, error);
      // Ended before anything was submitted: a re-run on new source is new work, not a replay (ac13de6b).
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && FINISH_REFUSALS.has(code))
        await session.journal.retain(finishRefusedKey, () => refusedCode(error, code));
      // Lane pins moved before any compose request was built: this operation can only replay the
      // stale pins, so the next shorthand land is new work on the folder's pins (593fc2d7).
      else if (staleBeforeCompose(session, error))
        await session.journal.retain(finishRefusedKey, () => 'WORK_STALE');
      if (
        error instanceof ForgeError &&
        (code === 'PREFLIGHT_REQUIRED' || code === 'PREFLIGHT_BUDGET_EXCEEDED')
      ) {
        const parameters: Record<string, unknown> = {
          ...(input as Record<string, unknown>),
          operationId: session.journal.operationId,
        };
        // The message travels once, in replay.parameters: a replay by this id without a message reuses
        // the retained one (friction 54584edf), so the printed command stays short.
        const { message: _message, ...short } = parameters;
        void _message;
        const replayCommand = `nforge agent ${shellQuote(session.root)} land --save ${shellQuote(JSON.stringify(short))}`;
        throw new ForgeError(
          error.code,
          `${error.message} Source is pinned to operation ${session.journal.operationId}. If source is unchanged, replay: ${replayCommand} (it keeps this operation's message). If you edit or save different source after this pre-submit refusal, run land --save with the same options and a fresh operationId; replaying this id keeps the original source pins.`,
          undefined,
          {
            ...(code === 'PREFLIGHT_BUDGET_EXCEEDED' ? { command: replayCommand } : {}),
            ...error.recovery,
            operationId: session.journal.operationId,
            replayCommand,
            replay: { action: 'finish', parameters },
          },
        );
      }
      throw error;
    }
  const context = session.journal.get<FinishContext>('finish-context');
  const { localPreflight, ...defaults } =
    session.journal.get<Record<string, unknown>>('finish-defaults') ?? {};
  const observed = result as
    | { changedPaths?: number | null; submission?: Pick<HostedLandingState, 'phase'> }
    | null
    | undefined;
  const acceptedPaths = observed?.changedPaths;
  const changedPaths =
    acceptedPaths === undefined && observed?.submission?.phase !== 'landed'
      ? session.journal.get<number | null>(finishChangedPathsKey)
      : acceptedPaths;
  const notSaved = session.journal.get<NotSaved>(finishNotSavedKey);
  // Retained by the check selection (no extra read): the runner's logs are public.
  const checkLogs = session.journal.get<string>(checkLogsKey);
  // Mode observed at check selection, its effective state and any pause/next step.
  const landingAdvice = session.journal.get<string>(landingAdviceKey);
  const receipt = {
    ...(result as Record<string, unknown>),
    ...(checkLogs ? { checkLogs } : {}),
    ...(landingAdvice ? { landingAdvice } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    ...(localPreflight ? { localPreflight } : {}),
    ...(notSaved ? { notSaved } : {}),
    // Pending replies may have a Lane estimate. Settled landings only use accepted evidence.
    ...(changedPaths === undefined ? {} : { changedPaths }),
  };
  // One wake-driven command that resumes a long queue; absent once the outcome is final.
  const waitCommand = landWaitCommand(session.root, {
    operationId: session.journal.operationId,
    result: receipt,
  } as HostedAgentResponse);
  return finishRetryHint(session.root, hostedAgentCommandSchemas.finish.parse(context?.command ?? input), {
    ...receipt,
    ...(waitCommand ? { waitCommand } : {}),
    replayParameters: {
      ...hostedAgentCommandSchemas.finish.parse(context?.command ?? input),
      operationId: session.journal.operationId,
    },
  });
}

/** A stacked Lane whose parent's landing already failed would only queue a landing that fails with
 * DEPENDENCY_NOT_LANDED (and dropping the wait would land the parent's failed changes). Its next sync
 * re-pins it to main, taking the parent's changes out (D2, Issue 1eb42254): say so before submitting.
 * One status read, only for a Lane stacked on a landing. */
export async function refuseFailedStackParent(session: HostedAgentSession, laneId: string, entryId: string) {
  let parent: { phase?: string; error?: { code?: string } | null } | undefined;
  try {
    parent = (
      await session.query<{ request?: { phase?: string; error?: { code?: string } | null } }>(
        'projectHostedLanding:status',
        { submissionId: entryId },
      )
    ).request;
  } catch {
    return; // Unknown: the landing's own dependency wait still decides.
  }
  if (parent?.phase !== 'terminal-failed') return;
  const sync = { laneId };
  throw new ForgeError(
    'STACK_PARENT_FAILED',
    `This Lane is stacked on submission ${entryId}, which did not land (${parent.error?.code ?? 'failed'}). Re-pin onto main first: sync takes the parent's changes out and keeps yours, then land --save again; that landing checks once.`,
    undefined,
    {
      next: { action: 'sync', ...sync },
      command: `nforge agent ${shellQuote(session.root)} save --sync ${shellQuote(JSON.stringify(sync))}`,
    },
  );
}
async function executeFinishWork(session: HostedAgentSession, input: unknown) {
  const operationId = session.journal.operationId,
    epoch = session.capabilities.authority.epoch;
  const context = session.journal.get<FinishContext>('finish-context');
  const parameters = context?.command ?? (input as Record<string, unknown>);
  const command = hostedAgentCommandSchemas.finish.parse(parameters);
  const allowUnchecked =
    command.accept !== false && session.capabilities.features?.includes('checkless-landing');
  // No early settings read for ordinary landings. When a proof is flagged, reuse the
  // selection at submission so projects with custom checks still read it just once.
  let selectedCheck: ReturnType<typeof checkSelection> | undefined;
  let beforeCompose: ((mainHead: string) => Promise<void>) | undefined;
  // A Candidate the caller named is its pin; one this finish composed is rebuilt when main moves.
  const pinnedCandidate = command.candidateId !== undefined;
  if (command.tokens !== undefined && session.landingTokens)
    await session.journal.retain('finish-tokens', async () => command.tokens!);
  if (command.accept !== false && session.capabilities.features?.includes('landing-client-hold')) {
    const measured = landingHoldMsSchema.safeParse(Number(process.env[LAND_HELD_MS_ENV] || undefined));
    if (measured.success) await session.journal.retain('finish-held-ms', () => measured.data);
  }
  // First run only (the condition is not yet retained): a replay of an admitted landing is never
  // told "nothing was submitted" by an older server.
  if (
    command.maxChecks !== undefined &&
    !session.landWhenRoom &&
    session.journal.get(whenRoomKey) === undefined
  ) {
    await session.journal.retain(finishRefusedKey, () => MAX_CHECKS_UNSUPPORTED);
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server does not take maxChecks yet. Nothing was submitted; land without it.',
    );
  }
  // First run only: a replay keeps the condition its operation began with.
  await session.journal.retain(whenRoomKey, async () => command.maxChecks ?? null);
  const replayed = await replayFinish(session, pinnedCandidate, command);
  if (replayed) return replayed;
  const declaration = command.notVerified === undefined ? {} : { notVerified: command.notVerified };
  if (command.notVerified !== undefined && !session.capabilities.features?.includes('save-declarations'))
    throw unadvertisedActionError('land --save notVerified');
  // A new landing of the origin Lane after an edited, unsaved in-place resolution: refuse before
  // any hosted call (41fc0c29). An operation that already ran keeps following its own recovery.
  if (
    session.journal.get('finish-work-started') === undefined &&
    command.laneId &&
    !command.candidateId &&
    !command.inputs &&
    session.marker()?.selection.laneId !== command.laneId
  ) {
    try {
      refuseUnsavedResolution(session.root, command.laneId);
    } catch (error) {
      // Nothing hosted ran for this id: the same id may land the resolution Lane (3f60d17a).
      session.journal.release('finish-work-started');
      throw error;
    }
  }
  await session.journal.retain('finish-work-started', () => true);
  const checked = await reuseCheckedFinish(session, command);
  if (checked) {
    command.candidateId = checked.candidateId;
    command.composeOperationId = checked.composeOperationId;
  }
  // The server Lane this pass read before any save: a clean land compares its pins at no extra call.
  let serverLane: Awaited<ReturnType<typeof selectAgentLane>> | undefined;
  if (!command.after && !command.candidateId && !command.inputs)
    command.after = await session.journal.retain('stack-parent-entry', async () => {
      const selected = (serverLane = await selectAgentLane(session, command.laneId));
      if (selected.earlyResolution) return null; // The exact predicted-head pipeline owns its acceptance fence.
      const entryId = selected.stack && !selected.stack.detached ? (selected.stack.entryId ?? null) : null;
      if (entryId) await refuseFailedStackParent(session, selected.laneId, entryId);
      return entryId;
    });
  const marker = session.marker();
  const resolvedHere =
    command.laneId &&
    !command.candidateId &&
    !command.inputs &&
    marker &&
    marker.selection.laneId !== command.laneId
      ? inPlaceResolution(session.root, command.laneId)
      : undefined;
  if (resolvedHere) {
    // This folder became the named Lane's resolution, so that Lane has no checkout here: land its
    // saved head exactly, as its own folder's unchanged save did. A replay reaches the same
    // Candidate and its one resolution; if main moved so it composes cleanly, it lands as before.
    const lane = await selectAgentLane(session, command.laneId);
    // Settled (the resolution's landing completed it): report that, never land its old head again.
    if (lane.state !== 'active')
      return {
        phase: 'conflict',
        recovery: {
          conflict: {
            laneId: resolvedHere.laneId,
            state: lane.state,
            resolved: lane.state === 'completed',
            instruction: `Lane ${lane.laneId} is ${lane.state}; this folder holds its resolution Lane ${resolvedHere.laneId}.`,
          },
        },
      };
    // Resolved here already: the resolution Lane carries the work, and the origin's head is the
    // pre-resolution save that conflicts again (7351b8d7). Land the resolution Lane's head.
    const carrier = resolvedHere.resolved ? await selectAgentLane(session, resolvedHere.laneId) : lane;
    command.inputs = [
      {
        laneId: carrier.laneId,
        expected: {
          head: carrier.head,
          version: carrier.version,
          sourceVersion: carrier.sourceVersion,
          lifecycleVersion: carrier.lifecycleVersion,
        },
      },
    ];
  }
  // Landing a Lane by id from a folder that is not its checkout lands only its server-recorded head.
  // Refuse when that checkout holds unsaved edits or the head changes nothing (incident a930de4c).
  if (
    !command.candidateId &&
    !command.inputs &&
    command.laneId &&
    !resolvedHere &&
    marker?.selection.laneId !== command.laneId
  ) {
    const local = inspectLaneCheckout(command.laneId);
    if (local?.unsaved) throw unsavedEditsError(command.laneId, { root: local.root, count: local.unsaved });
    const recorded = await selectAgentLane(session, command.laneId);
    const changed =
      local && local.marker.selection.head === recorded.head
        ? changedPathsAgainstBase(local.root, local.marker)
        : null;
    if (
      !command.allowEmpty &&
      (changed === 0 || (changed === null && recorded.head === recorded.base.head && !recorded.stack))
    )
      throw nothingToLandError(command.laneId);
    await session.journal.retain(finishChangedPathsKey, () => changed);
  }
  if (
    !command.candidateId &&
    !command.inputs &&
    marker &&
    (!command.laneId || marker.selection.laneId === command.laneId)
  ) {
    const clean = context?.clean;
    if (!clean) {
      const saveOperationId = await session.journal.id('save');
      markLandStep('saveStarted');
      const saved = await saveHostedLane(
        session.root,
        { operationId: saveOperationId, message: landingNote(command.message ?? 'Agent change') },
        session.exchange,
        {
          ...saveContract(session.capabilities),
          authorship: session.authorship,
          ...(session.holderSessionId ? { holderSessionId: session.holderSessionId } : {}),
          onCapture: session.saveNotice,
        },
        false,
        {
          action: 'finish',
          parameters: {
            ...(context?.command ?? hostedAgentCommandSchemas.finish.parse(input)),
            operationId: session.journal.operationId,
          },
        },
      );
      if (agentSourceOutcome(saved)?.status !== 'completed') {
        if (agentSourceOutcome(saved)?.status === 'failed')
          await session.journal.retain('finish-source-failed', () => true);
        return { phase: 'save', saveOperationId, progress: saved };
      }
      markLandStep('saved');
      // Nothing lands while this folder holds edits the save did not take (a replayed save answered from
      // an older receipt, or an edit during it): UNSAVED_LANE_EDITS ends this land unsubmitted (48835eea).
      assertSavedCheckout(session.root, {
        what: 'land --save saved this checkout and submitted nothing',
        completed: { phase: 'save', saveOperationId, progress: saved },
      });
      const notSaved = capturedNotSaved(session.root, saveOperationId);
      if (notSaved) await session.journal.retain(finishNotSavedKey, () => notSaved);
    }
    const savedMarker = clean ? marker : session.marker();
    const selection = clean ?? savedMarker!.selection;
    // A saved head that changes nothing against its base lands nothing: refuse it, state the count otherwise.
    const changed = savedMarker ? changedPathsAgainstBase(session.root, savedMarker) : null;
    if (
      !command.allowEmpty &&
      (changed === 0 || (changed === null && selection.head === selection.base.head && !selection.stack))
    )
      throw nothingToLandError(selection.laneId);
    await session.journal.retain(finishChangedPathsKey, () => changed);
    // Cheap refusals, in one pass before any heavy-slot wait, preflight or compose (Item 168e4ed8).
    // Pins: a clean land composes against the checkout's pins; the Lane read above shows a move.
    const stale =
      clean && serverLane && serverLane.laneId === selection.laneId
        ? stalePinsRefusal(
            selection,
            serverLane,
            hostedRecoveryCommand(session.root, 'save', { message: 'Bring the Lane binding up to date' }),
          )
        : undefined;
    const retry = { ...parameters };
    delete retry.operationId;
    const next = {
      land: hostedRecoveryCommand(session.root, 'land --save', retry),
      sync: hostedRecoveryCommand(session.root, 'save --sync', { laneId: selection.laneId }),
    };
    // An extra source input or a stacked parent can change the proof comparison.
    const proofApplies = () => !command.dependencies.length && !command.after && !command.composeOperationId;
    let usedPreflight = false;
    const retained = command.composeOperationId ?? session.journal.get<string>('finish-compose-operation');
    const checkPreflightBase = (main: string | undefined) =>
      savedMarker && preflightBaseRefusal(session.root, savedMarker, main);
    // One check selection read for a flagged proof, reused at submission.
    let standardCheck: Promise<boolean> | undefined;
    const standard = () =>
      (standardCheck ??= (async () => {
        let isStandard = false;
        selectedCheck = checkSelection(
          session,
          command.check,
          () => {
            isStandard = true;
          },
          allowUnchecked,
        );
        // Check-selection errors still surface at submission, so they cannot hide source conflicts.
        await selectedCheck.catch(() => {
          isStandard = false;
        });
        return isStandard;
      })());
    const early = async (found: { queueProof?: QueueProofPreview | undefined; dirty?: boolean }) => {
      const refusals: CheapRefusal[] = [];
      if (found.dirty)
        refusals.push({
          code: 'LANE_DIRTY',
          message:
            'Files here changed after this land saved them, so its preflight would test other bytes than it lands. Nothing ran. Replay land --save to save them.',
          recovery: { command: next.land },
        });
      if (stale) refusals.push(stale);
      const proof = found.queueProof;
      // A finding refuses here only against current main and the standard check: one main read,
      // only when the local preview found a gap. Main moved since the preview: compose decides.
      if (proof && proofApplies() && (await standard())) {
        const main = await session.query<{ head?: string }>('projectHostedChannels:current', {});
        if (main?.head === proof.main) {
          // A stale proof already tells the builder to sync before refreshing it.
          const sync = !proof.refresh && !retained && !refusals.length && checkPreflightBase(main.head);
          if (sync) throw sync;
          refusals.push(queueProofRefusal(proof, next));
        }
      }
      const error = cheapRefusalError(refusals);
      if (error) throw error;
    };
    // Agent defaults (preflight) judge the saved head this finish will land.
    if (session.finishGates) {
      const advice = await session.finishGates(
        selection.laneId,
        selection.head,
        savedMarker?.selection.head === selection.head ? savedMarker.tree : undefined,
        command.message,
        early,
        main => {
          usedPreflight = true;
          // A retained compose pins its source. Let it reconcile before judging a newer main.
          if (retained && session.journal.get(`compose:${retained}`)) return;
          const sync = checkPreflightBase(main);
          if (sync) throw sync;
        },
      );
      const proof = advice.queueProof as QueueProofPreview | undefined;
      if (usedPreflight || (proof && proofApplies())) {
        beforeCompose = async mainHead => {
          // Compose can see a newer main after tests ran, including on a prepare retry.
          const sync = usedPreflight && checkPreflightBase(mainHead);
          if (sync) throw sync;
          // Use the main compose already reads. A finding for a superseded comparison is advisory.
          if (!proof || !proofApplies() || proof.main !== mainHead) return;
          if (!(await standard())) return;
          throw cheapRefusalError([queueProofRefusal(proof, next)])!;
        };
      }
      if (Object.keys(advice).length) await session.journal.retain('finish-defaults', () => advice);
    } else await early({});
    markLandStep('gated');
    command.inputs = [
      {
        laneId: selection.laneId,
        expected: {
          head: selection.head,
          version: selection.version,
          sourceVersion: selection.sourceVersion,
          lifecycleVersion: selection.lifecycleVersion,
        },
      },
    ];
  }
  const composeOperationId = command.composeOperationId ?? (await session.journal.id('compose'));
  await session.journal.retain('finish-compose-operation', () => composeOperationId);
  let candidateId = command.candidateId;
  if (!candidateId) {
    let progress;
    try {
      progress = await composeAgentSource(
        session,
        hostedAgentCommandSchemas.compose.parse({
          ...(command.laneId ? { laneId: command.laneId } : {}),
          ...(command.intentId ? { intentId: command.intentId } : {}),
          ...(command.inputs ? { inputs: command.inputs } : {}),
          dependencies: command.dependencies,
          message: landingNote(command.message ?? 'Agent change'),
        }),
        composeOperationId,
        false,
        beforeCompose,
        noteLandCompose,
      );
    } catch (error) {
      if (!(error instanceof BeganAtOlderEpoch)) throw error;
      // This finish's compose began at an older epoch and can never finish. Nothing of the landing
      // began (replayFinish found no request), so compose again under a new compose operation (N3);
      // a compose operation the caller named cannot change, so that one names a new finish without it.
      if (command.composeOperationId)
        throw olderEpochRefusal(session.root, error.code, "This finish's compose", error.began, error.epoch, {
          action: 'finish',
          parameters: freshFinish(context?.command ?? hostedAgentCommandSchemas.finish.parse(input)),
        });
      forgetFinishSource(session, 'finish-request');
      throw new AuthorityPinRefused(error);
    }
    // The server's phase split rides the reply's state (source-run-publish), read before a
    // check-only settle unwraps it, or a reconcile wait's progress: no call (friction c5e80d46).
    noteLandCompose(progress);
    if (command.accept === false)
      progress = await settleCheckOnlyCompose(session, composeOperationId, progress);
    markLandStep('composed');
    const completed = agentSourceOutcome(progress);
    if (completed?.status !== 'completed') {
      if (command.accept === false) {
        if (completed?.status === 'failed') await session.journal.retain('finish-source-failed', () => true);
        return { phase: 'compose', composeOperationId, progress };
      }
      session.pathNotice?.(null);
      const desired = await session.journal.retain('desired-landing', async () =>
        hostedLandingDesiredSchema.parse({
          ...(session.authorship ? { authorship: session.authorship.authorship } : {}),
          governanceVersion: 1,
          operationId,
          authorityEpoch: epoch,
          composeOperationId,
          ...declaration,
          ...(session.capabilities.landingMessageVersion === 1 ? { message: command.message ?? null } : {}),
          after: command.after,
          ...(command.priority ? { priority: command.priority } : {}),
          check: await (selectedCheck ?? checkSelection(session, command.check, undefined, allowUnchecked)),
          ...(command.reason ? { retryReason: command.reason } : {}),
          ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
          ...(command.closes === undefined ? {} : { closes: command.closes }),
          ...revertField(session, composeOperationId),
        }),
      );
      await retainLandGates(session, composeOperationId);
      const submission = await submitWhenRoom(session, room =>
        session.mutation<LandingSubmitReply>('projectHostedLandingDesired:submit', {
          request: canonicalPayload({ ...desired, governanceVersion: 1 }),
          // The receipt records the agent run that landed it (d730121f); outside the replayed request.
          ...(session.landingAgent ? { agent: session.landingAgent } : {}),
          ...(session.landingClient ? { agentClient: session.landingClient } : {}),
          ...landGatesArg(session),
          ...tokensArg(session),
          ...clientHoldArg(session),
          ...landedCountArg(session),
          ...room,
        }),
      );
      markLandStep('submitted');
      return {
        phase: 'finish',
        composeOperationId,
        progress,
        ...finishSubmission(submission),
        ...(await queuedConflict(session, submission as HostedLandingState)),
      };
    }
    const candidate = hostedRecordSchema.options[3].parse(completed.result);
    if (candidate.result.status === 'conflict' && session.capabilities.actions.includes('resolve')) {
      await session.journal.retain('finish-source-failed', () => true);
      return {
        phase: 'conflict',
        candidateId: candidate.id,
        recovery: await recoverHostedCandidate(session, candidate.id),
      };
    }
    candidateId = candidate.id;
  } else
    invariant(
      command.composeOperationId,
      'BAD_ARGUMENT',
      'Existing Candidate finish requires its original composeOperationId.',
    );
  const request = await session.journal.retain('finish-request', async () => {
    const candidate = hostedRecordSchema.options[3].parse(
      await session.query('projectHostedCompose:candidate', { candidateId }),
    );
    session.pathNotice?.(candidate.governance?.paths ?? null);
    if (command.accept === false) {
      invariant(candidate.result.status === 'clean', 'VIEW_CONFLICT', 'Check a clean hosted Candidate.');
      const check = await (selectedCheck ?? checkSelection(session, command.check));
      invariant(check, 'BAD_ARGUMENT', 'Select a configured hosted check.');
      const { kind: _kind, ...selection } = check;
      void _kind;
      return hostedCheckRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        candidateId,
        expectedHead: candidate.result.head,
        ...selection,
      });
    }
    return hostedLandingRequestSchema.parse({
      ...(session.authorship ? { authorship: session.authorship.authorship } : {}),
      governanceVersion: 1,
      operationId,
      authorityEpoch: epoch,
      channel: 'main',
      ...declaration,
      ...(session.capabilities.landingMessageVersion === 1 ? { message: command.message ?? null } : {}),
      expectedMain: candidate.base,
      candidateId,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      agent: true,
      ...(command.priority ? { priority: command.priority } : {}),
      check:
        checked?.check ??
        (await (selectedCheck ?? checkSelection(session, command.check, undefined, allowUnchecked))),
      ...(command.reason ? { retryReason: command.reason } : {}),
      finish: { composeOperationId, after: command.after },
      ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
      ...(command.closes === undefined ? {} : { closes: command.closes }),
      ...revertField(session, composeOperationId),
    });
  });
  if (command.accept === false) {
    const run = await enqueueCheck(session, request, pinnedCandidate);
    markLandStep('submitted');
    await session.journal.retain('finish-check-run', () => run);
    return { phase: 'check', composeOperationId, run };
  }
  // Account JWTs still make agent requests. Person authority is never selected by CLI input.
  await retainLandGates(session, composeOperationId);
  const result = await enqueueLanding(session, request, pinnedCandidate);
  markLandStep('submitted');
  return {
    phase: 'finish',
    composeOperationId,
    ...finishSubmission(result),
    ...(await queuedConflict(session, result)),
  };
}
/** A landing of one revert Lane records the receipt it compensates (Issue 8dbccdfb). */
function revertField(session: HostedAgentSession, composeOperationId: string) {
  const revertOf = composedRevertOf(session, composeOperationId);
  return revertOf ? { revertOf } : {};
}

// Cheap refusals (Item 168e4ed8): kept here, beside their one caller, so the CLI/MCP graph gains no module.
/** One refusal a land can name from local state or reads it already made (Item 168e4ed8). */
type CheapRefusal = {
  code: string;
  message: string;
  recovery?: Record<string, unknown>;
};
/** The local queue proof preview (src/preflight-hosted-checks.ts), as land retains it. */
export type QueueProofPreview = {
  main: string;
  message: string;
  refresh?: boolean;
  detail?: QueueProofDetail;
};

const lines = (detail: QueueProofDetail | undefined) => [
  ...(detail?.missing ?? []).map(item => `${item.path}: ${item.next}`),
  ...(detail?.uncoverable ?? []).map(item => item.next),
  ...(detail?.stale ?? []).map(item => `${item.path}: refresh with ${item.next}`),
];

/** QUEUE_PROOF_REQUIRED from the local preview: every path with its own next step, then the one
 * land command. A proof main changed under needs a sync first (ec229a55). */
function queueProofRefusal(proof: QueueProofPreview, next: { land: string; sync: string }): CheapRefusal {
  const each = lines(proof.detail);
  const steps = each.length ? ` Per path: ${each.join(' ')}` : '';
  const detail = proof.detail && Object.keys(proof.detail).length ? { queueProof: proof.detail } : {};
  if (proof.refresh)
    return {
      code: 'QUEUE_PROOF_REQUIRED',
      message: `${proof.message} Sync with ${next.sync}; after the refresh, run ${next.land}.${steps}`,
      recovery: { sync: next.sync, command: next.land, ...detail },
    };
  const attach = '.nforge/queue-proofs/<change>.json';
  return {
    code: 'QUEUE_PROOF_REQUIRED',
    message: `${proof.message} Attach the proof at ${attach} in this Lane, then run ${next.land}.${steps}`,
    recovery: { attach, command: next.land, ...detail },
  };
}

/** Every cheap refusal found in one pass, as one error: the first one's code and recovery, and
 * `refusals` naming each when there are several, so one fix round clears them all. */
function cheapRefusalError(refusals: CheapRefusal[]) {
  const [first] = refusals;
  if (!first) return undefined;
  if (refusals.length === 1) return new ForgeError(first.code, first.message, undefined, first.recovery);
  return new ForgeError(
    first.code,
    `Land refused before any preflight or compose: ${refusals.length} checks failed. ${refusals
      .map((refusal, at) => `${at + 1}) ${refusal.code}: ${refusal.message}`)
      .join(' ')}`,
    undefined,
    {
      ...first.recovery,
      refusals: refusals.map(refusal => ({
        code: refusal.code,
        message: refusal.message,
        ...(refusal.recovery ? { recovery: refusal.recovery } : {}),
      })),
    },
  );
}

type Pins = { head: string; version: number; sourceVersion: number; lifecycleVersion: number };
/** The Lane pins this land would compose against moved on the server: the Lane read land already
 * made before any save says so, at no extra call. Compose would refuse WORK_STALE after the
 * preflight; this names it first (Item 168e4ed8). */
function stalePinsRefusal(local: Pins, server: Pins, save: string): CheapRefusal | undefined {
  const moved = (['head', 'version', 'sourceVersion', 'lifecycleVersion'] as const).filter(
    key => local[key] !== server[key],
  );
  if (!moved.length) return undefined;
  return {
    code: 'WORK_STALE',
    message: `This checkout's Lane pins are stale: the server Lane moved (${moved.join(', ')}). Nothing ran. Bring the binding up to date with ${save}, then land again.`,
    recovery: { command: save },
  };
}
