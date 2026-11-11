// SPDX-License-Identifier: Apache-2.0
import { capsuleReceiptDigest } from './projectLandingCapsuleLedger';
import { assertHostedCheckActive } from './projectHostedCheckStore';
import { isMachineRunner } from '../src/hosted-machine-runner';
import { macMachine, requireMacMachine } from './projectHostedCheckMachines';
import { macHeartbeatSchema, verifyMacHeartbeat } from '../src/hosted-mac-lease';
import { watchMacLease, macLeaseMs } from './projectHostedCheckLease';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation, query, type QueryCtx, type MutationCtx } from './cliServer';
import {
  checkCaller,
  checkSetting,
  beginCheckOperation,
  completeCheckOperation,
  loadHostedCheck,
} from './projectHostedCheckStore';
import { controlHostedCheck, hostedCheckControlSchema } from './projectHostedCheckDispatch';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { outputSigningKey } from './projectHostedOutputApi';
import { machineCollectorKey, runSigningSecret } from '../src/hosted-collector-key';
import { hostedMachineRunnerSchema, checkPin, hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { Id } from './_generated/dataModel';

const address = { projectId: v.id('hostedProjects'), machineId: v.string(), sessionId: v.string() };
async function owner(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const selected = await checkCaller(ctx, projectId);
  invariant(
    selected.actor === selected.project.owner,
    'PROJECT_UNAVAILABLE',
    'Use the project owner’s runner registration.',
  );
  return selected;
}
async function worker(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; machineId: string; sessionId: string },
  /** The owner already resolved in this transaction. */
  resolved?: { actor: string },
) {
  const { actor } = resolved ?? (await owner(ctx, input.projectId));
  const row = await requireMacMachine(ctx, input.projectId, input.machineId);
  invariant(
    row && row.actor === actor && row.sessionId === input.sessionId,
    'WORK_STALE',
    'The runner session changed.',
  );
  return row;
}
export const register = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = z
        .object({
          operationId: z.uuid(),
          authorityEpoch: z.number().safe().nonnegative(),
          configuration: hostedMachineRunnerSchema,
        })
        .strict()
        .parse(JSON.parse(input.request));
      const { actor } = await owner(ctx, input.projectId);
      // The machine's key is derived on demand for this project and machine only;
      // it is never stored and never part of the operation receipt.
      const issue = (keyId: string) =>
        machineCollectorKey(outputSigningKey(keyId), {
          keyId,
          projectId: input.projectId,
          machineId: request.configuration.machineId,
        });
      const operation = await beginCheckOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: request.operationId,
        expected: { authorityEpoch: request.authorityEpoch },
        payload: request,
      });
      if (operation.replayed) {
        const outcome = operation.operation.terminal?.outcome as
          | { status?: string; result?: { keyId?: string; machineId?: string } }
          | undefined;
        const keyId = outcome?.result?.keyId;
        return canonicalPayload(
          outcome?.status === 'completed' &&
            keyId &&
            outcome.result?.machineId === request.configuration.machineId
            ? { ...outcome, collectorKey: issue(keyId) }
            : outcome,
        );
      }
      const configuration = await checkSetting(ctx, input.projectId, 'runner', 'runner');
      invariant(
        configuration?.digest === checkPin(request.configuration),
        'EVIDENCE_CHANGED',
        'Select the configured machine, runtime and environment.',
      );
      const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
      invariant(
        keyId && /^[A-Z0-9_]+$/.test(keyId),
        'RUNNER_UNAVAILABLE',
        'Trusted check callback configuration is unavailable.',
      );
      const collectorKey = issue(keyId);
      const row = {
        projectId: input.projectId,
        machineId: request.configuration.machineId,
        sessionId: request.operationId,
        actor,
        configuration: configuration.digest,
        keyId,
      };
      const old = await macMachine(ctx, input.projectId, row.machineId);
      invariant(
        !old || old.revokedAt === undefined,
        'MAC_MACHINE_REVOKED',
        `Runner machine ${row.machineId} is revoked; register a new machine identity.`,
      );
      if (old) await ctx.db.replace(old._id, row);
      else await ctx.db.insert('projectHostedCheckWorkers', row);
      await completeCheckOperation(ctx, operation.operation, row);
      return canonicalPayload({ status: 'completed', result: row, collectorKey });
    } catch (error) {
      return report(error);
    }
  },
});
/** This live query is the existing Convex subscription wake mechanism. It reads
 * only this machine's bounded queue; an unchanged empty queue triggers no calls. */
