import { isMachineRunner } from '../src/hosted-machine-runner';
// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { loadHostedCheck, writeHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import { hostedOperationRow } from './projectHostedOperations';
import {
  completeHostedOperation,
  hostedOperationSchema,
  canonicalPayload,
} from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { checkPin, hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';

export const macLeaseMs = 60_000;
const expireRef = makeFunctionReference<'mutation', CheckIdentity & { fence: number; until: number }, null>(
  'projectHostedCheckLease:expire',
);
export async function watchMacLease(ctx: MutationCtx, run: HostedCheckRun, now = Date.now()) {
  if (!isMachineRunner(run.configuration) || hostedCheckTerminal(run)) return;
  const until = run.lease?.until ?? run.ownerDeadline!;
  await ctx.scheduler.runAfter(Math.max(0, until - now), expireRef, {
    projectId: run.projectId as CheckIdentity['projectId'],
    runId: run.id,
    fence: run.fence,
    until,
  });
}
/** A targeted one-shot watchdog, never an idle scan. Old timers cannot expire a
 * renewed or replacement owner. A second owner loss settles the original run. */
export async function expireMacLease(
  ctx: MutationCtx,
  input: CheckIdentity & { fence: number; until: number },
  now = Date.now(),
) {
  const { row, run } = await loadHostedCheck(ctx, input);
  if (
    !isMachineRunner(run.configuration) ||
    hostedCheckTerminal(run) ||
    run.fence !== input.fence ||
    (run.lease?.until ?? run.ownerDeadline) !== input.until ||
    input.until > now
  )
    return null;
  const reason = run.lease ? 'MAC_RUNNER_LEASE_EXPIRED' : 'MAC_RUNNER_NO_OWNER';
  run.fence++;
  run.lease = null;
  run.executionId = null;
  if (run.cancelRequested || (run.leaseRetries ?? 0) >= 1) {
    run.status = run.cancelRequested ? 'cancelled' : 'runner-unavailable';
    run.failureReason = reason;
    run.endedAt = new Date(now).toISOString();
    run.terminalDigest = checkPin({ runId: run.id, fence: run.fence, reason, status: run.status });
    // A scheduled failure must settle even if the requester lost access while
    // the controller was absent. This internal path cannot publish passing
    // evidence or source, and never grants the former actor access to its result.
    const operationRow = await hostedOperationRow(ctx, input.projectId, run.actor, run.request.operationId);
    invariant(operationRow, 'SOURCE_UNAVAILABLE', 'The original check operation is unavailable.');
    const operation = hostedOperationSchema.parse(JSON.parse(operationRow.value));
    const completed = completeHostedOperation(operation, {
      attemptId: operation.firstAttempt.id,
      at: run.endedAt,
      outcome: {
        status: 'completed',
        result: {
          runId: run.id,
          status: run.status,
          head: run.request.expectedHead,
          terminalDigest: run.terminalDigest,
        },
      },
    });
    await ctx.db.patch(operationRow._id, { value: canonicalPayload(completed) });
  } else {
    run.leaseRetries = 1;
    run.status = 'queued';
    run.dispatchStarted = false;
    run.counts = { completed: 0, passed: 0, failed: 0 };
    run.ownerDeadline = now + macLeaseMs;
    await watchMacLease(ctx, run, now);
  }
  await writeHostedCheck(ctx, row._id, run);
  return null;
}
export const expire = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), fence: v.number(), until: v.number() },
  returns: v.null(),
  handler: (ctx, input) => expireMacLease(ctx, input),
});
