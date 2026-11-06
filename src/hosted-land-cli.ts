// SPDX-License-Identifier: Apache-2.0
import { waitEventLine } from './hosted-wait-line.js';
import { clientCacheRoot } from './root-paths.js';
import { isNetworkPending } from './network-continuation.js';
import { normalizeHostedFinishResult, retryableFinishSource } from './hosted-agent-finish-result.js';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { HostedAgentTransport, type HostedAgentResponse } from './hosted-agent-transport.js';
import { hostedAgentCli } from './hosted-agent-cli.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { followLocalOperation } from './hosted-agent-wait-local.js';
import { observeHostedRun } from './hosted-agent-observe.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { readClientSettings } from './client-settings.js';
import { withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landPhase, landSummary, resultOf, landTerminal } from './hosted-land-summary.js';
import {
  landAnnouncement,
  landResumeCommand,
  landWaitCommand,
  landWaitContinuation,
} from './hosted-land-wait.js';
import { recordTurnWait, settleTurnWork } from './agent-turn-work.js';
import { markOverlapShown, overlapBannerOnce, type HostedOverlapNotice } from './hosted-overlap-notice.js';
import { LAND_INVOKED_ENV, landTiming, landTimingLine, startLandTiming } from './land-timing.js';
import { AGENT_WAIT_SECONDS } from './agent-operation-wait.js';
import { waitFailure } from './wait-failure.js';

export { landPhase, landSummary };

/** Set in the detached submitter; it submits and exits without waiting. */
export const LAND_CHILD_ENV = 'FORGE_LAND_CHILD';
/** The land command's budget in seconds, passed to its detached submitter. */
const LAND_BUDGET_ENV = 'FORGE_LAND_BUDGET_SECONDS';
/** Default: the agent wait budget, so a foreground land returns IN_PROGRESS with its resume
 * command before a 600 s agent shell backgrounds or kills it. */
function landBudgetSeconds() {
  const chosen = Number(process.env[LAND_BUDGET_ENV]);
  return Number.isFinite(chosen) && chosen > 0 ? chosen : AGENT_WAIT_SECONDS;
}
const noticeOf = (response: HostedAgentResponse) =>
  (response as { overlapNotice?: HostedOverlapNotice }).overlapNotice;
/** Immediate stderr progress for a submitted landing: operation id, replay and wait commands, overlap banner. */
function announce(root: string, command: Record<string, unknown>, response: HostedAgentResponse) {
  for (const line of landAnnouncement(root, command, response)) process.stderr.write(`${line}\n`);
  const notice = noticeOf(response);
  if (notice) process.stderr.write(overlapBannerOnce(notice));
}

/** The submitter: replays finish while its save job is still running, so compose and submission
 * never wait for the agent to call again. Bounded; every replay reuses the same retained operation. */
