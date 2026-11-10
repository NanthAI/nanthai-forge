// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './shell-quote.js';

/** Agent-mode wait budget: under the 10-minute ceiling of common agent shells
 * (for example a 600 s tool timeout), so a wait returns IN_PROGRESS with its resume
 * command before the caller kills or backgrounds it. Callers raise or lower it
 * with --budget / timeoutSeconds (CLI) or maxWaitMs (MCP). */
export const AGENT_WAIT_SECONDS = 540;

/** Accept a positive budget in seconds, or with an s/m/ms suffix (`540`, `90s`, `9m`). */
export function parseWaitBudget(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const seconds = match[2] === 'ms' ? amount / 1000 : match[2] === 'm' ? amount * 60 : amount;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : undefined;
}

/** Receipt-only continuation: keep the original targets, with no discovery or work IO.
 * The command carries no deadline unless the caller chose one, so it always resumes
 * with the agent-mode budget of whoever runs it. */
export function operationWait(root: string, parameters: Record<string, unknown>) {
  const next = { action: 'wait', ...parameters };
  const { action, ...input } = next;
  const command = `nforge agent ${shellQuote(root)} ${action} ${shellQuote(JSON.stringify(input))}`;
  return {
    next,
    command,
    waitCommand: command,
    inProgress: true,
    instruction:
      'Work is unfinished. Keep this turn active and run command to wait. It returns IN_PROGRESS within its budget; after that or a killed shell, run the same command again; do not submit a new operation. Follow the terminal result and its recovery command before reporting completion.',
  };
}
