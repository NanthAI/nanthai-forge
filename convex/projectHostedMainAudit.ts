// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { z } from 'zod';
import { internalMutation } from './_generated/server';
import { mutation, query } from './cliServer';
import {
  mainAuditStatus,
  auditRow,
  armAudit,
  onGateRunTerminal,
  noteMainLanding,
  releaseMainHolds,
} from './projectHostedMainAuditState';
import { beginCheckOperation, checkCaller, checkSetting, loadHostedCheck } from './projectHostedCheckStore';
import { saveCheckSetting } from './projectHostedCheckDefinitions';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { recordLandingObservation } from './projectHostedLandingStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { hostedOperationRow } from './projectHostedOperations';
import { insertHostedCheckRun } from './projectHostedChecks';
import { readHostedRecord } from './projectHostedRecords';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  checkPin,
  hostedCheckRunSchema,
  hostedCheckRunnerSchema,
  hostedCheckTerminal,
} from '../src/hosted-check';
import { hostedOperationSchema, canonicalPayload } from '../src/hosted-source-operation';
import {
  auditOperationId,
  auditMetadata,
  auditReason,
  mainAuditKey,
  mainAuditSettingsSchema,
  fullGate,
} from '../src/main-audit';
import { checkSchema } from '../src/work-types';
import { isMachineRunner } from '../src/hosted-machine-runner';
import { macLeaseMs } from './projectHostedCheckLease';
import { invariant } from '../src/errors';
import { report } from './errors';

const identity = { projectId: v.id('hostedProjects') };
export const status = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await checkCaller(ctx, input.projectId);
      return canonicalPayload(await mainAuditStatus(ctx, input.projectId));
    } catch (error) {
      return report(error);
    }
  },
});
const configureSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: z.number().safe().nonnegative(),
    expected: z.string().nullable(),
    settings: mainAuditSettingsSchema,
  })
  .strict();
export const configure = mutation({
  args: { ...identity, request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = configureSchema.parse(JSON.parse(input.request));
      const { actor } = await checkCaller(ctx, input.projectId);
      const replay = await hostedOperationRow(ctx, input.projectId, actor, request.operationId);
      const saved = await saveCheckSetting(ctx, input.projectId, request, request, () => ({
        kind: 'runner',
        key: 'main-audit',
        value: request.settings,
        digest: checkPin(request.settings),
      }));
      const row = await auditRow(ctx, input.projectId);
      if (!replay && row?.unaudited?.count && (!row.audit || hostedCheckTerminal(row.audit))) {
        if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
        await armAudit(
          ctx,
          { ...row, wake: undefined },
          row.unaudited.count >= request.settings.landings
            ? Date.now()
            : Date.parse(row.unaudited.firstAt!) + request.settings.minutes * 60_000,
        );
      }
      return saved;
    } catch (error) {
      return report(error);
    }
  },
});
/** Rollout preflight may seed only retained, explicitly full-passed evidence. */
export const seed = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'NOT_FOUND', 'Select the hosted project.');
    const rows = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', input.projectId))
      .order('desc')
      .take(1);
    invariant(rows[0], 'SOURCE_UNAVAILABLE', 'Select the last main receipt.');
    const receipt = hostedAcceptanceSchema.parse(JSON.parse(rows[0].value));
    invariant(receipt.check, 'EVIDENCE_CHANGED', 'Seed from a checked main receipt.');
    const run = await requireHostedCheckEvidence(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      runId: receipt.check.runId,
      candidateId: receipt.candidate.id,
      head: receipt.candidate.head,
      checkId: receipt.check.checkId,
      definition: receipt.check.definition,
      configuration: receipt.check.configuration,
      environment: receipt.check.environment,
      authorityEpoch: receipt.authorityEpoch,
    });
    invariant(
      run.gate &&
        fullGate(run) &&
        run.status === 'passed' &&
        run.request.expectedHead === receipt.candidate.head &&
        run.candidate.digest === receipt.candidate.digest,
      'EVIDENCE_CHANGED',
      'Seed only exact full-passed main evidence.',
    );
    await noteMainLanding(ctx, { project, receipt, run });
    return null;
  },
});
export const releaseHeld = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    if (!(await auditRow(ctx, input.projectId))?.red) await releaseMainHolds(ctx, input.projectId);
    return null;
  },
});

