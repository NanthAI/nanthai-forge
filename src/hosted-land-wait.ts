// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './agent-brief-render.js';
import { landPhase, resultOf, terminalPhases } from './hosted-land-summary.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';

const runDone = new Set(['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted']);
/** A wake-driven wait stops after this long; the printed command is simply run again to resume. */
export const WAIT_COMMAND_SECONDS = 3600;

/** The single command that resumes waiting for a pending landing or check: one server read per
 * wake from the existing subscription, never a polling loop. Undefined once the outcome is final. */
export function landWaitCommand(root: string, response: HostedAgentResponse) {
  const result = resultOf(response),
    phase = landPhase(response);
  const wait =
    result.phase === 'check' && result.run?.id
      ? runDone.has(result.run.status ?? '')
        ? null
        : { runId: result.run.id }
      : result.phase === 'finish' && response.operationId && !(phase && terminalPhases.has(phase))
        ? { operationIds: [response.operationId] }
        : null;
  return wait
    ? `nforge agent ${shellQuote(root)} wait ${shellQuote(JSON.stringify({ ...wait, timeoutSeconds: WAIT_COMMAND_SECONDS }))}`
    : undefined;
}

/** Progress for the agent's terminal as soon as a landing is submitted: id, replay and wait commands. */
export function landAnnouncement(
  root: string,
  command: Record<string, unknown>,
  response: HostedAgentResponse,
) {
  if (!response.operationId) return [];
  const wait = landWaitCommand(root, response);
  return [
    `land: operationId ${response.operationId} (replay with: nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify({ ...(command.laneId ? { laneId: command.laneId } : {}), operationId: response.operationId }))})`,
    ...(wait ? [`land: to keep waiting, run: ${wait}`] : []),
  ];
}
