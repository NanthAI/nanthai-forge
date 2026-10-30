import { fixGate } from '../src/culprit-bisect';
import { isMachineRunner } from '../src/hosted-machine-runner';
import { cancelHostedCheck } from './projectHostedCheckCancel';
import { scheduleDirectActions } from './projectHostedActionsDirect';
import { hostedGateForCandidates, hostedGateInput } from './projectHostedGate';
import {
  scopedRecheckEligible,
  scopedRecheckGate,
  type ScopedRecheckBasis,
} from '../src/scoped-recheck-policy';
import { semanticPayload } from '../src/semantic-payload';
import { mergeSemanticMembers, semanticMember } from './projectSemanticContracts';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { watchMacLease, macLeaseMs } from './projectHostedCheckLease';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import {
  checkCaller,
  checkSetting,
  beginCheckOperation,
  completeCheckOperation,
  loadHostedCheck,
} from './projectHostedCheckStore';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedCheckRequestSchema,
  hostedCheckRunnerSchema,
  hostedCheckRunSchema,
  type HostedCheckRun,
  hostedCheckTerminal,
  checkPin,
  checkNumber,
} from '../src/hosted-check';
import { checkSchema } from '../src/work-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const enqueue = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await checkCaller(ctx, input.projectId);
      return canonicalPayload(
        await enqueueHostedCheck(ctx, {
          projectId: input.projectId,
          actor,
          request: JSON.parse(input.request),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
const cancelSchema = z
  .object({ operationId: z.uuid(), runId: z.uuid(), authorityEpoch: checkNumber })
  .strict();
export const cancel = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = cancelSchema.parse(JSON.parse(input.request));
      const { actor, project } = await checkCaller(ctx, input.projectId);
      const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: request.runId });
      invariant(
        actor === run.actor || actor === project.owner,
        'PROJECT_UNAVAILABLE',
        'Cancel a check requested by this account or project owner.',
      );
      const prepared = await beginCheckOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: request.operationId,
        expected: { authorityEpoch: request.authorityEpoch, resourceId: request.runId },
        payload: request,
      });
      if (prepared.replayed) return canonicalPayload(run);
      if (!hostedCheckTerminal(run)) {
        await hostedWriteProject(ctx, input.projectId, run.actor, run.request.authorityEpoch);
        Object.assign(run, await cancelHostedCheck(ctx, { projectId: input.projectId, runId: run.id }));
      }
      await completeCheckOperation(ctx, prepared.operation, {
        runId: run.id,
        cancelRequested: run.cancelRequested,
      });
      return canonicalPayload(run);
    } catch (error) {
      return report(error);
    }
  },
});

/** Shared transaction seam: caller resolves actor from current authentication.
 * Provider IO stays outside this transaction. */
