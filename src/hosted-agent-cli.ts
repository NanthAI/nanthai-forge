// SPDX-License-Identifier: Apache-2.0
import { retainedChangedPaths } from './hosted-finish-guard.js';
import { waitFailure } from './wait-failure.js';
import { isNetworkPending } from './network-continuation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot, hostedAgentDirectory, retainedHostedOperation } from './hosted-agent-journal.js';
import { durableReplace } from './native-durability.js';
import { observeHostedRun, hostedWaitSchema } from './hosted-agent-observe.js';
import { observeOperations } from './hosted-agent-wait-local.js';
import { invariant } from './errors.js';
import { recordLaneHold, withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landSummary } from './hosted-land-summary.js';
import { syncRequiredAdvice, syncRequiredContinuation } from './hosted-would-conflict.js';
import { holdLines, landingHold } from './hosted-landing-hold.js';
import { learnFromLanding } from './preflight-learned.js';
import { operationLine } from './hosted-land-wait.js';
import { AGENT_WAIT_SECONDS, operationWait } from './agent-operation-wait.js';
import { recordTurnWait, settleTurnWork } from './agent-turn-work.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { networkTimeout } from './network-fetch.js';
import { canonicalOperationIds } from './operation-id-case.js';
import { boardWaitOption, boardWakeEnvelope, observePeerLane } from './hosted-board-wait.js';
import { approvalNext, observeApproval } from './hosted-agent-approval.js';
export { hostedAgentAddress } from './hosted-agent-address.js';
/** The CLI sends a hosted save under its wire name `checkpoint`; both mean save. */
const hostedSaveAction = (action: string) => action === 'save' || action === 'checkpoint';
const sourcePending = (response: { result?: unknown } | undefined) => {
  const result = response?.result as { status?: string; jobId?: string } | undefined;
  return result?.status === 'submitted' && typeof result.jobId === 'string';
};
/** Replaceable in tests; production waits on the source progress subscription. */
export const sourceWaitHooks = { wait: waitHostedAgentSource };
const waitSource = (...args: Parameters<typeof waitHostedAgentSource>) =>
  sourceWaitHooks.wait(args[0], args[1], args[2], args[3], undefined, 'Saves');
