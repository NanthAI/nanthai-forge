// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { withCheckoutPrepObservation } from './checkout-prep-observation.js';
import { waitFailure } from './wait-failure.js';
import { isNetworkPending } from './network-continuation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import {
  hostedAgentRoot,
  hostedAgentDirectory,
  retainedHostedOperation,
  retainedHostedValues,
} from './hosted-agent-journal.js';
import type { FinishContext } from './hosted-agent-finish-identity.js';
import { durableReplace } from './state/durability.js';
import { hostedWaitSchema } from './hosted-wait-schema.js';
import { ForgeError, invariant } from './errors.js';
import { recordLaneHold, withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landExitsFailed, landingStallReport, landSummary, selfReviewLine } from './hosted-land-summary.js';
import { syncRequiredAdvice, syncRequiredContinuation } from './hosted-would-conflict.js';
import { holdLines, landingHold } from './hosted-landing-hold.js';
import { landingStateField } from './landing-state.js';
import {
  cancelledLandingRecovery,
  causeNextStep,
  emptyLandingRecovery,
  finishRecoveryLaneId,
  finishResubmitContinuation,
  landingWaitProgress,
  pendingLandingPresentation,
  stoppedLanding,
  stoppedLandingResubmit,
} from './hosted-agent-finish-result.js';
import { orderWaitOf } from './hosted-wait-line.js';
import { operationLine } from './hosted-land-wait.js';
import {
  AGENT_WAIT_SECONDS,
  interruptedWait,
  landingWaitBudgetReply,
  operationWait,
  stalledLandingContinuation,
} from './agent-operation-wait.js';
import { recordTurnWait, settleTurnWork } from './agent-turn-work.js';
import { HostedAgentTransport, type HostedAgentResponse } from './hosted-agent-transport.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { networkTimeout } from './network-fetch.js';
import type { BoardWaitOption } from './hosted-board-wait.js';
import { canonicalOperationIds } from './operation-id-case.js';
export { hostedAgentAddress } from './hosted-agent-address.js';
/** The CLI sends a hosted save under its wire name `checkpoint`; both mean save. */
const hostedSaveAction = (action: string) => action === 'save' || action === 'checkpoint';
const sourcePending = (response: { result?: unknown } | undefined, background = false) => {
  const result = response?.result as { status?: string; jobId?: string; operationId?: string } | undefined;
  return (
    (result?.status === 'submitted' && typeof result.jobId === 'string') ||
    (background && result?.status === 'settling' && typeof result.operationId === 'string')
  );
};
/** Replaceable in tests; production waits on the source progress subscription. */
export const sourceWaitHooks = { wait: waitHostedAgentSource };
const waitSource = (
  address: HostedAgentAddress,
  id: string,
  initial: unknown,
  signal: AbortSignal,
  board?: BoardWaitOption,
  kind: 'Saves' | 'Sync' | 'Compose' = 'Saves',
) =>
  sourceWaitHooks.wait(address, id, initial, signal, undefined, kind, undefined, undefined, undefined, board);
