// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './agent-brief-render.js';
import { resultOf, landTerminal } from './hosted-land-summary.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { operationWait } from './agent-operation-wait.js';
import { preparingFinishSource, retryableFinishSource } from './hosted-agent-finish-result.js';

const runDone = new Set(['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted']);

/** The single command that resumes the existing selected-target observer without
 * polling. Formatting adds no reads. Undefined once the outcome is final. */
export function landWaitCommand(root: string, response: HostedAgentResponse) {
  return landWaitContinuation(root, response)?.waitCommand;
}

export function landWaitContinuation(root: string, response: HostedAgentResponse) {
  const result = resultOf(response);
  const wait =
    result.phase === 'check' && result.run?.id
      ? runDone.has(result.run.status ?? '')
        ? null
        : { runId: result.run.id }
      : response.operationId &&
          !landTerminal(response) &&
          !retryableFinishSource(result) &&
          (result.phase === 'finish' ||
            // Source preparation outlived the budget: wait replays it by id (never a second landing).
            preparingFinishSource(result as Record<string, unknown>))
        ? { operationIds: [response.operationId], until: 'acceptance' }
        : null;
  return wait ? operationWait(root, wait) : undefined;
}

/** Print the operation identity and its recovery command before blocking. */
export function landAnnouncement(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
  /** The land returns at once and names its background wake when submission ends. */
  wake = false,
) {
  if (!response.operationId) return [];
  const wait = landWaitCommand(root, response);
  if (wake && wait)
    return [`land: operationId ${response.operationId}; submitting, then it continues without you`];
  const recoveryCommand = resultOf(response).command;
  // One first line carries the id and its exact resume command: a backgrounded,
  // redirected or killed client never loses either.
  const resume = wait
    ? `; work is unfinished, keep this turn active; resume with: ${wait}`
    : !landTerminal(response)
      ? `; source preparation is unfinished, keep this turn active; ${recoveryCommand ? 'continue' : 'replay'}: ${landResumeCommand(root, command, response)}`
      : '';
  return [`land: operationId ${response.operationId}${resume}`];
}

/** The one command that continues an unfinished land: its wait once submitted, else the source
 * recovery it returned, else the exact replay of the original finish operation. Formatting only. */
export function landResumeCommand(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
) {
  const wait = landWaitCommand(root, response);
  if (wait) return wait;
  const recoveryCommand = resultOf(response).command;
  if (typeof recoveryCommand === 'string') return recoveryCommand;
  const replay = (resultOf(response) as { replayParameters?: Record<string, unknown> }).replayParameters ?? {
    ...command,
    operationId: response.operationId,
  };
  return `nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify(replay))}`;
}

/** The first line for any other journaled operation (save, sync, start...): its id
 * and the wait that resumes it by exact replay. Formatting only; no reads. */
export function operationLine(root: string, action: string, operationId: string) {
  const { waitCommand } = operationWait(root, { operationIds: [operationId] });
  return `${action}: operationId ${operationId}; resume with: ${waitCommand}`;
}