/** Persist the named stall on held observations in bounded, cursor-pinned pages. */
export const stallHeld = internalMutation({
  args: {
    ...identity,
    runId: v.string(),
    sequence: v.number(),
    step: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await auditRow(ctx, input.projectId);
    if (!row?.red || (row.lastGreen?.sequence ?? -1) >= input.sequence) return null;
    const page = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_hold', q => q.eq('projectId', input.projectId).eq('hold', 'main-red'))
      .paginate({ cursor: input.cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 512 * 1024 });
    for (const held of page.page) {
      const state = hostedLandingStateSchema.parse(JSON.parse(held.value));
      state.version++;
      state.error = {
        code: 'MAIN_AUDIT_STALLED',
        message: `Main audit ${input.runId} stalled at ${input.step}.`,
      };
      await recordLandingObservation(ctx, state, null);
      await ctx.db.patch(held._id, { value: canonicalPayload(state) });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedMainAudit:stallHeld'), {
        ...input,
        cursor: page.continueCursor,
      });
    return null;
  },
});

/** The wake belongs only to unaudited landings. Provider watchdogs own active-run recovery. */
export const start = internalMutation({
  args: {
    ...identity,
    retry: v.optional(v.boolean()),
    wakeAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await auditRow(ctx, input.projectId);
    if (!row || (input.wakeAt !== undefined && row.wake?.at !== input.wakeAt)) return null;
    if (row.audit && !hostedCheckTerminal(row.audit)) {
      const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: row.audit.runId });
      if (hostedCheckTerminal(run)) await onGateRunTerminal(ctx, run);
      return null;
    }
    if (row.wake && input.wakeAt === undefined) await ctx.scheduler.cancel(row.wake.taskId);
    if (row.wake) await ctx.db.patch(row._id, { wake: undefined });
    if (!row.unaudited?.count || (row.audit && !hostedCheckTerminal(row.audit))) return null;
    const project = await ctx.db.get(input.projectId);
    invariant(
      project?.sourceAuthority?.mode === 'server',
      'SOURCE_AUTHORITY_CHANGED',
      'Main audits require the current hosted source authority.',
    );
    const latest = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', input.projectId))
      .order('desc')
      .take(1);
    invariant(latest[0], 'SOURCE_UNAVAILABLE', 'Main audit requires an accepted main receipt.');
    const receipt = hostedAcceptanceSchema.parse(JSON.parse(latest[0].value));
    const definition = receipt.check
      ? await checkSetting(ctx, input.projectId, 'definition', receipt.check.checkId)
      : null;
    const configuration = await checkSetting(ctx, input.projectId, 'runner', 'runner');
    invariant(
      definition && configuration,
      'RUNNER_UNAVAILABLE',
      'Configure the accepted main check and runner before its audit.',
    );
    const runner = hostedCheckRunnerSchema.parse(JSON.parse(configuration.value));
    const key = mainAuditKey({
      projectId: input.projectId,
      head: receipt.candidate.head,
      definition: definition.digest,
      configuration: configuration.digest,
      environment: runner.environmentFingerprint,
      authorityEpoch: project.sourceAuthority.epoch,
    });
    const attempt = input.retry && row.audit?.head === receipt.candidate.head ? 1 : 0;
    const operationId = auditOperationId(key, attempt);
    const old = await hostedOperationRow(ctx, input.projectId, project.owner, operationId);
    if (old) {
      const operation = hostedOperationSchema.parse(JSON.parse(old.value));
      const { run } = await loadHostedCheck(ctx, {
        projectId: input.projectId,
        runId: operation.firstAttempt.ids.run!,
      });
      if (
        row.audit?.runId === run.id &&
        hostedCheckTerminal(row.audit) &&
        row.audit.sequence === receipt.snapshot.revision
      )
        return null;
      // Replays adopt the original result; they never submit identical content again.
      await ctx.db.patch(row._id, {
        audit: {
          runId: run.id,
          head: run.request.expectedHead,
          sequence: receipt.snapshot.revision,
          status: 'queued',
        },
      });
      if (hostedCheckTerminal(run)) {
        // Reuse evidence on the current occurrence of this same content key.
        await onGateRunTerminal(ctx, {
          ...run,
          endedAt: new Date(Math.max(Date.parse(run.endedAt!), Date.parse(receipt.at))).toISOString(),
          gate: {
            ...run.gate!,
            reason: auditReason({
              ...auditMetadata(run),
              sequence: receipt.snapshot.revision,
              count: row.unaudited.count,
              firstAt: row.unaudited.firstAt ?? receipt.at,
            }),
          },
        });
      }
      return null;
    }
    const candidateRow = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      kind: 'candidate',
      key: receipt.candidate.id,
    });
    invariant(candidateRow, 'SOURCE_UNAVAILABLE', 'The accepted Candidate is unavailable.');
    const candidate = hostedRecordSchema.parse(JSON.parse(candidateRow.value));
    invariant(
      candidate.kind === 'candidate' &&
        candidate.result.status === 'clean' &&
        candidate.result.head === receipt.candidate.head &&
        candidateRow.digest === receipt.candidate.digest,
      'EVIDENCE_CHANGED',
      'Main audit must pin the exact accepted Candidate.',
    );
    const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
    invariant(
      keyId && /^[A-Z0-9_]+$/.test(keyId),
      'RUNNER_UNAVAILABLE',
      'Trusted hosted check callback configuration is unavailable.',
    );
    const request = {
      operationId,
      authorityEpoch: project.sourceAuthority.epoch,
      candidateId: candidate.id,
      expectedHead: receipt.candidate.head,
      checkId: receipt.check!.checkId,
      expectedDefinition: definition.digest,
      expectedConfiguration: configuration.digest,
      expectedEnvironment: runner.environmentFingerprint,
    };
    const prepared = await beginCheckOperation(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      operationId,
      expected: { authorityEpoch: request.authorityEpoch, head: request.expectedHead },
      payload: request,
    });
    const run = hostedCheckRunSchema.parse({
      schema: 1,
      id: prepared.operation.firstAttempt.ids.run!,
      projectId: input.projectId,
      actor: project.owner,
      at: prepared.operation.firstAttempt.at,
      request,
      check: checkSchema.parse(JSON.parse(definition.value)),
      configuration: runner,
      ...(project.autonomyPolicy?.checkLogs ? { checkLogs: project.autonomyPolicy.checkLogs } : {}),
      gate: {
        mode: 'audit',
        reason: auditReason({
          sequence: receipt.snapshot.revision,
          count: row.unaudited.count,
          firstAt: row.unaudited.firstAt ?? receipt.at,
          attempt,
          key,
        }),
      },
      keyId,
      candidate: {
        digest: candidateRow.digest,
        base: candidate.base,
        inputs: candidate.inputs,
        dependencies: candidate.dependencies,
        algorithm: candidate.algorithm,
      },
      dispatchKey: checkPin({ projectId: input.projectId, operationId }),
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
    await insertHostedCheckRun(ctx, run);
    await ctx.db.patch(row._id, {
      audit: {
        runId: run.id,
        head: request.expectedHead,
        sequence: receipt.snapshot.revision,
        status: 'queued',
      },
      unaudited: { count: row.unaudited.count, firstAt: null },
    });
    return null;
  },
});
