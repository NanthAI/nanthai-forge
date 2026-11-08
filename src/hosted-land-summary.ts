// SPDX-License-Identifier: Apache-2.0
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { scrubText } from './client-error-text.js';
import { failedErrorChars, failedErrors } from './check-file-summary.js';
import { retryableFinishSource } from './hosted-agent-finish-result.js';

export const terminalPhases = new Set(['landed', 'terminal-failed']);
type Result = {
  phase?: string;
  saveOperationId?: string;
  progress?: { status?: string } & Record<string, unknown>;
  submission?: {
    phase?: string;
    observation?: { state: string; pendingReason?: string | null };
    error?: { code: string; message: string } | null;
    acceptance?: { receiptId: string; head: string };
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
  orderWait?: { submissionId?: string };
};
export const resultOf = (response: HostedAgentResponse) => (response.result ?? {}) as Result;
export function landPhase(response: HostedAgentResponse): string | undefined {
  const result = resultOf(response);
  return result.submission?.phase ?? result.phase;
}

/** One line per outcome; failures list each failing file with its first error. */
export function landSummary(response: HostedAgentResponse): string[] {
  const result = resultOf(response),
    submission = result.submission;
  const phase = landPhase(response);
  if (phase === 'landed')
    return [
      `LANDED${submission?.acceptance ? ` receipt ${submission.acceptance.receiptId}` : ''}${
        typeof result.changedPaths === 'number'
          ? `, ${result.changedPaths} changed path${result.changedPaths === 1 ? '' : 's'}`
          : ''
      }`,
    ];
  if (submission?.observation?.state === 'superseded' || phase === 'superseded')
    return [
      'SUPERSEDED; this operation does not land the newer saved head. Use its current Lane status before continuing.',
    ];
  // A passed check is not a landing, and a queued landing is not a failure: say which.
  if (phase === 'ready' && submission?.observation?.state !== 'terminal-failed')
    return [
      result.orderWait?.submissionId
        ? `CHECK PASSED; not landed yet: waiting for older submission ${result.orderWait.submissionId} to take main first`
        : 'CHECK PASSED; queued to land, not landed yet (waiting for acceptance)',
    ];
  if (result.phase === 'check' && result.run?.status === 'passed')
    return ['CHECK PASSED (check only; this command does not land)'];
  // The conflict's resolution Lane already completed: its landing carried this work.
  if (result.recovery?.conflict?.state === 'completed')
    return [
      `RESOLVED in Lane ${result.recovery.conflict.laneId}; this conflicted landing needs nothing more`,
    ];
  if (retryableFinishSource(result) && result.command)
    return ['SOURCE NEEDS RECOVERY', `Continue recovery: ${result.command}`];
  const lines: string[] = [];
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
    ['failed', 'cancelled', 'runner-unavailable', 'interrupted'].includes(result.run?.status ?? '')
  )
    lines.push(
      `FAILED${error ? ` ${error.code}: ${(recovery ? error.message.split(' Run nforge agent ')[0]! : error.message).replace(/\s+/g, ' ').slice(0, 900)}` : ''}`,
    );
  if (result.phase === 'conflict') lines.push('FAILED COMPOSITION_CONFLICT');
  if (!lines.length && submission?.observation?.state === 'pending' && !recovery)
    return [`${pendingLabel(submission.observation.pendingReason)}; not landed yet`];
  // One line: which folder to work in now, and why (the same folder after an in-place resolution).
  const workIn = result.recovery?.conflict?.workIn ?? result.conflict?.workIn;
  if (workIn) lines.push(workIn);
  if (recovery) lines.push(`Continue recovery: ${recovery}`);
  else if (result.retryCommand) lines.push(`Retry: ${result.retryCommand}`);
  if (!lines.length && ['save', 'compose', 'sync'].includes(result.phase ?? ''))
    return ['SOURCE PENDING', ...(result.command ? [`Continue: ${result.command}`] : [])];
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
  return lines;
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
  if (result.phase === 'check')
    return ['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted'].includes(
      result.run?.status ?? '',
    );
  if (result.submission?.observation) return result.submission.observation.state !== 'pending';
  return terminalPhases.has(landPhase(response) ?? '');
}
