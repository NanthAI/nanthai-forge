// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { watchMacLease, expireMacLease, macLeaseMs } from './projectHostedCheckLease';
import type { MutationCtx } from './_generated/server';
import {
  writableHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
  type CheckIdentity,
} from './projectHostedCheckStore';
import { saveObject } from './projectHostedSaveStore';
import { hostedCheckPlanSchema, hostedCheckTerminal, checkPin } from '../src/hosted-check';
import { invariant } from '../src/errors';

export const hostedCheckControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), owner: z.uuid(), leaseMs: z.number().safe().positive() }).strict(),
  z
    .object({
      kind: z.literal('prepare'),
      owner: z.uuid(),
      token: z.number().safe().nonnegative(),
      plan: hostedCheckPlanSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('reserve'),
      owner: z.uuid(),
      token: z.number().safe().nonnegative(),
      recovery: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('empty'),
      owner: z.uuid(),
      token: z.number().safe().nonnegative(),
      receipt: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observe'),
      owner: z.uuid(),
      token: z.number().safe().nonnegative(),
      result: z.discriminatedUnion('status', [
        z.object({ status: z.literal('accepted'), executionId: z.string().min(1) }).strict(),
        z.object({ status: z.literal('unknown') }).strict(),
        z.object({ status: z.literal('rejected') }).strict(),
      ]),
    })
    .strict(),
]);
/** Short transitions only. The adapter does source/plan work and provider I/O
 * outside this transaction. An expired control lease never licenses a new run. */
export async function controlHostedCheck(
  ctx: MutationCtx,
  input: CheckIdentity & { command: unknown },
  now = Date.now(),
) {
  const command = hostedCheckControlSchema.parse(input.command);
  let { row, run } = await writableHostedCheck(ctx, input);
  if (
    run.configuration.provider === 'mac' &&
    !hostedCheckTerminal(run) &&
    (run.lease?.until ?? run.ownerDeadline ?? Infinity) <= now
  ) {
    await expireMacLease(
      ctx,
      { ...input, fence: run.fence, until: (run.lease?.until ?? run.ownerDeadline)! },
      now,
    );
    ({ row, run } = await writableHostedCheck(ctx, input));
  }
  if (hostedCheckTerminal(run)) return { run, acquired: false, dispatch: false };
  if (command.kind === 'claim') {
    const old = run.lease;
    if (old && old.until > now && old.owner !== command.owner)
      return { run, acquired: false, dispatch: false };
    if (run.configuration.provider === 'mac' && old && old.owner === command.owner && old.until > now)
      return { run, acquired: true, dispatch: false };
    run.lease = {
      owner: command.owner,
      token: (old?.token ?? (run.configuration.provider === 'mac' ? run.fence : 0)) + 1,
      until: now + (run.configuration.provider === 'mac' ? macLeaseMs : command.leaseMs),
    };
    await watchMacLease(ctx, run, now);
    run.emptyLookups = [];
    if (run.status === 'queued') run.status = 'preparing';
    await writeHostedCheck(ctx, row._id, run);
    return { run, acquired: true, dispatch: false };
  }
  invariant(
    run.lease &&
      run.lease.owner === command.owner &&
      run.lease.token === command.token &&
      run.lease.until > now,
    'WORK_STALE',
    'The hosted check controller lease changed.',
  );
  if (command.kind === 'prepare') {
    const plan = command.plan;
    invariant(
      plan.head === run.request.expectedHead &&
        plan.definition === run.check.definition &&
        plan.runtime === run.configuration.runtime &&
        plan.environmentFingerprint === run.request.expectedEnvironment,
      'EVIDENCE_CHANGED',
      'The prepared plan differs from the pinned source, definition or runtime.',
    );
    if (run.plan)
      invariant(run.planDigest === checkPin(plan), 'EVIDENCE_CHANGED', 'The original run plan is immutable.');
    else {
      invariant(!run.dispatchStarted, 'EVIDENCE_CHANGED', 'Prepare the original plan before dispatch.');
      await saveObject(ctx, input.projectId, plan.manifest);
      await saveObject(ctx, input.projectId, plan.selection);
      run.plan = plan;
      run.planDigest = checkPin(plan);
    }
  } else if (command.kind === 'reserve') {
    invariant(
      run.plan && run.planDigest && !run.cancelRequested,
      'EVIDENCE_CHANGED',
      'Prepare the original active run plan before dispatch.',
    );
    if (command.recovery) {
      invariant(
        run.dispatchStarted && !run.executionId && !run.recoveryUsed && run.emptyLookups.length === 2,
        'EVIDENCE_CHANGED',
        'Reconcile two fresh authoritative empty lookups under this lease before recovery.',
      );
      run.recoveryUsed = true;
    } else if (run.dispatchStarted) return { run, acquired: true, dispatch: false };
    run.dispatchStarted = true;
    run.status = 'dispatching';
    await writeHostedCheck(ctx, row._id, run);
    return { run, acquired: true, dispatch: true };
  } else if (command.kind === 'empty') {
    invariant(
      run.dispatchStarted && !run.executionId,
      'EVIDENCE_CHANGED',
      'Only an unresolved dispatch can be absent.',
    );
    if (!run.emptyLookups.includes(command.receipt))
      run.emptyLookups = [...run.emptyLookups, command.receipt].slice(-2);
  } else {
    invariant(
      run.dispatchStarted,
      'EVIDENCE_CHANGED',
      'Reserve dispatch before recording provider observations.',
    );
    if (command.result.status === 'accepted') {
      invariant(
        !run.executionId || run.executionId === command.result.executionId,
        'EVIDENCE_CHANGED',
        'The provider returned a different retained execution.',
      );
      run.executionId = command.result.executionId;
      run.status = 'running';
    } else if (!run.executionId) {
      run.status =
        command.result.status === 'rejected' && !run.recoveryUsed ? 'runner-unavailable' : 'unknown';
      if (hostedCheckTerminal(run)) {
        run.endedAt = new Date(now).toISOString();
        run.terminalDigest = checkPin({ dispatchKey: run.dispatchKey, result: command.result });
        await completeHostedCheck(ctx, run);
      }
    }
  }
  await writeHostedCheck(ctx, row._id, run);
  return { run, acquired: true, dispatch: false };
}
