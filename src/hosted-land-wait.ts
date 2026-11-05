// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './agent-brief-render.js';
import { resultOf, landTerminal } from './hosted-land-summary.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { operationWait } from './agent-operation-wait.js';
import { stoppedFinishSource } from './hosted-agent-finish-result.js';
export { WAIT_COMMAND_SECONDS } from './agent-operation-wait.js';

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
      : result.phase === 'finish' &&
          response.operationId &&
          !landTerminal(response) &&
          !stoppedFinishSource(result)
        ? { operationIds: [response.operationId], until: 'acceptance' }
        : null;
  return wait ? operationWait(root, wait) : undefined;
}

/** Print the operation identity and its recovery command before blocking. */
export function landAnnouncement(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
) {
  if (!response.operationId) return [];
  const wait = landWaitCommand(root, response);
  return [
    `land: operationId ${response.operationId}`,
    ...(wait
      ? [`land: work is unfinished; keep this turn active. Resume after interruption with: ${wait}`]
      : !landTerminal(response)
        ? [
            `land: source preparation is unfinished; replay: nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify((resultOf(response) as { replayParameters?: Record<string, unknown> }).replayParameters ?? { ...command, operationId: response.operationId }))}`,
          ]
        : []),
  ];
}