export const work = query({
  args: address,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await worker(ctx, input);
      const rows = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_machine_and_status', q =>
          q.eq('projectId', input.projectId).eq('machineId', input.machineId).eq('status', 'queued'),
        )
        .take(20);
      return canonicalPayload(rows.map(row => row.runId));
    } catch (error) {
      return report(error);
    }
  },
});
export const control = mutation({
  args: { ...address, runId: v.string(), command: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const registered = await worker(ctx, input);
      const { run } = await loadHostedCheck(ctx, input);
      invariant(
        isMachineRunner(run.configuration) &&
          run.configuration.machineId === input.machineId &&
          run.request.expectedConfiguration === registered.configuration &&
          run.keyId === registered.keyId,
        'EVIDENCE_CHANGED',
        'Claim this machine’s exact configured run.',
      );
      const command = hostedCheckControlSchema.parse(JSON.parse(input.command));
      invariant(command.owner === input.sessionId, 'WORK_STALE', 'Use this registered controller session.');
      if (command.kind !== 'claim' && !hostedCheckTerminal(run))
        invariant(run.lease?.owner === input.sessionId, 'WORK_STALE', 'Claim the run before controlling it.');
      return canonicalPayload(await controlHostedCheck(ctx, { ...input, command }));
    } catch (error) {
      return report(error);
    }
  },
});
export const callback = mutation({
  args: { projectId: v.id('hostedProjects'), callback: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await owner(ctx, input.projectId);
      return canonicalPayload(
        await receiveHostedCheckCallback(
          ctx,
          { ...input, callback: JSON.parse(input.callback) },
          outputSigningKey,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});

export const heartbeat = mutation({
  args: { projectId: v.id('hostedProjects'), callback: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const selected = await owner(ctx, input.projectId);
      const value = macHeartbeatSchema.parse(JSON.parse(input.callback));
      invariant(value.projectId === input.projectId, 'EVIDENCE_CHANGED', 'Heartbeat project differs.');
      const { row, run } = await writableHostedCheck(ctx, { projectId: input.projectId, runId: value.runId });
      assertHostedCheckActive(run);
      invariant(isMachineRunner(run.configuration), 'EVIDENCE_CHANGED', 'Select a machine execution.');
      verifyMacHeartbeat(value, input.signature, runSigningSecret(outputSigningKey(run.keyId), run));
      await worker(
        ctx,
        {
          projectId: input.projectId,
          machineId: run.configuration.machineId,
          sessionId: value.owner,
        },
        selected,
      );
      const prior = await ctx.db
        .query('projectHostedCheckCallbacks')
        .withIndex('by_project_and_run_and_event', q =>
          q.eq('projectId', input.projectId).eq('runId', run.id).eq('eventId', value.eventId),
        )
        .unique();
      const priorDigest =
        prior?.digest ??
        (hostedCheckTerminal(run)
          ? await capsuleReceiptDigest(ctx, input.projectId, `check:${run.id}`, value.eventId)
          : null);
      if (priorDigest) {
        invariant(priorDigest === checkPin(value), 'WORK_OPERATION_CHANGED', 'Retry the original heartbeat.');
        return canonicalPayload(run);
      }
      invariant(
        !hostedCheckTerminal(run) &&
          !run.cancelRequested &&
          run.fence === value.fence &&
          run.lease?.owner === value.owner &&
          run.lease.token === value.token &&
          run.lease.until > Date.now(),
        'WORK_STALE',
        'The execution no longer has a live owner.',
      );
      run.lease.until = Date.now() + macLeaseMs;
      await ctx.db.insert('projectHostedCheckCallbacks', {
        projectId: input.projectId,
        runId: run.id,
        eventId: value.eventId,
        digest: checkPin(value),
        value: canonicalPayload({ eventId: value.eventId, kind: 'heartbeat' }),
      });
      await watchMacLease(ctx, run);
      await writeHostedCheck(ctx, row._id, run);
      return canonicalPayload(run);
    } catch (error) {
      return report(error);
    }
  },
});
