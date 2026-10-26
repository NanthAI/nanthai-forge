// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkflow } from './agent-workflow.js';
import type { Lane } from './work-types.js';
import { retainedFinishCommand } from './agent-finish-journal.js';
import { invariant } from './errors.js';

/** The alias retains agent finish's original pins; a UUID retry never selects newer source. */
export async function mergeLane(agent: AgentWorkflow, lane: Lane, values: Record<string, string>) {
  const store = agent.work.store,
    intent = store.select('intents', lane.intentId),
    message = values['--subject'] ?? intent?.outcome ?? lane.name,
    operationId = values['--operation-id'],
    retained = operationId ? retainedFinishCommand(store, operationId) : undefined;
  if (retained) {
    invariant(
      retained.action === 'finish' &&
        !!retained.accept &&
        retained.laneId === lane.id &&
        retained.message === message &&
        (!values['--match-head-commit'] || retained.expectedHead === values['--match-head-commit']),
      'WORK_OPERATION_CHANGED',
      'Reconcile the original merge request with the same Lane, subject and head.',
    );
  }
  const receipt = (
    await agent.dispatch(
      retained ?? {
        action: 'finish',
        laneId: lane.id,
        message,
        accept: { channel: intent?.baseChannel?.name ?? 'main' },
        ...(operationId ? { operationId } : {}),
        ...(values['--match-head-commit'] ? { expectedHead: values['--match-head-commit'] } : {}),
      },
    )
  ).result as Record<string, unknown>;
  const resolved = receipt.resolved as { operationId?: string } | undefined;
  if (!receipt.complete) process.exitCode = 1;
  return {
    laneId: lane.id,
    operationId: receipt.operationId ?? resolved?.operationId ?? operationId ?? null,
    complete: receipt.complete ?? false,
    status: receipt.status ?? null,
    phase: receipt.phase ?? null,
    acceptance: receipt.acceptance ?? null,
    view: receipt.view ?? null,
    check: receipt.run ?? null,
    receipt,
  };
}
