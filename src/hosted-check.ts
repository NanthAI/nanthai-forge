import { checkGateSchema } from './bet2-gate.js';
import { checkFileSummarySchema } from './check-file-summary.js';
import { semanticPlanSchema, semanticReportsSchema } from './intent-semantic-conflict.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { githubActionsRunsOnSchema } from './github-actions-runner-label.js';
import { checkLogsSchema } from './check-log-policy.js';
import { checkSchema } from './work-types.js';
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

export const checkHash = z.string().regex(/^[0-9a-f]{64}$/);
export const checkNumber = z.number().safe().nonnegative();
export const checkObject = z.object({ sha256: checkHash, size: checkNumber }).strict();
const text = z.string().min(1);
export const hostedCheckCommandSchema = checkSchema.omit({ id: true, definition: true, at: true }).strict();
/** Same normalized definition and digest as local define-check. Imported IDs,
 * timestamps and definitions are retained rather than reinterpreted as evidence. */
export function hostedCheckDefinition(command: unknown, id: string, at: string) {
  const c = hostedCheckCommandSchema.parse(command);
  const fields = {
    name: c.name,
    executable: c.executable,
    args: c.args,
    environmentLabel: c.environmentLabel,
    ...(c.env?.length ? { env: [...new Set(c.env)].sort() } : {}),
    ...(c.credentials?.length ? { credentials: [...new Set(c.credentials)].sort() } : {}),
    ...(c.artifactPaths?.length ? { artifactPaths: [...new Set(c.artifactPaths)] } : {}),
    ...(c.static !== undefined ? { static: c.static } : {}),
    ...(c.measureResources ? { measureResources: true } : {}),
    ...(c.declaredInputs?.length ? { declaredInputs: c.declaredInputs } : {}),
    ...(c.actions ? { actions: c.actions } : {}),
  };
  return checkSchema.parse({ ...fields, id, at, definition: digest(JSON.stringify(fields)) });
}
export function importedHostedCheck(value: unknown) {
  const check = checkSchema.strict().parse(value);
  const { id, at, definition, ...command } = check;
  invariant(
    hostedCheckDefinition(command, id, at).definition === definition,
    'EVIDENCE_CHANGED',
    'The imported check definition differs from its command.',
  );
  return check;
}
const credential = z.object({ secretId: text, version: checkNumber, operation: text }).strict();
export const hostedActionsRunnerSchema = z
  .object({
    provider: z.literal('github-actions'),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    installationId: text.optional(),
    runsOn: githubActionsRunsOnSchema,
    concurrencyBudget: z.number().safe().int().min(2).optional(),
    runtime: checkHash,
    environmentFingerprint: checkHash,
    credential: credential.optional(),
  })
  .strict();
export const hostedMacRunnerSchema = z
  .object({
    provider: z.literal('mac'),
    machineId: z.uuid(),
    runtime: checkHash,
    environmentFingerprint: checkHash,
  })
  .strict();
/** Additive wire format: old Mac records keep their original bytes/digests.
 * New writers always include platform; optional here for staged server upgrades. */
export const hostedSelfHostedRunnerSchema = hostedMacRunnerSchema.extend({
  provider: z.literal('self-hosted'),
  platform: z.object({ os: text, arch: text }).strict().optional(),
  labels: z.array(text).optional(),
});
export const hostedMachineRunnerSchema = z.union([hostedMacRunnerSchema, hostedSelfHostedRunnerSchema]);
export const hostedCheckRunnerSchema = z.union([
  hostedMachineRunnerSchema,
  z
    .object({
      provider: z.literal('modal'),
      app: text,
      function: text,
      runtime: checkHash,
      environmentFingerprint: checkHash,
      // A use reference, never a credential value or a developer's local file.
      credential,
    })
    .strict(),
  hostedActionsRunnerSchema,
]);
export const hostedCheckRequestSchema = z
  .object({
    gate: checkGateSchema.optional(),
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    candidateId: z.uuid(),
    expectedHead: checkHash,
    checkId: z.uuid(),
    expectedDefinition: checkHash,
    expectedConfiguration: checkHash,
    expectedEnvironment: checkHash,
  })
  .strict();
