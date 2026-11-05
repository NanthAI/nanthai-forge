// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './agent-brief-render.js';

export const WAIT_COMMAND_SECONDS = 3600;

/** Receipt-only continuation: keep the original targets, with no discovery or work IO. */
export function operationWait(root: string, parameters: Record<string, unknown>) {
  const next = {
    action: 'wait',
    ...parameters,
    timeoutSeconds: parameters.timeoutSeconds ?? WAIT_COMMAND_SECONDS,
  };
  const { action, ...input } = next;
  const command = `nforge agent ${shellQuote(root)} ${action} ${shellQuote(JSON.stringify(input))}`;
  return {
    next,
    command,
    waitCommand: command,
    inProgress: true,
    instruction:
      'Work is unfinished. Keep this turn active and run command to wait. After a killed shell or wait deadline, run the same wait again; do not submit a new operation. Follow the terminal result and its recovery command before reporting completion.',
  };
}
