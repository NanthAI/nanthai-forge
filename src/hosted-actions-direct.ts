// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { sourcePackUploadSchema } from './source-pack.js';
import { checkHash, checkNumber, checkObject, checkPin, type HostedCheckRun } from './hosted-check.js';
import { outputMessage, signOutput, type OutputMessage } from './hosted-check-output.js';
import { hostedCheckCallbackSchema, type HostedCheckCallback } from './hosted-check-evidence.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { semanticReportsSchema } from './intent-semantic-conflict.js';
import { invariant } from './errors.js';
import { checkFileSummarySchema } from './check-file-summary.js';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
export const directSourceWindow = 400;
export const directLogBytes = 64 * 1024;
export const directLogSchema = z
  .object({
    object: checkObject.refine(p => p.size > 0 && p.size <= directLogBytes),
    failureSummary: z.string().max(4096),
  })
  .strict();
export const directResultSchema = z
  .object({
    index: checkNumber,
    exitCode: z.number().int(),
    log: directLogSchema.optional(),
    contractReports: semanticReportsSchema.optional(),
    // Compatibility metadata only; retained summaries are derived from contractReports.
    testFiles: checkFileSummarySchema.optional(),
    // Supervisor process start to result: includes setup and tests, not earlier workflow steps.
    execution: z.object({ startedAt: z.iso.datetime(), endedAt: z.iso.datetime() }).strict().optional(),
  })
  .strip();
/** GitHub's job limit plus clock slack. Implausible runner clocks stay unknown, never fail a check. */
const maxShardSeconds = 6 * 3600 + 600,
  clockSlackMs = 5 * 60_000;
export function shardExecution(
  input: z.infer<typeof directResultSchema>['execution'],
  runAt: string,
  now: number,
) {
  if (!input) return undefined;
  const start = Date.parse(input.startedAt),
    end = Date.parse(input.endedAt);
  if (!(start <= end && start >= Date.parse(runAt) - clockSlackMs && end <= now + clockSlackMs))
    return undefined;
  const seconds = (end - start) / 1000;
  return seconds <= maxShardSeconds ? { ...input, seconds } : undefined;
}
/** Observed only when every planned shard retained an interval; otherwise unknown. */
export function actionsExecutionCost(run: Pick<HostedCheckRun, 'id' | 'execution'>, shardCount: number) {
  if (!run.execution || run.execution.shards < shardCount) return { status: 'unknown' as const };
  const summary = { runId: run.id, ...run.execution };
  return {
    status: 'observed' as const,
    receipt: { sha256: checkPin(summary), size: new TextEncoder().encode(canonicalPayload(summary)).length },
    seconds: run.execution.seconds,
    // Billed dollars come only from owner-entered bills, never from runner minutes.
    estimatedCostUsd: null,
  };
}
export const directPlanSchema = z.object({ recipe: hostedActionsRecipeSchema, lockfile: checkHash }).strict();
// Command/result metadata may grow. Identity, pins, logs and recipes remain strict.
export const directCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), timings: z.boolean().optional() }).strip(),
  z.object({ kind: z.literal('source'), digests: z.array(checkHash).min(1).max(directSourceWindow) }).strip(),
  z
    .object({
      kind: z.literal('sourcePack'),
      phase: z.enum(['prepare', 'commit']),
      object: sourcePackUploadSchema,
    })
    .strip(),
  z.object({ kind: z.literal('plan'), plan: directPlanSchema }).strip(),
  z.object({ kind: z.literal('output'), index: checkNumber, log: directLogSchema }).strip(),
  z.object({ kind: z.literal('result'), result: directResultSchema }).strip(),
]);
export const directRequestSchema = z
  .object({
    projectId: z.string(),
    runId: z.uuid(),
    fence: z.number().safe().nonnegative().optional(),
    command: directCommandSchema,
  })
  .strict();
export function directCallback(run: HostedCheckRun, result: HostedCheckCallback['result']) {
  invariant(
    run.plan && run.planDigest && run.executionId,
    'EVIDENCE_CHANGED',
    'Prepare this exact Actions execution.',
  );
  const hash = checkPin({ runId: run.id, fence: run.fence, result });
  return hostedCheckCallbackSchema.parse({
    schema: 1,
    eventId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    projectId: run.projectId,
    runId: run.id,
    operationId: run.request.operationId,
    authorityEpoch: run.request.authorityEpoch,
    fence: run.fence,
    provider: 'github-actions',
    executionId: run.executionId,
    head: run.request.expectedHead,
    definition: run.request.expectedDefinition,
    configuration: run.request.expectedConfiguration,
    environmentFingerprint: run.request.expectedEnvironment,
    runtime: run.plan.runtime,
    planDigest: run.planDigest,
    lockfile: run.plan.lockfile,
    selection: run.plan.selection,
    result,
  });
}
export function directOutput(
  run: HostedCheckRun,
  index: number,
  log: z.infer<typeof directLogSchema>,
  secret: string,
) {
  invariant(run.plan && index < run.plan.shardCount, 'EVIDENCE_CHANGED', 'Select a planned Actions job.');
  const stream = {
    kind: 'summary' as const,
    shard: index,
    attempt: 0,
    executionId: `${run.executionId}/${index}`,
    stream: 'stdout' as const,
    name: '',
  };
  const bodies: OutputMessage['body'][] = [
    { kind: 'chunk', chunk: { stream, sequence: 0, offset: 0, object: log.object } },
    {
      kind: 'seal',
      seal: {
        stream,
        chunks: 1,
        bytes: log.object.size,
        sha256: log.object.sha256,
        failureSummary: log.failureSummary,
      },
    },
  ];
  return bodies.map(body => {
    const message = outputMessage(run, body);
    return { projectId: run.projectId, message, signature: signOutput(message, secret) };
  });
}