/** True when the retained address receipt already holds exactly these bytes. */
function receiptMatches(path: string, body: string) {
  try {
    return readFileSync(path, 'utf8') === body;
  } catch {
    return false;
  }
}
export function hostedAgentCli(...args: Parameters<typeof dispatchHostedAgentCli>) {
  return withCheckoutPrepObservation(() => dispatchHostedAgentCli(...args), performance.now());
}
async function dispatchHostedAgentCli(
  root: string,
  action: string,
  selected: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  signal?: AbortSignal,
  localLooseEnds = false,
) {
  root = hostedAgentRoot(root);
  const command = canonicalOperationIds(
    root,
    Object.fromEntries(
      Object.entries(selected).filter(([key]) => !['url', 'projectId', 'action'].includes(key)),
    ),
  );
  if (action === 'wait') {
    // The wait observers are large module graphs that only a wait uses.
    const [
      { observeHostedRun },
      {
        acknowledgedBackgroundSave,
        observeHostedRevert,
        observeHostedSave,
        observeOperations,
        restackObservedSave,
      },
      board$,
      { approvalNext, observeApproval },
      { mainWaitResult, observeMainGreen },
    ] = await Promise.all([
      import('./hosted-agent-observe.js'),
      import('./hosted-agent-wait-local.js'),
      import('./hosted-board-wait.js'),
      import('./hosted-agent-approval.js'),
      import('./hosted-main-wait.js'),
    ]);
    const { boardWaitOption, boardWakeEnvelope, observePeerLane, freshBoardDelivery } = board$;
    const selectedWait = hostedWaitSchema.parse(command);
    const alone = selectedWait.peer ?? selectedWait.approval ?? selectedWait.main ?? selectedWait.deploy;
    invariant(
      alone
        ? !selectedWait.runId &&
            !selectedWait.operationIds?.length &&
            [selectedWait.peer, selectedWait.approval, selectedWait.main, selectedWait.deploy].filter(Boolean)
              .length === 1
        : Boolean(selectedWait.runId) !== Boolean(selectedWait.operationIds?.length),
      'BAD_ARGUMENT',
      alone
        ? 'Wait for a peer Lane, an approval, main or a deploy in its own command, without runId or operationIds.'
        : 'Choose one run or hosted landing operationIds.',
    );
    const [onlyOperation] = selectedWait.operationIds ?? [];
    const backgroundSave =
      selectedWait.operationIds?.length === 1 &&
      onlyOperation &&
      acknowledgedBackgroundSave(root, onlyOperation)
        ? onlyOperation
        : undefined;
    // Non-landing operations that may still need preparation resume their exact journal request.
    // An acknowledged background save already has a worker and uses its own observation below.
    const retained = (backgroundSave ? [] : (selectedWait.operationIds ?? [])).flatMap(id => {
      const operation = retainedHostedOperation(root, id);
      return operation && operation.action !== 'finish' ? [{ id, ...operation }] : [];
    });
    const revert =
      selectedWait.operationIds?.length === 1 && retained[0]?.action === 'revert' ? retained[0] : undefined;
    if (retained.length && !revert) {
      invariant(
        retained.length === selectedWait.operationIds!.length,
        'BAD_ARGUMENT',
        `Wait on landings and on ${retained[0]!.action} operations in separate commands.`,
      );
      const budgetMs = (selectedWait.timeoutSeconds ?? AGENT_WAIT_SECONDS) * 1000,
        deadline = Date.now() + budgetMs;
      // A replayed save waits for its own outcome inside dispatch: within this wait's budget.
      transport.waitUntil = deadline;
      const board = boardWaitOption(root, markerIdentity(root)?.laneId ?? undefined);
      const previousBoard = transport.waitBoard;
      transport.waitBoard = board;
      const sourceMessage = (
        response: Awaited<ReturnType<HostedAgentTransport['dispatch']>>,
        value: unknown,
      ) => {
        if (!board) return undefined;
        const delivery = freshBoardDelivery(board, value);
        if (!delivery) return undefined;
        const { conflictNotice, notice, ...envelope } = boardWakeEnvelope(root, board.laneId, delivery);
        process.exitCode = 3;
        const { next, waitCommand, inProgress } = operationWait(root, { ...selectedWait, ...address });
        return {
          ...response,
          ...(conflictNotice ? { conflictNotice, notice } : {}),
          result: {
            status: 'IN_PROGRESS',
            reason: 'message',
            board: { ...envelope, ...(!conflictNotice && notice ? { notice } : {}) },
            next,
            waitCommand,
            command: waitCommand,
            inProgress,
          },
        };
      };
      try {
        let response: Awaited<ReturnType<HostedAgentTransport['dispatch']>> | undefined;
        for (const operation of retained) {
          const replay = { ...operation.command, operationId: operation.id };
          const observedRevert =
            operation.action === 'revert'
              ? await observeHostedRevert(
                  transport,
                  operation.id,
                  Math.max(0, (deadline - Date.now()) / 1000),
                  signal,
                  board,
                  operation.command,
                )
              : undefined;
          if (operation.action === 'revert')
            invariant(observedRevert, 'NOT_FOUND', 'This operation is not a hosted revert.');
          response = observedRevert ?? (await transport.dispatch(operation.action, replay));
          const delivered = sourceMessage(response, response.result);
          if (delivered) return delivered;
          // A still-running save returns `submitted` or split-save `settling`: wait on its source
          // progress subscription (event-driven, no polling), then replay once more.
          while (sourcePending(response, true) && Date.now() < deadline) {
            const progress = await waitSource(
              address,
              operation.id,
              response.result,
              networkTimeout(Math.max(1, deadline - Date.now())),
              transport.advertisedFeatures?.includes('source-board-wait') ? board : undefined,
              operation.action === 'compose'
                ? 'Compose'
                : ['sync', 'resolve'].includes(operation.action)
                  ? 'Sync'
                  : 'Saves',
            );
            const delivered = sourceMessage(response, progress);
            if (delivered) return delivered;
            const notice = progress as {
              conflictNotice?: HostedAgentResponse['conflictNotice'];
              notice?: string;
            };
            const replayed = await transport.dispatch(operation.action, replay);
            response = notice.conflictNotice
              ? {
                  ...replayed,
                  conflictNotice: notice.conflictNotice,
                  ...(notice.notice ? { notice: notice.notice } : {}),
                }
              : replayed;
          }
          const revertStatus = observedRevert?.result.status;
          if (
            isNetworkPending(response) ||
            sourcePending(response, true) ||
            revertStatus === 'timeout' ||
            revertStatus === 'cancelled'
          ) {
            process.exitCode = 3;
            const resume = operationWait(root, {
              operationIds: selectedWait.operationIds!,
              ...address,
            });
            return {
              ...response,
              result: {
                ...(response.result as object),
                status: 'IN_PROGRESS',
                reason: revertStatus === 'cancelled' ? 'cancelled' : 'budget',
                ...resume,
              },
            };
          }
          if (
            revertStatus === 'terminal' &&
            observedRevert &&
            'successful' in observedRevert.result &&
            observedRevert.result.successful === false
          ) {
            process.exitCode = 2;
            settleTurnWork([operation.id]);
            return response;
          }
          process.stderr.write(`${operation.action.toUpperCase()} ${operation.id} finished\n`);
        }
        settleTurnWork(retained.map(operation => operation.id));
        return response;
      } finally {
        transport.waitBoard = previousBoard;
      }
    }
    const controller = new AbortController();
    let signalled: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | undefined;
    const stop = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => {
      signalled = signal;
      controller.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    try {
      // The resume command repeats the caller's own selection (and budget, if chosen).
      const continuation = operationWait(root, { ...selectedWait, ...address });
      const budgetSeconds = selectedWait.timeoutSeconds ?? AGENT_WAIT_SECONDS;
      const observed = { ...command, timeoutSeconds: budgetSeconds };
      const laneId = markerIdentity(root)?.laneId ?? undefined;
      // Wait delivery: a note to this checkout's own Lane ends a landing or peer wait early.
      const board = boardWaitOption(root, laneId);
      const { next, waitCommand, inProgress } = continuation;
      const resume = { next, command: waitCommand, waitCommand, inProgress };
      if (selectedWait.deploy) {
        const { deployWaitResult, observeDeploy } = await import('./hosted-deploy-wait.js');
        const outcome = await observeDeploy(
          transport,
          { selection: selectedWait.deploy, timeoutSeconds: budgetSeconds },
          controller.signal,
        );
        process.exitCode =
          outcome.status === 'deployed'
            ? 0
            : outcome.status === 'failed'
              ? 2
              : outcome.status === 'cancelled'
                ? 130
                : 3;
        const result = deployWaitResult(outcome, budgetSeconds, resume);
        if ('message' in result && result.message) process.stderr.write(`${result.message}\n`);
        return {
          schema: 1 as const,
          transport: 'hosted' as const,
          action: 'observe' as const,
          operationId: null,
          resolved: null,
          result,
        };
      }
      if (selectedWait.main) {
        const outcome = await observeMainGreen(
          transport,
          { timeoutSeconds: budgetSeconds },
          controller.signal,
        );
        process.exitCode =
          outcome.status === 'green' || outcome.status === 'unreported'
            ? 0
            : outcome.status === 'cancelled'
              ? 130
              : 3;
        return {
          schema: 1 as const,
          transport: 'hosted' as const,
          action: 'observe' as const,
          operationId: null,
          resolved: null,
          result: mainWaitResult(outcome, budgetSeconds, resume),
        };
      }
      if (selectedWait.approval) {
        const laneId = selectedWait.approval;
        const outcome = await observeApproval(
          transport,
          { laneId, timeoutSeconds: budgetSeconds },
          controller.signal,
        );
        process.exitCode =
          outcome.status === 'decided' || outcome.status === 'none'
            ? 0
            : outcome.status === 'cancelled'
              ? 130
              : 3;
        const next = approvalNext(outcome, laneId);
        return {
          schema: 1 as const,
          transport: 'hosted' as const,
          action: 'observe' as const,
          operationId: null,
          resolved: null,
          result: next
            ? { status: 'terminal', reason: 'approval', approval: outcome.approval, next }
            : {
                status: 'IN_PROGRESS',
                reason: outcome.status === 'timeout' ? 'budget' : outcome.status,
                budgetSeconds,
                approval: outcome.approval,
                ...resume,
              },
        };
      }
      if (selectedWait.peer) {
        const peer = selectedWait.peer;
        const outcome = await withLaneCommand(laneId, 'wait', () =>
          observePeerLane(transport, { peer, timeoutSeconds: budgetSeconds }, board, controller.signal),
        );
        const notes =
          outcome.status === 'message' && board
            ? boardWakeEnvelope(root, board.laneId, outcome.board)
            : undefined;
        process.exitCode = outcome.status === 'terminal' ? 0 : outcome.status === 'cancelled' ? 130 : 3;
        return {
          schema: 1 as const,
          transport: 'hosted' as const,
          action: 'observe' as const,
          operationId: null,
          resolved: null,
          ...(outcome.status === 'terminal' && outcome.conflictNotice
            ? { conflictNotice: outcome.conflictNotice, notice: outcome.notice }
            : {}),
          ...(notes?.conflictNotice ? { conflictNotice: notes.conflictNotice, notice: notes.notice } : {}),
          result:
            outcome.status === 'terminal'
              ? {
                  status: 'terminal',
                  reason: 'peer',
                  peer: outcome.peer,
                  next:
                    outcome.peer.state === 'failed' || outcome.peer.state === 'cancelled'
                      ? `Peer Lane ${outcome.peer.laneId.slice(0, 8)}'s latest landing ${outcome.peer.state}; the Lane is still open. Do not wait for it to land; continue or check its status.`
                      : `Peer Lane ${outcome.peer.laneId.slice(0, 8)} is ${outcome.peer.state}. Sync if it landed, then continue.`,
                }
              : {
                  status: 'IN_PROGRESS',
                  reason: outcome.status === 'timeout' ? 'budget' : outcome.status,
                  budgetSeconds,
                  peer: outcome.peer,
                  ...(notes
                    ? {
                        board: {
                          notices: notes.notices,
                          more: notes.more,
                          cursor: notes.cursor,
                          ...(notes.noticeIds ? { noticeIds: notes.noticeIds } : {}),
                          ...(!notes.conflictNotice && notes.notice ? { notice: notes.notice } : {}),
                        },
                      }
                    : {}),
                  ...resume,
                },
        };
      }
      // This session now waits on this work: its turn-end hook sees a live observer.
      recordTurnWait(root, continuation.next, process.pid);
      // Events stay internal: the caller gets one line when the budget or outcome returns.
      let response = await withLaneCommand(laneId, 'wait', async () =>
        selectedWait.runId
          ? observeHostedRun(transport, observed, controller.signal, undefined, undefined, board)
          : revert
            ? observeHostedRevert(
                transport,
                revert.id,
                budgetSeconds,
                controller.signal,
                board,
                revert.command,
              )
            : backgroundSave
              ? observeHostedSave(
                  transport,
                  backgroundSave,
                  budgetSeconds,
                  controller.signal,
                  undefined,
                  board,
                  'background',
                )
              : observeOperations(
                  transport,
                  root,
                  observed as Parameters<typeof observeOperations>[2],
                  controller.signal,
                  undefined,
                  undefined,
                  board,
                ),
      ).catch(error => {
        if (
          backgroundSave &&
          error instanceof ForgeError &&
          (error.code === 'SAVE_SETTLE_FAILED' ||
            (error.code === 'SOURCE_AUTHORITY_CHANGED' && error.recovery))
        )
          settleTurnWork([backgroundSave]);
        if (
          onlyOperation &&
          error instanceof ForgeError &&
          ['SOURCE_AUTHORITY_CHANGED', 'NOT_FOUND'].includes(error.code) &&
          (error.recovery?.next as { action?: unknown } | undefined)?.action === 'revert'
        )
          settleTurnWork([onlyOperation]);
        throw waitFailure(error, continuation);
      });
      invariant(response, 'NOT_FOUND', 'The selected operation has no hosted progress.');
      if (backgroundSave && 'successful' in response.result && response.result.successful === true)
        response = await restackObservedSave(transport, response, controller.signal);
      type WaitProgress = Parameters<typeof landingWaitProgress>[0];
      const { submissions, status, run, pendingProgress } = response.result as {
        submissions?: {
          submission: { id: string; operationId: string; phase?: string } & NonNullable<
            Parameters<typeof landingHold>[0] & WaitProgress
          >;
          recovery?: unknown;
          conflict?: unknown;
          orderWait?: unknown;
          changedPaths?: number | null;
          sourceFailure?: unknown;
          wouldConflict?: unknown;
          providerDelay?: string;
          failureCause?: unknown;
        }[];
        status: string;
        pendingProgress?: NonNullable<WaitProgress>;
        run?: { status?: string } | null;
      };
      const selected = submissions?.length === 1 ? submissions[0] : undefined;
      const recorded = selected && {
        ...selected.submission,
        orderWait: orderWaitOf(selected.orderWait),
        providerDelay: selected.providerDelay,
      };
      const changed = pendingLandingPresentation(recorded, pendingProgress, laneId);
      const presentation = changed?.submission ?? recorded;
      const progress = await landingWaitProgress(recorded, pendingProgress, presentation, laneId);
      const phase =
        'phase' in response.result && (response.result.phase === 'save' || response.result.phase === 'revert')
          ? response.result.phase
          : selected
            ? (presentation?.phase ?? 'unknown')
            : 'pending';
      // A landing held for a person or a dependency says so on every unfinished return (5c59940b).
      const hold = progress ? progress.hold : landingHold(presentation, laneId);
      // The same state word and next step people see (src/landing-state.ts); additive.
      const landing = presentation
        ? {
            // The cause describes the recorded submission, never newer progress shown in its place.
            landingState: changed
              ? changed.landingState
              : causeNextStep(landingStateField(presentation, laneId), selected?.failureCause),
          }
        : {};
      // A stalled landing says so, with its source failure and replay, on every unfinished return
      // (friction c7f3afac: a wait stayed silent for 2 h on a failed compose step).
      const waitedOn = selectedWait.operationIds?.length === 1 ? selectedWait.operationIds[0]! : undefined;
      const retained = waitedOn ? retainedHostedOperation(root, waitedOn) : null;
      const stalled =
        selected && progress?.stall && status !== 'terminal'
          ? landingStallReport(
              { ...selected, submission: { observation: { stall: progress.stall } } },
              retained && waitedOn ? { root, ...retained, operationId: waitedOn } : undefined,
            )
          : undefined;
      const repair =
        stalled?.stall.replayCommand && retained
          ? {
              command: stalled.stall.replayCommand,
              next: { ...retained.command, action: retained.action, operationId: waitedOn },
            }
          : undefined;
      const stallAdvice =
        stalled && waitedOn ? stalledLandingContinuation(root, waitedOn, waitCommand, repair) : undefined;
      if ('landingState' in landing && landing.landingState && stallAdvice)
        landing.landingState.nextStep = stallAdvice.instruction;
      const held = {
        ...(hold ? { hold, ...landing } : landing),
        ...(stalled ? { stall: stalled.stall } : {}),
      };
      if (hold && status !== 'terminal') process.stderr.write(`${holdLines(hold).join('\n')}\n`);
      if (stalled) process.stderr.write(`${stalled.lines.join('\n')}\n`);
      if (selectedWait.operationIds?.length === 1)
        recordLaneHold(laneId, selectedWait.operationIds[0]!, status === 'terminal' ? null : hold);
      if (status === 'message' && board) {
        // A note reached this Lane: same exit code and resume command as a budget return, so every
        // "repeat on IN PROGRESS" loop keeps working; the Stop hook still sees the unfinished wait.
        process.exitCode = 3;
        if (stallAdvice) process.stderr.write(`${stallAdvice.instruction}\n`);
        recordTurnWait(root, continuation.next, null);
        const delivered = (response.result as { board: Parameters<typeof boardWakeEnvelope>[2] }).board;
        const { conflictNotice, notice, ...envelope } = boardWakeEnvelope(root, board.laneId, delivered);
        return {
          ...response,
          ...(conflictNotice ? { conflictNotice, notice } : {}),
          result: {
            status: 'IN_PROGRESS',
            reason: 'message',
            budgetSeconds,
            ...(selectedWait.runId
              ? { runId: selectedWait.runId }
              : { operationIds: selectedWait.operationIds }),
            phase,
            ...held,
            board: { ...envelope, ...(!conflictNotice && notice ? { notice } : {}) },
            ...resume,
            ...stallAdvice,
          },
        };
      }
      if (status === 'sync-required') {
        // Not landed and not in progress (f7539ebb): the entry needs its Lane synced. Exit 2 like any
        // outcome that needs action, so no "repeat on IN PROGRESS" loop keeps waiting on it.
        process.exitCode = 2;
        settleTurnWork(selectedWait.operationIds ?? []);
        // Readers never see a landing's message: the retained land command keeps it and the Lane.
        const entries = (submissions ?? []) as { submission: never; wouldConflict?: unknown }[];
        const found = entries.find(entry => syncRequiredAdvice(entry.wouldConflict, entry.submission));
        const index = found ? entries.indexOf(found) : -1;
        const original =
          index >= 0 && selectedWait.operationIds?.[index]
            ? retainedHostedOperation(root, selectedWait.operationIds[index]!)?.command
            : undefined;
        const sync = found
          ? syncRequiredContinuation(root, syncRequiredAdvice(found.wouldConflict, found.submission)!, {
              laneId: typeof original?.laneId === 'string' ? original.laneId : laneId,
              message: typeof original?.message === 'string' ? original.message : undefined,
            })
          : (response.result as { instruction?: string; command?: string });
        process.stderr.write(`${sync.instruction}\nContinue recovery: ${sync.command}\n`);
        return {
          ...response,
          result: {
            ...response.result,
            ...sync,
            status: 'SYNC_REQUIRED',
            operationIds: selectedWait.operationIds,
            phase: 'queued',
          },
        };
      }
      if (status === 'timeout' || status === 'cancelled') {
        const interrupted = status === 'cancelled' ? interruptedWait(signalled) : undefined;
        const budget =
          status === 'timeout' && progress
            ? landingWaitBudgetReply(progress, waitCommand, stallAdvice)
            : undefined;
        process.exitCode = interrupted?.exitCode ?? 3;
        if (budget) process.stderr.write(`${budget.message}\n`);
        if (interrupted?.note)
          process.stderr.write(
            stallAdvice ? `${stallAdvice.instruction}\n` : `${interrupted.note}\n${waitCommand}\n`,
          );
        recordTurnWait(root, continuation.next, null);
        return {
          ...response,
          result: {
            status: 'IN_PROGRESS',
            reason: interrupted?.reason ?? 'budget',
            ...(interrupted?.note && !stallAdvice ? { note: interrupted.note } : {}),
            budgetSeconds,
            ...(selectedWait.runId
              ? { runId: selectedWait.runId, phase: run?.status ?? 'unknown' }
              : {
                  operationIds: selectedWait.operationIds,
                  phase,
                  ...budget,
                  ...held,
                }),
            ...resume,
            ...stallAdvice,
          },
        };
      }
      process.exitCode =
        (backgroundSave || phase === 'revert') &&
        'successful' in response.result &&
        response.result.successful === false
          ? 2
          : 0;
      settleTurnWork(selectedWait.runId ? [selectedWait.runId] : (selectedWait.operationIds ?? []));
      // A single-target wait exposes the same observed outcome as finish, while
      // retaining the complete selection below. Continuation consumers can follow
      // finish -> wait -> outcome without another read or a finish replay.
      const settled =
        !selectedWait.runId && status === 'terminal'
          ? submissions?.map((entry, index) => {
              const operationId = selectedWait.operationIds?.[index] ?? entry.submission.operationId;
              const code = entry.submission.error?.code;
              const stopped =
                entry.submission.observation?.state === 'terminal-failed' && stoppedLanding(code);
              const empty = code === 'NOTHING_TO_LAND';
              const original =
                (stopped || empty) && (waitedOn ? retained : retainedHostedOperation(root, operationId));
              const finish = original && original.action === 'finish' ? original : undefined;
              const retry = stopped && finish ? finishResubmitContinuation(root, finish.command) : undefined;
              const context = finish
                ? (retainedHostedValues(root, operationId, 'finish')?.['finish-context'] as
                    | FinishContext
                    | undefined)
                : undefined;
              const selectedLane = finish
                ? finishRecoveryLaneId(finish.command, context?.clean?.laneId ?? laneId)
                : undefined;
              const emptyRecovery = empty
                ? emptyLandingRecovery(selectedLane ? root : '.', selectedLane)
                : undefined;
              const advice =
                code === 'LANDING_CANCELLED'
                  ? cancelledLandingRecovery(root, selectedLane, retry, entry.wouldConflict)
                  : {
                      ...retry,
                      ...(emptyRecovery
                        ? { recovery: emptyRecovery, instruction: emptyRecovery.instruction }
                        : !retry && stopped
                          ? { recovery: { instruction: stoppedLandingResubmit } }
                          : {}),
                    };
              const outcome = {
                ...response,
                operationId,
                result: { phase: 'finish', ...entry, ...advice },
              };
              // A failed landing exits 2, the same as `land` (SM-C M7); landed and superseded stay 0.
              if (landExitsFailed(outcome)) process.exitCode = 2;
              for (const line of landSummary(outcome)) process.stderr.write(`${line}\n`);
              return { ...entry, ...advice };
            })
          : undefined;
      if (settled?.length === 1) {
        const { learnFromLanding } = await import('./preflight-learned.js');
        learnFromLanding(root, settled[0]);
      }
      const onlySettled = settled?.length === 1 ? settled[0] : undefined;
      const instruction = onlySettled && 'instruction' in onlySettled ? onlySettled.instruction : undefined;
      return {
        ...response,
        result: {
          ...response.result,
          ...(settled ? { submissions: settled } : {}),
          ...(onlySettled ?? selected),
          ...landing,
          ...('landingState' in landing && landing.landingState && instruction
            ? { landingState: { ...landing.landingState, nextStep: instruction } }
            : {}),
        },
      };
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGHUP', stop);
    }
  }
  const controller = new AbortController(),
    stop = () => controller.abort();
  if (!signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  // Landings announce their own first line after submission (hosted-land-wait).
  if (action !== 'finish' && !transport.onOperation)
    transport.onOperation = (selected, operationId) =>
      process.stderr.write(`${operationLine(root, selected, operationId)}\n`);
  let result;
  try {
    result = await transport.dispatch(action, command, signal ?? controller.signal);
    // A conflict names the one folder to work in now (land prints it in its own summary).
    const workIn = (result.result as { conflict?: { workIn?: unknown } } | undefined)?.conflict?.workIn;
    if (action !== 'finish' && typeof workIn === 'string') process.stderr.write(`${workIn}\n`);
    const preflight =
      action === 'preflight' ? (result.result as { outcome?: unknown } | undefined) : undefined;
    if (typeof preflight?.outcome === 'string') {
      // The exit status matches the run's outcome (friction 7ef4a55e); the module is already loaded.
      const { preflightExitStatus } = await import('./agent-preflight-incomplete.js');
      process.exitCode = preflightExitStatus(preflight.outcome as Parameters<typeof preflightExitStatus>[0]);
    } else if (
      action === 'preflight' &&
      typeof (result.result as { saveOperationId?: unknown } | undefined)?.saveOperationId === 'string'
    ) {
      // An earlier save of this Lane is still settling, so no test ran: IN PROGRESS, never a
      // passed-looking exit 0 (friction d6378866). Wait on it, then run preflight again.
      const save = (result.result as { saveOperationId: string }).saveOperationId;
      const resume = operationWait(root, { operationIds: [save] });
      process.stderr.write(
        `preflight: IN PROGRESS; no test ran: save ${save} is still settling. Wait with: ${resume.waitCommand}, then run preflight again.\n`,
      );
      process.exitCode = 3;
    } else if (isNetworkPending(result)) {
      const pending = result.result as { command: string };
      process.stderr.write(`IN PROGRESS; network response unavailable. Continue: ${pending.command}\n`);
      process.exitCode = 3;
    } else if (hostedSaveAction(action) && result.operationId && sourcePending(result)) {
      // The save waited its whole budget for its own outcome: one resume, never a new save.
      const resume = operationWait(root, {
        operationIds: [result.operationId],
      });
      process.stderr.write(`save: IN PROGRESS; keep waiting with: ${resume.waitCommand}\n`);
      process.exitCode = 3;
      const { next, waitCommand, inProgress } = resume;
      result = {
        ...result,
        result: {
          ...(result.result as object),
          status: 'IN_PROGRESS',
          reason: 'budget',
          next,
          command: waitCommand,
          waitCommand,
          inProgress,
        },
      };
    }
  } catch (error) {
    if (
      error instanceof ForgeError &&
      error.recovery?.outcome === 'refused' &&
      error.recovery.retryable === false &&
      typeof error.recovery.command === 'string'
    )
      process.stderr.write(`${action}: operation refused. Continue with ${error.recovery.command}\n`);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  // Retain only after an authorized successful response. An invalid/incomplete
  // address never silently turns into a local owner/listener dependency. A
  // read-only planning read writes nothing, and an unchanged receipt is not rewritten.
  const itemRead =
    command.id !== undefined || command.planningItemId !== undefined || command.itemId !== undefined;
  if (!(action === 'planning' && (command.reconcile === false || (command.reconcile !== true && itemRead)))) {
    const receipt = join(hostedAgentDirectory(root), 'address.json'),
      body = JSON.stringify(address);
    if (!receiptMatches(receipt, body)) durableReplace(receipt, body);
  }
  // A passed preflight names the self-review of what will land (593fc2d7).
  if (action === 'preflight') {
    const preflight = result.result as { outcome?: unknown; workingTree?: boolean } | undefined;
    if (preflight?.outcome === 'passed' && !preflight.workingTree)
      process.stderr.write(`${selfReviewLine(root)}\n`);
  }
  // MCP also dispatches here. Only the installed CLI opts in to private machine-local evidence.
  if (localLooseEnds && action === 'lanes' && command.view === 'loose-ends') {
    // Load the unbundled sibling so other CLI commands and MCP keep their startup graph.
    const { withLocalLooseEndsHolders } = (await import(
      /* @vite-ignore */ new URL('./hosted-loose-ends.js', import.meta.url).href
    )) as typeof import('./hosted-loose-ends.js');
    return { ...result, result: withLocalLooseEndsHolders(result.result, address) };
  }
  return result;
}