/** True when the retained address receipt already holds exactly these bytes. */
function receiptMatches(path: string, body: string) {
  try {
    return readFileSync(path, 'utf8') === body;
  } catch {
    return false;
  }
}
export async function hostedAgentCli(
  root: string,
  action: string,
  selected: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  signal?: AbortSignal,
) {
  root = hostedAgentRoot(root);
  const command = canonicalOperationIds(
    root,
    Object.fromEntries(
      Object.entries(selected).filter(([key]) => !['url', 'projectId', 'action'].includes(key)),
    ),
  );
  if (action === 'wait') {
    const selectedWait = hostedWaitSchema.parse(command);
    const alone = selectedWait.peer ?? selectedWait.approval;
    invariant(
      alone
        ? !selectedWait.runId &&
            !selectedWait.operationIds?.length &&
            !(selectedWait.peer && selectedWait.approval)
        : Boolean(selectedWait.runId) !== Boolean(selectedWait.operationIds?.length),
      'BAD_ARGUMENT',
      alone
        ? 'Wait for a peer Lane or an approval in its own command, without runId or operationIds.'
        : 'Choose one run or hosted landing operationIds.',
    );
    // Wait accepts any operation id the CLI handed out. A save (or other non-landing
    // operation) this checkout started resumes by exact replay of its local journal,
    // the same request its receipt command makes; no new hosted call type.
    const retained = (selectedWait.operationIds ?? []).flatMap(id => {
      const operation = retainedHostedOperation(root, id);
      return operation && operation.action !== 'finish' ? [{ id, ...operation }] : [];
    });
    if (retained.length) {
      invariant(
        retained.length === selectedWait.operationIds!.length,
        'BAD_ARGUMENT',
        `Wait on landings and on ${retained[0]!.action} operations in separate commands.`,
      );
      const budgetMs = (selectedWait.timeoutSeconds ?? AGENT_WAIT_SECONDS) * 1000,
        deadline = Date.now() + budgetMs;
      // A replayed save waits for its own outcome inside dispatch: within this wait's budget.
      transport.waitUntil = deadline;
      let response: Awaited<ReturnType<HostedAgentTransport['dispatch']>> | undefined;
      for (const operation of retained) {
        const replay = { ...operation.command, operationId: operation.id };
        response = await transport.dispatch(operation.action, replay);
        // A replay of a still-running save returns `submitted`: wait on its source
        // progress subscription (event-driven, no polling), then replay once more.
        while (sourcePending(response) && Date.now() < deadline) {
          await waitSource(
            address,
            operation.id,
            response.result,
            networkTimeout(Math.max(1, deadline - Date.now())),
          );
          response = await transport.dispatch(operation.action, replay);
        }
        if (isNetworkPending(response) || sourcePending(response)) {
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
              reason: 'budget',
              ...resume,
            },
          };
        }
        process.stderr.write(`${operation.action.toUpperCase()} ${operation.id} finished\n`);
      }
      settleTurnWork(retained.map(operation => operation.id));
      return response;
    }
    const controller = new AbortController(),
      stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      // The resume command repeats the caller's own selection (and budget, if chosen).
      const continuation = operationWait(root, { ...selectedWait, ...address });
      const budgetSeconds = selectedWait.timeoutSeconds ?? AGENT_WAIT_SECONDS;
      const observed = { ...command, timeoutSeconds: budgetSeconds };
      const laneId = markerIdentity(root)?.laneId ?? undefined;
      // Wait delivery: a note to this checkout's own Lane ends a landing or peer wait early.
      const board = selectedWait.runId ? undefined : boardWaitOption(root, laneId);
      const { next, waitCommand, inProgress } = continuation;
      const resume = { next, command: waitCommand, waitCommand, inProgress };
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
            ? { board: boardWakeEnvelope(root, board.laneId, outcome.board) }
            : {};
        process.exitCode = outcome.status === 'terminal' ? 0 : outcome.status === 'cancelled' ? 130 : 3;
        return {
          schema: 1 as const,
          transport: 'hosted' as const,
          action: 'observe' as const,
          operationId: null,
          resolved: null,
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
                  ...notes,
                  ...resume,
                },
        };
      }
      // This session now waits on this work: its turn-end hook sees a live observer.
      recordTurnWait(root, continuation.next, process.pid);
      // Events stay internal: the caller gets one line when the budget or outcome returns.
      const response = await withLaneCommand(laneId, 'wait', async () =>
        selectedWait.runId
          ? await observeHostedRun(transport, observed, controller.signal)
          : await observeOperations(
              transport,
              root,
              observed as Parameters<typeof observeOperations>[2],
              controller.signal,
              undefined,
              undefined,
              board,
            ),
      ).catch(error => {
        throw waitFailure(error, continuation);
      });
      const { submissions, status, run } = response.result as {
        submissions?: {
          submission: { phase?: string } & Parameters<typeof landingHold>[0];
          recovery?: unknown;
          conflict?: unknown;
        }[];
        status: string;
        run?: { status?: string } | null;
      };
      // A landing held for a person or a dependency says so on every unfinished return (5c59940b).
      const hold = submissions?.length === 1 ? landingHold(submissions[0]!.submission, laneId) : null;
      const held = hold ? { hold } : {};
      if (hold && status !== 'terminal') process.stderr.write(`${holdLines(hold).join('\n')}\n`);
      if (selectedWait.operationIds?.length === 1)
        recordLaneHold(laneId, selectedWait.operationIds[0]!, status === 'terminal' ? null : hold);
      if (status === 'message' && board) {
        // A note reached this Lane: same exit code and resume command as a budget return, so every
        // "repeat on IN PROGRESS" loop keeps working; the Stop hook still sees the unfinished wait.
        process.exitCode = 3;
        recordTurnWait(root, continuation.next, null);
        const delivered = (response.result as { board: Parameters<typeof boardWakeEnvelope>[2] }).board;
        return {
          ...response,
          result: {
            status: 'IN_PROGRESS',
            reason: 'message',
            budgetSeconds,
            operationIds: selectedWait.operationIds,
            phase: submissions?.length === 1 ? (submissions[0]!.submission.phase ?? 'unknown') : 'pending',
            ...held,
            board: boardWakeEnvelope(root, board.laneId, delivered),
            ...resume,
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
        process.exitCode = status === 'timeout' ? 3 : 130;
        recordTurnWait(root, continuation.next, null);
        return {
          ...response,
          result: {
            status: 'IN_PROGRESS',
            reason: status === 'timeout' ? 'budget' : 'cancelled',
            budgetSeconds,
            ...(selectedWait.runId
              ? { runId: selectedWait.runId, phase: run?.status ?? 'unknown' }
              : {
                  operationIds: selectedWait.operationIds,
                  phase:
                    submissions?.length === 1 ? (submissions[0]!.submission.phase ?? 'unknown') : 'pending',
                  ...held,
                }),
            ...resume,
          },
        };
      }
      process.exitCode = 0;
      settleTurnWork(selectedWait.runId ? [selectedWait.runId] : (selectedWait.operationIds ?? []));
      // A single-target wait exposes the same observed outcome as finish, while
      // retaining the complete selection below. Continuation consumers can follow
      // finish -> wait -> outcome without another read or a finish replay.
      const selected = submissions?.length === 1 ? submissions[0] : undefined;
      if (!selectedWait.runId && status === 'terminal')
        for (const entry of submissions ?? []) {
          const changedPaths =
            selectedWait.operationIds?.length === 1
              ? retainedChangedPaths(root, selectedWait.operationIds[0]!)
              : undefined;
          for (const line of landSummary({
            result: { phase: 'finish', ...entry, ...(changedPaths === undefined ? {} : { changedPaths }) },
          } as never))
            process.stderr.write(`${line}\n`);
          // A failed check of this checkout's landing teaches the next preflight its failing tests.
          if (submissions?.length === 1) learnFromLanding(root, entry);
        }
      return { ...response, result: { ...response.result, ...selected } };
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
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
    if (isNetworkPending(result)) {
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
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  // Retain only after an authorized successful response. An invalid/incomplete
  // address never silently turns into a local owner/listener dependency. A
  // read-only planning read writes nothing, and an unchanged receipt is not rewritten.
  if (!(action === 'planning' && command.reconcile === false)) {
    const receipt = join(hostedAgentDirectory(root), 'address.json'),
      body = JSON.stringify(address);
    if (!receiptMatches(receipt, body)) durableReplace(receipt, body);
  }
  return result;
}
