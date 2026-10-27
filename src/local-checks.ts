import { hostedPaths } from './hosted-paths.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import type { CoordinationTransport } from './coordination-client.js';
import { AgentWorkflow } from './agent-workflow.js';
import { ForgeError, invariant } from './errors.js';
import { runReceipt } from './agent-receipts.js';
import type { CheckRun } from './work-types.js';

export const localCheckRequest = z.object({
  projectId: z.string(),
  operationId: z.uuid(),
  runnerId: z.string(),
  viewId: z.uuid(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  checkId: z.uuid(),
  definition: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['queued', 'claimed', 'finished']),
  cancelRequested: z.boolean(),
});
type Selection = { projectId: string; runnerId: string; operationId: string };
type Report = {
  status:
    | 'queued'
    | 'preparing'
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'runner-unavailable'
    | 'runner-budget-exhausted'
    | 'error';
  runId: string | null;
  environmentFingerprint: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  message: string;
};
export const checkReference = <T extends 'query' | 'mutation'>(type: T, name: string) => {
  void type;
  return makeFunctionReference<T>(`projectCheckRequests:${name}`);
};

/** Hosted requests carry pins only. The existing Work owner launches and retains the original command. */
export async function executeLocalCheck(
  root: string,
  client: CoordinationTransport,
  selection: Selection,
  signal?: AbortSignal,
): Promise<void> {
  const claimed = localCheckRequest.parse(
    await client.mutation(checkReference('mutation', 'claim'), selection),
  );
  if (
    claimed.projectId !== selection.projectId ||
    claimed.runnerId !== selection.runnerId ||
    claimed.operationId !== selection.operationId
  )
    throw new ForgeError(
      'EVIDENCE_CHANGED',
      'The claimed request differs from its selected runner and operation.',
    );
  if (claimed.state === 'finished') return;
  const agent = new AgentWorkflow(root);
  const publish = (report: Report) =>
    client.mutation(checkReference('mutation', 'update'), { ...selection, report: hostedPaths(report) });
  const noRun = (status: 'error' | 'cancelled', message: string) =>
    publish({
      status,
      runId: null,
      environmentFingerprint: null,
      startedAt: null,
      endedAt: new Date().toISOString(),
      exitCode: null,
      message,
    });
  const matches = (run: CheckRun) =>
    run.viewId === claimed.viewId &&
    run.head === claimed.head &&
    run.check.id === claimed.checkId &&
    run.check.definition === claimed.definition;
  const original = agent.work.store.select('runs', claimed.operationId);
  if (original && !matches(original)) {
    await noRun(
      'error',
      'This operation already belongs to a different local Candidate or check. Its original evidence is preserved.',
    );
    return;
  }
  signal?.throwIfAborted();
  if (claimed.cancelRequested && !agent.work.store.select('runs', claimed.operationId)) {
    await noRun('cancelled', 'Cancelled before execution.');
    return;
  }
  try {
    await agent.dispatch({
      action: 'run',
      operationId: claimed.operationId,
      viewId: claimed.viewId,
      expectedHead: claimed.head,
      checkId: claimed.checkId,
      expectedDefinition: claimed.definition,
      wait: false,
    });
  } catch (error) {
    if (!agent.work.store.select('runs', claimed.operationId)) {
      if (!(error instanceof ForgeError) || error.code === 'WORK_BUSY') throw error;
      await noRun('error', error.message);
      return;
    }
  }
  for (;;) {
    signal?.throwIfAborted();
    const current = localCheckRequest.parse(
      await client.query(checkReference('query', 'observe'), selection),
    );
    invariant(
      current.projectId === claimed.projectId &&
        current.operationId === claimed.operationId &&
        current.runnerId === claimed.runnerId,
      'EVIDENCE_CHANGED',
      'The observed request differs from the original selection.',
    );
    if (current.cancelRequested) await agent.dispatch({ action: 'cancel', operationId: claimed.operationId });
    await agent.dispatch({ action: 'observe', operationId: claimed.operationId, waitMs: 1000 });
    const run = agent.work.store.select('runs', claimed.operationId)!;
    invariant(
      run && matches(run),
      'EVIDENCE_CHANGED',
      'The retained run differs from the requested source or check.',
    );
    const receipt = runReceipt(run),
      active = receipt.status === 'queued' || receipt.status === 'running' || receipt.status === 'preparing';
    await publish({
      status: receipt.status,
      runId: receipt.runId,
      environmentFingerprint: receipt.environmentFingerprint,
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      exitCode: receipt.exitCode,
      message:
        receipt.diagnostic ??
        (receipt.status === 'queued'
          ? 'Queued for machine-wide check capacity.'
          : active
            ? 'Executing the selected local check.'
            : 'Original local check outcome retained.'),
    });
    if (!active) return;
  }
}
