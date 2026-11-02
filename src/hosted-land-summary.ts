// SPDX-License-Identifier: Apache-2.0
import type { HostedAgentResponse } from './hosted-agent-transport.js';

export const terminalPhases = new Set(['landed', 'terminal-failed']);
type Result = {
  phase?: string;
  saveOperationId?: string;
  progress?: { status?: string } & Record<string, unknown>;
  submission?: {
    phase?: string;
    observation?: { state: string };
    error?: { code: string; message: string } | null;
    acceptance?: { receiptId: string; head: string };
    testFiles?: {
      counts?: { failed: number };
      failed?: { file: string; report?: { firstError?: string } }[];
    };
  };
  run?: { id?: string; status?: string };
  command?: string;
  recovery?: { command?: string; conflict?: { command?: string } };
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
    return [`LANDED${submission?.acceptance ? ` receipt ${submission.acceptance.receiptId}` : ''}`];
  if (phase === 'ready')
    return [submission ? 'CHECK PASSED; waiting for acceptance' : 'CHECK PASSED (not landed)'];
  if (result.phase === 'check' && result.run?.status === 'passed') return ['CHECK PASSED (not landed)'];
  if (['save', 'compose', 'sync'].includes(result.phase ?? ''))
    return ['SOURCE PENDING', ...(result.command ? [`Continue: ${result.command}`] : [])];
  const lines: string[] = [];
  const error = submission?.error;
  const recovery = result.recovery?.conflict?.command ?? result.recovery?.command;
  if (phase === 'terminal-failed' || error || result.run?.status === 'failed')
    lines.push(
      `FAILED${error ? ` ${error.code}: ${(recovery ? error.message.split(' Run nforge agent ')[0]! : error.message).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
    );
  if (result.phase === 'conflict') lines.push('FAILED COMPOSITION_CONFLICT');
  if (recovery) lines.push(`Continue recovery: ${recovery}`);
  for (const file of submission?.testFiles?.failed?.slice(0, 20) ?? [])
    lines.push(
      `  ${file.file}${file.report?.firstError ? ` :: ${file.report.firstError.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
    );
  const more = (submission?.testFiles?.counts?.failed ?? 0) - 20;
  if (more > 0) lines.push(`  ... ${more} more failing files`);
  return lines;
}

/** Requested landings settle on canonical acceptance/failure, never check readiness. */
export function landTerminal(response: HostedAgentResponse) {
  const result = resultOf(response);
  if (result.phase === 'check')
    return ['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted'].includes(
      result.run?.status ?? '',
    );
  if (result.submission?.observation) return result.submission.observation.state !== 'pending';
  return terminalPhases.has(landPhase(response) ?? '');
}
