// SPDX-License-Identifier: Apache-2.0
import { proofLine, type proofSummarySchema } from './landing-proof.js';
import type { z } from 'zod';
import { checkTerminal, checkUnsuccessful } from './check-run-state.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { scrubText } from './client-error-text.js';
import { shellQuote } from './shell-quote.js';
import { failedErrorChars, failedErrors } from './check-file-summary.js';
import { retryableFinishSource } from './hosted-agent-finish-result.js';
import { holdLines, landingHold } from './hosted-landing-hold.js';
import { syncRequiredSummary } from './hosted-would-conflict.js';
import { acceptedByLine } from './landing-accepted-by.js';
import type { CheckTime } from './hosted-check.js';
import type { LandingStall } from './landing-stall.js';

/** The self-review step a passed preflight names before land (593fc2d7): what will land, by path then hunk. */
export function selfReviewLine(root: string) {
  return `preflight: before land, review what will land: nforge agent ${shellQuote(root)} diff '{"summary":true}' (changed paths), diff '{}' (hunks against the Lane's base)`;
}

/** The land reply's line for a named landing. */
/* Kept here so the CLI loads no schema module for it. */
function checkTimeLine(time: CheckTime) {
  const effect = time.seconds >= 0 ? 'adds about %s runner seconds to' : 'saves about %s runner seconds on';
  const parts = time.tests.map(([file, s]) => `${file} ${s >= 0 ? '+' : ''}${s} s`);
  return (
    `CHECK TIME: this ${time.batch ? 'batch' : 'landing'} ${effect.replace('%s', String(Math.abs(time.seconds)))} every check` +
    ` (${parts.join('; ')}), noise ±${time.noise} s. It does not block.`
  );
}

export const terminalPhases = new Set(['landed', 'terminal-failed']);
type Result = {
  phase?: string;
  saveOperationId?: string;
  progress?: { status?: string } & Record<string, unknown>;
  submission?: {
    id?: string;
    phase?: string;
    observation?: { state: string; pendingReason?: string | null; stall?: LandingStall };
    error?: { code: string; message: string } | null;
    acceptance?: {
      receiptId: string;
      head: string;
      proof?: z.infer<typeof proofSummarySchema>;
      acceptedBy?: { kind: 'person' | 'auto'; actor?: string; note: string };
      checkTime?: CheckTime;
    };
    testFiles?: {
      counts?: { failed: number };
      omitted?: { failed: number };
      failed?: { file: string; report?: { firstError?: string } }[];
    };
  };
  run?: { id?: string; status?: string };
  command?: string;
  /** Paths the landing changes against the Lane's base (null: base manifest not cached). */
  changedPaths?: number | null;
  retryCommand?: string;
  status?: string;
  terminal?: boolean;
  recovery?: {
    command?: string;
    conflict?: { command?: string; instruction?: string; state?: string; laneId?: string; workIn?: string };
  };
  conflict?: { command?: string; instruction?: string; workIn?: string };
  /** A passed entry parked behind an older submission that takes main first. */
  orderWait?: { submissionId?: string; reason?: string };
  reservation?: { until?: string; live?: boolean };
  /** The owner accepted public check logs on this runner: said on every outcome. */
  checkLogs?: string;
  /** A stalled preparation's failed or fenced source step (wait observation). */
  sourceFailure?: unknown;
};
export const resultOf = (response: HostedAgentResponse) => (response.result ?? {}) as Result;
export function landPhase(response: HostedAgentResponse): string | undefined {
  const result = resultOf(response);
  return result.submission?.phase ?? result.phase;
}

/** One line per outcome; failures list each failing file with its first error. A runner whose
 * owner accepted public logs adds that notice as the last line. */
export function landSummary(response: HostedAgentResponse): string[] {
  const checkLogs = resultOf(response).checkLogs;
  const { lines } = classifyLand(response);
  return typeof checkLogs === 'string' && lines.length ? [...lines, checkLogs] : lines;
}
/** What `land` and `wait` decide from (SM-C M7, the smallest typed outcome their exit codes need):
 * the printed lines are prose and may be reworded; the kind is not. Exit 2 is `failed` and
 * `sync-required`; `landed`, `superseded` and every in-progress kind keep their own codes. */
export type LandOutcomeKind =
  | 'landed'
  | 'superseded'
  | 'sync-required'
  | 'held'
  | 'ready'
  | 'check-passed'
  | 'resolved'
  | 'source-recovery'
  | 'failed'
  | 'pending'
  | 'source-pending'
  | 'other';
export const landOutcomeKind = (response: HostedAgentResponse) => classifyLand(response).kind;
/** True for an outcome that needs action and ends the wait: a failed landing or one needing a sync. */
export const landNeedsAction = (kind: LandOutcomeKind) => kind === 'failed' || kind === 'sync-required';
/** True when `land` and `wait` exit 2 for this reply: a failed landing, or one that needs a sync. */
export const landExitsFailed = (response: HostedAgentResponse) =>
  landPhase(response) === 'terminal-failed' || landNeedsAction(landOutcomeKind(response));
