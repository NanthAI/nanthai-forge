// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { orderWaitOf, waitEventLine } from './hosted-wait-line.js';
import { ForgeError } from './errors.js';
import type { Failure } from './system-errors.js';
import { suppliedLandingMessage } from './landing-message.js';
import { clientCacheRoot } from './root-paths.js';
import { isNetworkPending } from './network-continuation.js';
import {
  landingWaitProgress,
  normalizeHostedFinishResult,
  pendingLandingPresentation,
  retryableFinishSource,
} from './hosted-agent-finish-result.js';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { HostedAgentTransport, type HostedAgentResponse } from './hosted-agent-transport.js';
import { hostedAgentCli } from './hosted-agent-cli.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { followLocalOperation, landingFeedLanes } from './hosted-agent-wait-local.js';
import { observeHostedRun } from './hosted-agent-observe.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { readClientSettings } from './client-settings.js';
import { recordLaneHold, withLaneCommand } from './lane-registry.js';
import { landingHold } from './hosted-landing-hold.js';
import { markerIdentity } from './lane-prune.js';
import {
  landExitsFailed,
  landOutcomeKind,
  landPhase,
  landSummary,
  resultOf,
  landTerminal,
} from './hosted-land-summary.js';
import { learnFromLanding } from './preflight-learned.js';
import { landAnnouncement, landResumeCommand, landWaitContinuation } from './hosted-land-wait.js';
import { recordTurnWait, settleTurnWork } from './agent-turn-work.js';
import { exactConflictBannerOnce, type ExactConflictNotice } from './hosted-conflict-notice.js';
import { LAND_INVOKED_ENV, landTiming, landTimingLine, startLandTiming } from './land-timing.js';
import { AGENT_WAIT_SECONDS, landingWaitBudgetReply } from './agent-operation-wait.js';
import { waitFailure } from './wait-failure.js';
import { withLandWaitMetrics } from './land-wait-metrics.js';
import { backgroundWake, wakeContinuation } from './agent-wake.js';
import { landEditedResolution } from './hosted-land-resolution.js';
import { LAND_CHILD_ENV } from './hosted-land-child-env.js';
import {
  HELD_LAND_AUTO_ENV,
  LAND_BUDGET_ENV,
  LAND_WAKE_ENV,
  spawnLandSubmitter,
} from './hosted-land-submitter-process.js';
import { syncOnceRelanded, syncOnceStopped, syncRequiredOnce } from './hosted-land-sync-once.js';

export { landPhase, landSummary };

/** Set in the detached submitter (LAND_CHILD_ENV): it submits and exits without waiting. */
export { LAND_CHILD_ENV };
/** Default: the agent wait budget, so a foreground land returns IN_PROGRESS with its resume
 * command before a 600 s agent shell backgrounds or kills it. */
function landBudgetSeconds() {
  const chosen = Number(process.env[LAND_BUDGET_ENV]);
  return Number.isFinite(chosen) && chosen > 0 ? chosen : AGENT_WAIT_SECONDS;
}
/** Immediate stderr progress for a submitted landing: operation id, replay and wait commands, conflict banner. */
function announce(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
  wake: boolean,
) {
  for (const line of landAnnouncement(root, command, response, wake)) process.stderr.write(`${line}\n`);
  const exact = (response as { conflictNotice?: ExactConflictNotice }).conflictNotice;
  if (exact) process.stderr.write(exactConflictBannerOnce(exact));
}

/** The submitter: replays finish while its save job is still running, so compose and submission
 * never wait for the agent to call again. Bounded; every replay reuses the same retained operation. */
