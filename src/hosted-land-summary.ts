// SPDX-License-Identifier: Apache-2.0
import { checkTerminal, checkUnsuccessful } from './check-run-state.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { scrubText } from './client-error-text.js';
import { failedErrorChars, failedErrors } from './check-file-summary.js';
import { retryableFinishSource } from './hosted-agent-finish-result.js';
import { holdLines, landingHold } from './hosted-landing-hold.js';
import { syncRequiredSummary } from './hosted-would-conflict.js';
import { acceptedByLine } from './landing-accepted-by.js';

export const terminalPhases = new Set(['landed', 'terminal-failed']);
type Result = {
  phase?: string;
  saveOperationId?: string;
  progress?: { status?: string } & Record<string, unknown>;
  submission?: {
    id?: string;
    phase?: string;
    observation?: { state: string; pendingReason?: string | null };
    error?: { code: string; message: string } | null;
    acceptance?: {
      receiptId: string;
      head: string;
      acceptedBy?: { kind: 'person' | 'auto'; actor?: string; note: string };
    };
    testFiles?: {
      counts?: { failed: number };
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
      ...(submission?.acceptance?.acceptedBy ? [acceptedByLine(submission.acceptance.acceptedBy)] : []),
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
    return out('pending', [`${pendingLabel(submission.observation.pendingReason)}; not landed yet`]);
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
  if (more > 0)
    lines.push(
      `  ... ${more} more failing file${more === 1 ? '' : 's'}${response.operationId ? `; all names: nforge agent ROOT status '{"operationId":"${response.operationId}"}' --detail` : '; all names: status --detail'}`,
    );
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