export async function submitHostedLand(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  rounds = 30,
) {
  const invokedAt = Number(process.env[LAND_INVOKED_ENV]);
  startLandTiming(invokedAt);
  // The submitter shares the land command's budget, timed from when that command started.
  const deadline = (Number.isFinite(invokedAt) ? invokedAt : Date.now()) + landBudgetSeconds() * 1000;
  let response = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  // The first receipt already carries the operation id and any overlap notice: show them now, not at exit.
  announce(transport.root ?? root, command, response);
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
  // Where the time before submission went: in the receipt, and one line for people.
  const timing = landTiming();
  if (!timing) return response;
  const line = landTimingLine(timing);
  if (line) process.stderr.write(`${line}\n`);
  return { ...response, landTiming: timing };
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
): Promise<HostedAgentResponse | null> {
  const directory = join(clientCacheRoot(hostedAgentRoot(root)), 'agent', 'land');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, randomUUID()),
    out = openSync(`${base}.out`, 'w', 0o600),
    err = openSync(`${base}.err`, 'w', 0o600);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./cli-entry.js', import.meta.url)),
      'agent',
      root,
      'finish',
      JSON.stringify(command),
    ],
    {
      detached: true,
      stdio: ['ignore', out, err],
      // The submitter times from when this command started, not from its own spawn.
      env: {
        ...process.env,
        [LAND_CHILD_ENV]: '1',
        [LAND_INVOKED_ENV]: String(performance.timeOrigin),
        [LAND_BUDGET_ENV]: String(budgetSeconds),
      },
    },
  );
  closeSync(out);
  closeSync(err);
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
    process.exitCode = code || 1;
    return null;
  }
  const response = JSON.parse(line) as HostedAgentResponse;
  if (code === 3) process.exitCode = 3;
  // The relayed stderr already showed this notice; the final banner must not repeat it.
  const notice = noticeOf(response);
  if (notice) markOverlapShown(notice);
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
    if (result.phase === 'check' && result.run?.id)
      return await observeHostedRun(
        transport,
        { runId: result.run.id, timeoutSeconds },
        controller.signal,
        emit,
      );
    else if (response.operationId) {
      const selection = { operationIds: [response.operationId], timeoutSeconds, until: 'acceptance' };
      try {
        return await observeHostedSubmissions(transport, selection, controller.signal, emit);
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
  // One budget for the whole command (submission and wait), from when it started.
  const budgetSeconds = options.timeoutSeconds ?? AGENT_WAIT_SECONDS,
    deadline = Date.now() + budgetSeconds * 1000;
  const submitted =
    options.detach === false
      ? await submitHostedLand(root, command, address)
      : await detachedSubmit(root, command, budgetSeconds);
  if (!submitted) return undefined;
  if (isNetworkPending(submitted)) return submitted;
  const wait = options.wait ?? readClientSettings().landWait;
  const sourceNeedsRecovery = retryableFinishSource(resultOf(submitted));
  if (
    !wait ||
    landTerminal(submitted) ||
    sourceNeedsRecovery ||
    ['conflict', 'save', 'compose', 'sync'].includes(String(resultOf(submitted).phase))
  ) {
    const lines = landSummary(submitted);
    for (const line of lines) process.stderr.write(`${line}\n`);
    // Not waiting here: an unfinished landing still names the one command that waits for it.
    const next = lines[0]?.startsWith('FAILED')
      ? undefined
      : landWaitCommand(hostedAgentRoot(root), submitted);
    if (next) process.stderr.write(`Next: wait for the outcome with ${next}\n`);
    if (lines[0]?.startsWith('FAILED')) process.exitCode = 2;
    else if (
      wait &&
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
    const resume =
      next && !lines[0]?.startsWith('FAILED')
        ? landWaitContinuation(hostedAgentRoot(root), submitted)
        : undefined;
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
  const observation = finished?.result as
    | {
        status?: string;
        run?: unknown;
        submissions?: { submission: unknown; recovery?: unknown; conflict?: unknown }[];
      }
    | undefined;
  const final: HostedAgentResponse = {
    ...submitted,
    result: normalizeHostedFinishResult(
      transport.root ?? root,
      (submitted.result as { replayParameters?: Record<string, unknown> }).replayParameters ?? {
        ...command,
        operationId: submitted.operationId,
      },
      {
        ...(submitted.result as Record<string, unknown>),
        ...(observation?.run ? { run: observation.run } : {}),
        ...(observation?.submissions?.[0] ? observation.submissions[0] : {}),
        ...(observation?.status && observation.status !== 'terminal'
          ? { waitStatus: observation.status, inProgress: true }
          : {}),
      },
    ),
  };
  const lines = landSummary(final);
  for (const line of lines) process.stderr.write(`${line}\n`);
  const resumeWith = landWaitContinuation(transport.root ?? root, final)?.next;
  if (resumeWith) recordTurnWait(transport.root ?? root, resumeWith, null);
  else
    settleTurnWork(
      [submitted.operationId, resultOf(submitted).run?.id].filter(
        (id): id is string => typeof id === 'string',
      ),
    );
  const outcome = landPhase(final);
  if (outcome === 'terminal-failed' || lines[0]?.startsWith('FAILED')) process.exitCode = 2;
  else if (!landTerminal(final)) {
    if (!(resultOf(final).phase === 'check' && resultOf(final).run?.status === 'passed')) {
      const resume = landWaitCommand(transport.root ?? root, final);
      process.stderr.write(
        `land: IN PROGRESS; ${observation?.status === 'timeout' ? 'wait deadline reached; ' : ''}${resume ? `keep waiting with: ${resume}` : 'run the same command again to keep waiting.'}\n`,
      );
      process.exitCode = 3;
    }
  }
  return final;
}