export async function submitHostedLand(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  rounds = 30,
  /** The land returns at once with a background wake (the detached submitter reads it from env). */
  wake = process.env[LAND_WAKE_ENV] === '1',
) {
  const invokedAt = Number(process.env[LAND_INVOKED_ENV] || undefined);
  startLandTiming(invokedAt);
  // The submitter shares the land command's budget, timed from when that command started.
  const deadline = (Number.isFinite(invokedAt) ? invokedAt : Date.now()) + landBudgetSeconds() * 1000;
  // A save or check-only compose that waits for its own outcome inside finish stops at this deadline.
  transport.waitUntil ??= deadline;
  // An edited, unsaved resolution in this folder: save it (resolve) and land the resolution Lane.
  // The landing's operation id is the first id printed (593fc2d7): the resolve step names none, and
  // its note follows the land line. Replaying this land reaches the same resolve and finish.
  const notes: string[] = [];
  const previous = transport.onOperation;
  transport.onOperation = action =>
    process.stderr.write(`land: ${action} step first; if this stops, run the same land again\n`);
  let chained;
  try {
    chained = await landEditedResolution(
      hostedAgentRoot(root),
      command,
      (action, body) => hostedAgentCli(root, action, body, address, transport),
      line => notes.push(line),
      process.env[HELD_LAND_AUTO_ENV] === '1' && typeof command.operationId === 'string'
        ? command.operationId
        : undefined,
    );
  } finally {
    if (previous) transport.onOperation = previous;
    else delete transport.onOperation;
  }
  const flush = () => {
    for (const line of notes.splice(0)) process.stderr.write(`${line}\n`);
  };
  if (chained && 'response' in chained) {
    flush();
    return chained.response as HostedAgentResponse;
  }
  if (chained) command = chained.finish;
  let response: HostedAgentResponse;
  try {
    response = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  } catch (error) {
    flush();
    throw error;
  }
  // The first receipt already carries the operation id and any overlap notice: show them now, not at exit.
  announce(transport.root ?? root, command, response, wake);
  flush();
  for (let round = 0; round < rounds; round++) {
    const result = resultOf(response);
    if (result.phase !== 'save' || !result.saveOperationId || result.progress?.status === 'failed') break;
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) break;
    await waitHostedAgentSource(
      address,
      result.saveOperationId,
      result.progress,
      undefined,
      undefined,
      'Saves',
      Math.min(60, remaining),
    );
    response = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  }
  // Item 36fd3295: a land that rejoined its own SYNC_REQUIRED entry syncs once.
  const once = await syncRequiredOnce(
    transport.root ?? root,
    command,
    response,
    async (action, body) =>
      (await hostedAgentCli(root, action, body, address, transport)) as HostedAgentResponse,
    line => process.stderr.write(`${line}\n`),
  );
  if (once) {
    response = once;
    if (syncOnceRelanded(once)) announce(transport.root ?? root, command, response, wake);
  }
  // Where the time before submission went: in the receipt, and one line for people.
  const timing = landTiming();
  if (!timing) return response;
  const heldMs = resultOf(response).submission?.timing?.heldMs;
  const line = landTimingLine(timing);
  if (line) process.stderr.write(`${line}\n`);
  return { ...response, landTiming: { ...timing, ...(heldMs === undefined ? {} : { heldMs }) } };
}