function classifyLand(response: HostedAgentResponse): { kind: LandOutcomeKind; lines: string[] } {
  const out = (kind: LandOutcomeKind, lines: string[]) => ({ kind, lines });
  const result = resultOf(response),
    submission = result.submission;
  const phase = landPhase(response);
  if (phase === 'landed')
    return out('landed', [
      `LANDED${submission?.acceptance ? ` receipt ${submission.acceptance.receiptId}` : ''}${
        typeof result.changedPaths === 'number'
          ? `, ${result.changedPaths} changed path${result.changedPaths === 1 ? '' : 's'}`
          : ''
      }`,
      // A person's acceptance or policy's, never inferred from the submitter (fe5bea80).
      ...(submission?.acceptance?.proof ? [proofLine(submission.acceptance.proof)] : []),
      ...(submission?.acceptance?.acceptedBy ? [acceptedByLine(submission.acceptance.acceptedBy)] : []),
      ...(submission?.acceptance?.checkTime ? [checkTimeLine(submission.acceptance.checkTime)] : []),
    ]);
  if (submission?.observation?.state === 'superseded' || phase === 'superseded')
    return out('superseded', [
      'SUPERSEDED; this operation does not land the newer saved head. Use its current Lane status before continuing.',
    ]);
  // Queued, but main already took files it changes (f7539ebb): say so with the one recovery.
  const sync = (result as { syncRequired?: { paths: string[]; more: number } }).syncRequired;
  if (sync && submission?.observation?.state === 'pending')
    return out('sync-required', [
      `SYNC REQUIRED; not landed: ${syncRequiredSummary(sync)}`,
      ...(result.command ? [`Continue recovery: ${result.command}`] : []),
    ]);
  // A held landing is neither queued nor stranded (5c59940b): name the hold and who releases it.
  const replay = (result as { replayParameters?: { laneId?: unknown } }).replayParameters;
  const hold = landingHold(submission, typeof replay?.laneId === 'string' ? replay.laneId : undefined);
  if (hold) return out('held', holdLines(hold));
  // A passed check is not a landing, and a queued landing is not a failure: say which.
  if (phase === 'ready' && submission?.observation?.state !== 'terminal-failed')
    return out('ready', [
      result.orderWait?.submissionId
        ? result.orderWait.reason === 'reservation'
          ? `CHECK PASSED; not landed yet: submission ${result.orderWait.submissionId} reserved files this change touches; it lands first or its reservation ends`
          : `CHECK PASSED; not landed yet: waiting for older submission ${result.orderWait.submissionId} to take main first`
        : result.reservation?.live
          ? `CHECK PASSED; queued to land first on its reserved files (reserved until ${result.reservation.until})`
          : 'CHECK PASSED; queued to land, not landed yet (waiting for acceptance)',
    ]);
  if (result.phase === 'check' && result.run?.status === 'passed')
    return out('check-passed', ['CHECK PASSED (check only; this command does not land)']);
  // The conflict's resolution Lane already completed: its landing carried this work.
  if (result.recovery?.conflict?.state === 'completed')
    return out('resolved', [
      `RESOLVED in Lane ${result.recovery.conflict.laneId}; this conflicted landing needs nothing more`,
    ]);
  if (retryableFinishSource(result) && result.command)
    return out('source-recovery', ['SOURCE NEEDS RECOVERY', `Continue recovery: ${result.command}`]);
  const lines: string[] = [];
  let failed = false;
  const error = submission?.error;
  // A withdrawn landing: replaying its operationId only returns this state again (593fc2d7).
  if (phase === 'terminal-failed' && error?.code === 'LANDING_CANCELLED')
    return out('failed', [
      `CANCELLED: this landing was withdrawn; nothing landed${response.operationId ? `. Its operationId ${response.operationId} is spent: replaying it returns this cancelled state` : ''}`,
      `Submit again as a new operation: ${result.retryCommand ?? "nforge agent ROOT land --save '{}' with no operationId"}`,
    ]);
  const recovery =
    result.recovery?.conflict?.instruction ??
    result.recovery?.conflict?.command ??
    result.recovery?.command ??
    result.conflict?.instruction ??
    result.conflict?.command;
  if (
    phase === 'terminal-failed' ||
    error ||
    result.status === 'failed' ||
    checkUnsuccessful(result.run?.status ?? '')
  ) {
    failed = true;
    lines.push(
      `FAILED${error ? ` ${error.code}: ${(recovery ? error.message.split(' Run nforge agent ')[0]! : error.message).replace(/\s+/g, ' ').slice(0, 900)}` : ''}`,
    );
  }
  if (result.phase === 'conflict') {
    failed = true;
    lines.push('FAILED COMPOSITION_CONFLICT');
  }
  if (!lines.length && submission?.observation?.state === 'pending' && !recovery)
    return out('pending', [
      `${pendingLabel(submission.observation.pendingReason)}; not landed yet`,
      // A stalled landing names the stall and its source failure (friction c7f3afac).
      ...(landingStallReport(result)?.lines ?? []),
    ]);
  // One line: which folder to work in now, and why (the same folder after an in-place resolution).
  const workIn = result.recovery?.conflict?.workIn ?? result.conflict?.workIn;
  if (workIn) lines.push(workIn);
  if (recovery) lines.push(`Continue recovery: ${recovery}`);
  else if (result.retryCommand) lines.push(`Retry: ${result.retryCommand}`);
  if (!lines.length && ['save', 'compose', 'sync'].includes(result.phase ?? ''))
    return out('source-pending', [
      'SOURCE PENDING',
      ...(result.command ? [`Continue: ${result.command}`] : []),
    ]);
  // The failure message names its first file and counts the rest; list every other failing file with
  // its first error, bounded (failedErrors files of failedErrorChars), then one "N more" line.
  const failedFiles = submission?.testFiles?.failed ?? [];
  const others = failedFiles.filter(item => !error?.message.includes(item.file));
  const named = failedFiles.length - others.length,
    shown = others.slice(0, Math.max(failedErrors - named, 0));
  for (const file of shown)
    lines.push(
      `  ${scrubText(file.file, 200)}${file.report?.firstError ? ` :: ${scrubText(file.report.firstError.replace(/\s+/g, ' '), failedErrorChars)}` : ''}`,
    );
  const more =
    Math.max(failedFiles.length, submission?.testFiles?.counts?.failed ?? 0) - named - shown.length;
  if (more > 0) {
    const label = submission?.testFiles?.omitted?.failed ? 'run details' : 'all names';
    lines.push(
      `  ... ${more} more failing file${more === 1 ? '' : 's'}${response.operationId ? `; ${label}: nforge agent ROOT status '{"operationId":"${response.operationId}"}' --detail` : `; ${label}: status --detail`}`,
    );
  }
  return out(failed ? 'failed' : 'other', lines);
}