export async function enqueueHostedCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: unknown;
    /** Main-race retry: a full gate may become the scoped recheck selection. */
    recheck?: ScopedRecheckBasis;
  },
) {
  const request = hostedCheckRequestSchema.parse(input.request);
  const actor = input.actor;
  const prepared = await beginCheckOperation(ctx, {
    projectId: input.projectId,
    actor,
    operationId: request.operationId,
    expected: {
      authorityEpoch: request.authorityEpoch,
      resourceId: request.candidateId,
      head: request.expectedHead,
    },
    payload: request,
  });
  if (prepared.replayed)
    return (
      await loadHostedCheck(ctx, {
        projectId: input.projectId,
        runId: prepared.operation.firstAttempt.ids.run!,
      })
    ).run;
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor,
    kind: 'candidate',
    key: request.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Select a canonical hosted Candidate.');
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  invariant(
    candidate.kind === 'candidate' &&
      candidate.result.status === 'clean' &&
      candidate.result.head === request.expectedHead,
    'VIEW_STALE',
    'Select this clean Candidate and its exact head.',
  );
  const registered = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q =>
      q.eq('projectId', input.projectId).eq('head', request.expectedHead),
    )
    .unique();
  invariant(registered, 'SOURCE_UNAVAILABLE', 'The Candidate needs trusted source registration.');
  const source = await saveObject(ctx, input.projectId, { sha256: request.expectedHead });
  invariant(
    source.object.size === registered.size,
    'SOURCE_HASH_MISMATCH',
    'Registered source size differs.',
  );
  const definition = await checkSetting(ctx, input.projectId, 'definition', request.checkId);
  const configuration = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  invariant(
    definition?.digest === request.expectedDefinition &&
      configuration?.digest === request.expectedConfiguration,
    'EVIDENCE_CHANGED',
    'Select the exact current check and runner configuration.',
  );
  const runner = hostedCheckRunnerSchema.parse(JSON.parse(configuration.value));
  invariant(
    runner.provider !== 'modal',
    'RUNNER_UNAVAILABLE',
    'The Modal runner has been retired. Select mac, self-hosted or github-actions.',
  );
  invariant(
    runner.environmentFingerprint === request.expectedEnvironment,
    'EVIDENCE_CHANGED',
    'Select the configured runtime environment.',
  );
  const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
  invariant(
    keyId && /^[A-Z0-9_]+$/.test(keyId),
    'RUNNER_UNAVAILABLE',
    'Trusted hosted check callback configuration is unavailable.',
  );
  const id = prepared.operation.firstAttempt.ids.run!;
  const member = await semanticMember(ctx, { projectId: input.projectId, actor }, candidate.intentId);
  const semantic =
    member || candidate.semanticPlan?.batchIntentIds
      ? mergeSemanticMembers(candidate.intentId, candidate.semanticPlan?.members, member ? [member] : [])
      : undefined;
  if (semantic && candidate.semanticPlan?.batchIntentIds)
    semantic.batchIntentIds = candidate.semanticPlan.batchIntentIds;
  if (semantic && candidate.semanticPlan?.afterSequence !== undefined)
    semantic.afterSequence = candidate.semanticPlan.afterSequence;
  const project = (await ctx.db.get(input.projectId))!;
  // Older controller/provider clients strictly parse run documents. Only the
  // direct Actions session has the additive gate handshake; all other routes
  // retain their existing full-check wire shape.
  const recoveryGate = fixGate({ needsFix: row.restoreBases ?? project.needsFix?.[candidate.intentId] });
  let gate =
    runner.provider === 'github-actions' && !runner.credential && project.autonomyPolicy?.acceptance.gate
      ? (recoveryGate ??
        (await hostedGateForCandidates(ctx, project, [
          { candidate, actor: { kind: 'agent', id: actor }, contract: member ?? null },
        ])))
      : undefined;
  if (
    gate?.mode === 'full' &&
    !recoveryGate &&
    input.recheck &&
    scopedRecheckEligible(await hostedGateInput(ctx, project, candidate, { kind: 'agent', id: actor }, null))
  )
    gate = scopedRecheckGate(input.recheck);
  const run = hostedCheckRunSchema.parse({
    ...(gate ? { gate } : {}),
    ...(semantic && semantic.members.length > 1 ? { semanticPlan: semantic } : {}),
    schema: 1,
    id,
    projectId: input.projectId,
    actor,
    at: prepared.operation.firstAttempt.at,
    request,
    check: checkSchema.parse(JSON.parse(definition.value)),
    configuration: runner,
    ...(project.autonomyPolicy?.checkLogs ? { checkLogs: project.autonomyPolicy.checkLogs } : {}),
    keyId,
    candidate: {
      digest: row.digest,
      base: candidate.base,
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
      algorithm: candidate.algorithm,
    },
    dispatchKey: checkPin({ projectId: input.projectId, runId: id, operationId: request.operationId }),
    dispatchStarted: false,
    recoveryUsed: false,
    emptyLookups: [],
    executionId: null,
    fence: 0,
    lease: null,
    plan: null,
    planDigest: null,
    ...(isMachineRunner(runner) ? { ownerDeadline: Date.now() + macLeaseMs } : {}),
    status: 'queued',
    cancelRequested: false,
    counts: { completed: 0, passed: 0, failed: 0 },
    terminalDigest: null,
    endedAt: null,
    exitCode: null,
    output: null,
    cost: { status: 'unknown' },
  });
  return insertHostedCheckRun(ctx, run);
}

/** Insert an already prepared run and retain the existing provider dispatch hooks. */
export async function insertHostedCheckRun(ctx: MutationCtx, run: HostedCheckRun): Promise<HostedCheckRun> {
  await ctx.db.insert('projectHostedCheckRuns', {
    projectId: run.projectId as Id<'hostedProjects'>,
    runId: run.id,
    candidateId: run.request.candidateId,
    ...(isMachineRunner(run.configuration) ? { machineId: run.configuration.machineId } : {}),
    ...(run.gate ? { gate: run.gate } : {}),
    status: run.status,
    value: semanticPayload(run, true),
  });
  await watchMacLease(ctx, run);
  await scheduleDirectActions(ctx, run);
  return run;
}