/** Copy a growing file to stderr; stop() flushes the rest. A short local timer, no network. */
export function relayFile(path: string) {
  const fd = openSync(path, 'r');
  let offset = 0;
  const flush = () => {
    const size = fstatSync(fd).size;
    if (size <= offset) return;
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    offset += read;
    process.stderr.write(buffer.subarray(0, read));
  };
  const timer = setInterval(flush, 200);
  return {
    stop() {
      clearInterval(timer);
      try {
        flush();
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Run the submitter in its own process group with file output: a killed, interrupted or
 * SIGPIPEd client never stops a landing it already started. */
async function detachedSubmit(
  root: string,
  command: Record<string, unknown>,
  budgetSeconds: number,
  wake: boolean,
): Promise<HostedAgentResponse | null> {
  const directory = join(clientCacheRoot(hostedAgentRoot(root)), 'agent', 'land');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, randomUUID());
  const child = spawnLandSubmitter(root, command, base, budgetSeconds, wake);
  const leave = () => {
    process.stderr.write(
      `land: submission continues in the background (pid ${child.pid}); run the same command to resume.\n`,
    );
    process.exit(130);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, leave);
  // Forward the submitter's stderr as it appears (local file reads only), so the operation id and an
  // overlap banner reach the agent while the save and compose are still running.
  const relay = relayFile(`${base}.err`);
  const code = await new Promise<number>(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', status => resolve(status ?? 1));
  });
  relay.stop();
  for (const signal of signals) process.removeListener(signal, leave);
  const stdout = readFileSync(`${base}.out`, 'utf8');
  rmSync(`${base}.out`, { force: true });
  rmSync(`${base}.err`, { force: true });
  const line = stdout.trim().split('\n').at(-1);
  if ((code !== 0 && code !== 3) || !line) {
    if (code === 1 && line?.startsWith('{"error":')) {
      const { error } = JSON.parse(line) as { error?: Failure };
      if (error?.code === 'RATE_LIMITED' && error.recovery?.retryAt)
        throw new ForgeError(error.code, error.message, undefined, error.recovery);
    }
    process.exitCode = code || 1;
    return null;
  }
  const response = JSON.parse(line) as HostedAgentResponse;
  if (code === 3) process.exitCode = 3;
  return response;
}

/** Event-driven wait on the submission (or check-only run); Ctrl-C stops waiting, never the landing. */
async function waitLanding(
  root: string,
  transport: HostedAgentTransport,
  response: HostedAgentResponse,
  timeoutSeconds: number,
) {
  const result = resultOf(response);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let lastKey = '';
    const emit = (event: unknown) => {
      const compact = waitEventLine(event);
      if (compact && compact.key !== lastKey) {
        lastKey = compact.key;
        process.stdout.write(`${JSON.stringify(compact.line)}\n`);
      }
      if ((event as { type?: string }).type === 'observation-retry')
        process.stderr.write(
          'land: observation unavailable; landing still in progress. Continuing to wait.\n',
        );
    };
    // A local start/end receipt for this wait: a killed client still names the phase it was in.
    if (result.phase === 'check' && result.run?.id) {
      const runId = result.run.id;
      return await withLandWaitMetrics(
        root,
        { operationId: runId, waitingFor: 'run', budgetSeconds: timeoutSeconds },
        emit,
        observed => observeHostedRun(transport, { runId, timeoutSeconds }, controller.signal, observed),
      );
    } else if (response.operationId) {
      const selection = { operationIds: [response.operationId], timeoutSeconds, until: 'acceptance' };
      try {
        return await withLandWaitMetrics(
          root,
          { operationId: response.operationId, waitingFor: 'acceptance', budgetSeconds: timeoutSeconds },
          emit,
          observed =>
            observeHostedSubmissions(
              transport,
              selection,
              controller.signal,
              observed,
              undefined,
              undefined,
              landingFeedLanes(root, selection.operationIds),
            ),
        );
      } catch (error) {
        // A check-only or save operation id is not a landing: follow what this client recorded for it.
        const followed = await followLocalOperation(
          transport,
          root,
          selection,
          error,
          controller.signal,
          emit,
        );
        if (followed) return followed;
        const resume = landWaitContinuation(root, response);
        throw resume ? waitFailure(error, resume) : error;
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** land --save / finish for hosted Lanes: submit (detached), then wait for the outcome by default. */
export async function hostedLandCli(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  options: { wait?: boolean | undefined; detach?: boolean; timeoutSeconds?: number } = {},
): Promise<HostedAgentResponse | undefined> {
  if (process.env[LAND_CHILD_ENV] === '1') return submitHostedLand(root, command, address);
  // Before the submitter starts or any server call: an empty or over-long message fails here, at once.
  if (typeof command.message === 'string') suppliedLandingMessage(command.message);
  // One budget for the whole command (submission and wait), from when it started.
  const budgetSeconds = options.timeoutSeconds ?? AGENT_WAIT_SECONDS,
    deadline = Date.now() + budgetSeconds * 1000;
  // Agents whose client wakes them when a background command exits land asynchronously:
  // submit, return at once, and one settle wait in the background is the only wake.
  const wake = options.wait === undefined && backgroundWake() !== undefined;
  const wait = options.wait ?? (wake ? false : readClientSettings().landWait);
  const submitted =
    options.detach === false
      ? await submitHostedLand(root, command, address, undefined, undefined, wake)
      : await detachedSubmit(root, command, budgetSeconds, wake);
  if (!submitted) return undefined;
  if (isNetworkPending(submitted)) return submitted;
  const sourceNeedsRecovery = retryableFinishSource(resultOf(submitted));
  if (
    !wait ||
    landTerminal(submitted) ||
    sourceNeedsRecovery ||
    ['conflict', 'save', 'compose', 'sync'].includes(String(resultOf(submitted).phase))
  ) {
    const lines = landSummary(submitted);
    for (const line of lines) process.stderr.write(`${line}\n`);
    learnFromLanding(hostedAgentRoot(root), resultOf(submitted), command.laneId);
    // Not waiting here: an unfinished landing still names the one command that waits for it.
    const continuation =
      landOutcomeKind(submitted) === 'failed'
        ? undefined
        : landWaitContinuation(hostedAgentRoot(root), submitted);
    const awake =
      wake && continuation ? wakeContinuation(hostedAgentRoot(root), continuation.next) : undefined;
    const next = awake?.command ?? continuation?.waitCommand;
    if (awake)
      process.stderr.write(
        `land: ${resultOf(submitted).phase === 'finish' ? 'SUBMITTED' : 'IN PROGRESS'}; it settles without you. Run once in the background; its exit is your one wake (landed, failed or cancelled, with the receipt): ${awake.command}\n`,
      );
    else if (next) process.stderr.write(`Next: wait for the outcome with ${next}\n`);
    if (landOutcomeKind(submitted) === 'failed' || syncOnceStopped(submitted)) process.exitCode = 2;
    else if (
      (wait || wake) &&
      !awake &&
      (sourceNeedsRecovery || ['save', 'compose', 'sync'].includes(resultOf(submitted).phase ?? ''))
    ) {
      // Source preparation outlived the budget (or needs its recovery): one exact resume command.
      if (!next)
        process.stderr.write(
          `land: IN PROGRESS; resume with: ${landResumeCommand(hostedAgentRoot(root), command, submitted)}\n`,
        );
      process.exitCode = 3;
    }
    // stdout names the same one step as stderr: wait, not a blocking finish replay.
    if (awake)
      return {
        ...submitted,
        result: {
          ...(submitted.result as object),
          next: awake.next,
          command: awake.command,
          waitCommand: awake.waitCommand,
          inProgress: true,
          wake: awake.wake,
          instruction: awake.instruction,
        },
      };
    const resume = next ? continuation : undefined;
    return resume && resultOf(submitted).phase !== 'finish'
      ? {
          ...submitted,
          result: {
            ...(submitted.result as object),
            next: resume.next,
            command: resume.command,
            waitCommand: resume.waitCommand,
          },
        }
      : submitted;
  }
  process.stderr.write(
    `land: waiting for the outcome (operationId ${submitted.operationId}); Ctrl-C stops waiting, not the landing.\n`,
  );
  const transport = new HostedAgentTransport(root, address);
  // This session owns the landing now: its turn-end hook sees a live observer.
  recordTurnWait(
    transport.root ?? root,
    landWaitContinuation(transport.root ?? root, submitted)?.next,
    process.pid,
  );
  const finished = await withLaneCommand(markerIdentity(root)?.laneId ?? undefined, 'land', () =>
    waitLanding(transport.root ?? root, transport, submitted, Math.max(1, (deadline - Date.now()) / 1000)),
  );
  // The authoritative read already contains the outcome. Replaying finish here
  // could fail after acceptance or at the deadline, misreporting the landing.
  type WaitProgress = NonNullable<Parameters<typeof landingWaitProgress>[0]>;
  const observation = finished?.result as
    | {
        status?: string;
        run?: unknown;
        submissions?: {
          submission: WaitProgress & { id: string; operationId: string };
          recovery?: unknown;
          conflict?: unknown;
          orderWait?: unknown;
          changedPaths?: number | null;
        }[];
        pendingProgress?: WaitProgress;
      }
    | undefined;
  const selected = observation?.submissions?.[0];
  const selection = (submitted.result as { replayParameters?: Record<string, unknown> }).replayParameters ?? {
    ...command,
    operationId: submitted.operationId,
  };
  const laneId = typeof selection.laneId === 'string' ? selection.laneId : undefined;
  const pending =
    observation?.status === 'timeout' && selected
      ? { ...selected.submission, orderWait: orderWaitOf(selected.orderWait) }
      : undefined;
  const current = pendingLandingPresentation(pending, observation?.pendingProgress, laneId);
  const result = normalizeHostedFinishResult(transport.root ?? root, selection, {
    ...(submitted.result as Record<string, unknown>),
    ...(observation?.run ? { run: observation.run } : {}),
    ...selected,
    ...(current ? { orderWait: selected?.orderWait } : {}),
    ...(observation?.status && observation.status !== 'terminal'
      ? { waitStatus: observation.status, inProgress: true }
      : {}),
  });
  // An older observer can omit the accepted count. Drop any estimate inherited from submission.
  if (selected?.submission.phase === 'landed' && selected.changedPaths === undefined)
    delete result.changedPaths;
  if (current) {
    result.pendingProgress = observation?.pendingProgress;
    result.landingState = current.landingState;
    const hold = landingHold(current.submission, laneId);
    if (hold) result.hold = hold;
    else delete result.hold;
  }
  const final: HostedAgentResponse = {
    ...submitted,
    ...(finished && 'localLanes' in finished && finished.localLanes
      ? { localLanes: finished.localLanes }
      : {}),
    result,
  };
  if (final.budget && Date.parse(final.budget.resetAt) <= Date.now()) delete final.budget;
  const progress = await landingWaitProgress(
    pending,
    observation?.pendingProgress,
    current?.submission ?? pending,
    laneId,
  );
  const resume = landWaitContinuation(transport.root ?? root, final);
  const budget = progress && resume ? landingWaitBudgetReply(progress, resume.waitCommand) : undefined;
  if (budget) Object.assign(result, budget);
  const lines = landSummary(final, current?.submission ?? (budget ? pending : undefined));
  for (const line of lines) process.stderr.write(`${line}\n`);
  if (typeof submitted.operationId === 'string')
    recordLaneHold(
      (typeof command.laneId === 'string' ? command.laneId : undefined) ??
        markerIdentity(root)?.laneId ??
        undefined,
      submitted.operationId,
      landTerminal(final) ? null : landingHold(resultOf(final).submission),
    );
  learnFromLanding(hostedAgentRoot(transport.root ?? root), resultOf(final), command.laneId);
  const resumeWith = resume?.next;
  if (resumeWith) recordTurnWait(transport.root ?? root, resumeWith, null);
  else
    settleTurnWork(
      [submitted.operationId, resultOf(submitted).run?.id].filter(
        (id): id is string => typeof id === 'string',
      ),
    );
  // The exit code comes from the typed outcome, never from the printed first line (SM-C M7).
  if (landExitsFailed(final)) process.exitCode = 2;
  else if (!landTerminal(final)) {
    if (!(resultOf(final).phase === 'check' && resultOf(final).run?.status === 'passed')) {
      process.stderr.write(
        budget
          ? `land: ${budget.message}\n`
          : `land: IN PROGRESS; ${observation?.status === 'timeout' ? 'wait deadline reached; ' : ''}${resume ? `keep waiting with: ${resume.waitCommand}` : 'run the same command again to keep waiting.'}\n`,
      );
      process.exitCode = 3;
    }
  }
  return final;
}
