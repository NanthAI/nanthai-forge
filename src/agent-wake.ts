// SPDX-License-Identifier: Apache-2.0
import { operationWait } from './agent-operation-wait.js';

/** Settle-wait budget for a background wake: under the 2 h ceiling of common agent
 * background commands (for example Claude Code's 7,200 s), so one wait covers a
 * landing end to end and its exit is the one wake. */
export const WAKE_BUDGET_SECONDS = 7080;

/** How this agent client wakes the agent when a background command exits.
 * `background`: it does (Claude Code), but ending the turn may also end a delegated
 * task, so the turn-end hook still asks once. `trusted`: FORGE_AGENT_WAKE=background-exit,
 * the owner says turn end never ends the task, so a live settle wait covers a stop.
 * FORGE_AGENT_WAKE=off, or a client without background wakes: undefined. */
export type WakeDelivery = 'background' | 'trusted';
export function backgroundWake(env: NodeJS.ProcessEnv = process.env): WakeDelivery | undefined {
  const chosen = env.FORGE_AGENT_WAKE;
  if (chosen === 'off') return undefined;
  if (chosen === 'background-exit') return 'trusted';
  return env.CLAUDE_CODE_SESSION_ID ? 'background' : undefined;
}

/** The one command whose exit wakes the agent when the landing (or check run) settles.
 * `next` is a wait continuation; formatting only, no reads. */
export function wakeContinuation(root: string, next: Record<string, unknown>) {
  // Keep the targets; the action is implied and the settle budget replaces any other.
  const targets = Object.fromEntries(
    Object.entries(next).filter(([key]) => key !== 'action' && key !== 'timeoutSeconds'),
  );
  const wait = operationWait(root, { ...targets, timeoutSeconds: WAKE_BUDGET_SECONDS });
  return {
    ...wait,
    wake: {
      delivery: 'background-exit' as const,
      command: wait.command,
      budgetSeconds: WAKE_BUDGET_SECONDS,
    },
    instruction:
      'Submitted; the landing continues without you. Run command once as a background command (for example Bash run_in_background with a 7200000 ms timeout). It blocks without polling and exits once when the work settles (landed, failed or cancelled, with the receipt) or a note reaches this Lane. If ending your turn ends your task (a delegated or sub-agent run), block on that background command with your harness wait tool; otherwise end the turn or keep working, and its exit wakes you. Do not run status or wait in between. Then follow the receipt.',
  };
}
