// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkHash, checkNumber, checkObject, checkPin, type HostedCheckRun } from './hosted-check.js';
import { outputMessage, signOutput, type OutputMessage } from './hosted-check-output.js';
import { hostedCheckCallbackSchema, type HostedCheckCallback } from './hosted-check-evidence.js';
import { semanticReportsSchema } from './intent-semantic-conflict.js';
import { invariant } from './errors.js';
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
  })
  .strict();
export const directCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), timings: z.boolean().optional() }).strict(),
  z
    .object({ kind: z.literal('source'), digests: z.array(checkHash).min(1).max(directSourceWindow) })
    .strict(),
  z.object({ kind: z.literal('plan'), plan: z.unknown() }).strict(),
  z.object({ kind: z.literal('output'), index: checkNumber, log: directLogSchema }).strict(),
  z.object({ kind: z.literal('result'), result: directResultSchema }).strict(),
]);
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