/** Prepared by fixed provider code after reading exact source/lockfile/selection.
 * Shard membership and command bytes live in the immutable plan object. Indexes
 * cover [0, shardCount), including the static job where applicable. */
export const hostedCheckPlanSchema = z
  .object({
    head: checkHash,
    definition: checkHash,
    runtime: checkHash,
    environmentFingerprint: checkHash,
    lockfile: checkHash,
    selection: checkObject,
    manifest: checkObject,
    shardCount: checkNumber.refine(n => n > 0),
  })
  .strict();
export const hostedCheckStatusSchema = z.enum([
  'queued',
  'preparing',
  'dispatching',
  'running',
  'unknown',
  'passed',
  'failed',
  'cancelled',
  'interrupted',
  'runner-unavailable',
]);
export const hostedCheckCostSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z
    .object({
      status: z.literal('observed'),
      receipt: checkObject,
      seconds: z.number().finite().nonnegative().nullable(),
      estimatedCostUsd: z.number().finite().nonnegative().nullable(),
    })
    .strict(),
]);
/** Fixed-runner evidence, retained on completion and copied into acceptance.
 * Q3 fills reuseKey with the hosted content key; null never claims reuse. */
export const hostedMacEvidenceSchema = z
  .object({
    provider: z.literal('mac'),
    machineId: z.uuid(),
    machineOwner: text,
    registrationId: z.uuid(),
    reuseKey: checkHash.nullable(),
    runnerFingerprint: checkHash,
  })
  .strict();
export const hostedCheckRunSchema = z
  .object({
    schema: z.literal(1),
    id: z.uuid(),
    projectId: text,
    actor: text,
    at: z.iso.datetime(),
    request: hostedCheckRequestSchema,
    candidate: z
      .object({
        digest: checkHash,
        base: z.object({ head: checkHash, receiptId: text }).strict(),
        inputs: checkObject,
        dependencies: checkObject,
        algorithm: text,
      })
      .strict(),
    check: checkSchema.strict(),
    configuration: hostedCheckRunnerSchema,
    gate: checkGateSchema.optional(),
    semanticPlan: semanticPlanSchema.optional(),
    contractReports: semanticReportsSchema.optional(),
    testFiles: checkFileSummarySchema.optional(),
    checkLogs: checkLogsSchema.optional(),
    keyId: z.string().regex(/^[A-Z0-9_]+$/),
    actions: z
      .object({
        reservedAt: checkNumber,
        fence: checkNumber,
        watchdog: z.string().nullable(),
        outcome: z.enum(['accepted', 'unknown', 'rejected']),
        cancelScheduled: z.boolean().optional(),
        workflowSha: z.string().optional(),
      })
      .strict()
      .optional(),
    dispatchKey: checkHash,
    dispatchStarted: z.boolean(),
    recoveryUsed: z.boolean(),
    emptyLookups: z.array(z.uuid()).max(2),
    executionId: text.nullable(),
    fence: checkNumber,
    leaseRetries: checkNumber.optional(),
    ownerDeadline: checkNumber.optional(),
    failureReason: text.optional(),
    lease: z.object({ owner: z.uuid(), token: checkNumber, until: checkNumber }).strict().nullable(),
    plan: hostedCheckPlanSchema.nullable(),
    planDigest: checkHash.nullable(),
    status: hostedCheckStatusSchema,
    cancelRequested: z.boolean(),
    counts: z.object({ completed: checkNumber, passed: checkNumber, failed: checkNumber }).strict(),
    terminalDigest: checkHash.nullable(),
    macEvidence: hostedMacEvidenceSchema.optional(),
    // Running sum of retained shard execution intervals; shard rows keep each interval.
    execution: z
      .object({ seconds: z.number().finite().nonnegative(), shards: checkNumber })
      .strict()
      .optional(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nullable(),
    output: checkObject.nullable(),
    cost: hostedCheckCostSchema,
  })
  .strict();
export type HostedCheckRun = z.infer<typeof hostedCheckRunSchema>;
export type HostedCheckPlan = z.infer<typeof hostedCheckPlanSchema>;
export const checkPin = (value: unknown) => digest(canonicalPayload(value));
export const hostedCheckTerminal = (run: Pick<HostedCheckRun, 'status'>) =>
  !['queued', 'preparing', 'dispatching', 'running', 'unknown'].includes(run.status);