const pendingLabels: Record<string, string> = {
  queued: 'QUEUED',
  checking: 'CHECKING',
  'waiting-for-review': 'WAITING FOR REVIEW',
  'waiting-for-dependency': 'WAITING FOR DEPENDENCY',
  'pending-infra': 'WAITING FOR CHECK INFRASTRUCTURE',
};
const pendingLabel = (reason: string | null | undefined) => pendingLabels[reason ?? ''] ?? 'IN PROGRESS';

/** Requested landings settle on canonical acceptance/failure, never check readiness. */
export function landTerminal(response: HostedAgentResponse) {
  const result = resultOf(response);
  if (result.terminal === true) return true;
  if (result.phase === 'check') return checkTerminal(result.run?.status ?? '');
  if (result.submission?.observation) return result.submission.observation.state !== 'pending';
  return terminalPhases.has(landPhase(response) ?? '');
}

type SourceFailure = {
  step?: number;
  code?: string;
  stage?: string;
  attempts?: number;
  maxAttempts?: number;
  retryAt?: string;
};
/** What a waiting agent is told about a stalled landing (friction c7f3afac: a landing wait stayed
 * silent for 2 h while its compose step had failed). The stall, the source step's recorded failure
 * when the server sent one, and, for a stalled preparation, the replay of the original land request
 * (same operationId), which reports or continues its source recovery, and the sync that shortens a
 * far-behind Lane's merge. Formatting only; no reads. */
export function landingStallReport(
  entry: { submission?: unknown; sourceFailure?: unknown },
  replay?: { root: string; action: string; command: Record<string, unknown>; operationId: string },
) {
  const stall = (entry.submission as { observation?: { stall?: LandingStall } | null } | null | undefined)
    ?.observation?.stall;
  if (!stall) return undefined;
  const failure = (entry.sourceFailure ?? undefined) as SourceFailure | undefined;
  const replayCommand =
    replay && stall.step === 'composing'
      ? `nforge agent ${shellQuote(replay.root)} ${replay.action} ${shellQuote(
          JSON.stringify({ ...replay.command, operationId: replay.operationId }),
        )}`
      : undefined;
  const lines = [`STALLED ${stall.code}: ${stall.message}`];
  if (failure?.code)
    lines.push(
      `Source step ${failure.step ?? '?'} failed: ${failure.code}${failure.stage ? ` at ${failure.stage}` : ''}` +
        (failure.attempts ? ` (attempt ${failure.attempts} of ${failure.maxAttempts ?? '?'})` : '') +
        (failure.retryAt ? `; next try from ${failure.retryAt}` : '') +
        '. The server retries it by itself.',
    );
  if (replayCommand)
    lines.push(`Replay the original land request to see or continue its recovery: ${replayCommand}`);
  // A Lane far behind main composes a large merge, which slow storage stalls first (Item e62d834b).
  const laneId = replay && stall.step === 'composing' ? replay.command.laneId : undefined;
  if (typeof laneId === 'string')
    lines.push(
      `If the Lane is far behind main, sync it onto main and land again: nforge agent ${shellQuote(
        replay!.root,
      )} sync ${shellQuote(JSON.stringify({ laneId }))}`,
    );
  return {
    lines,
    stall: {
      ...stall,
      ...(failure ? { sourceFailure: failure } : {}),
      ...(replayCommand ? { replayCommand } : {}),
    },
  };
}
