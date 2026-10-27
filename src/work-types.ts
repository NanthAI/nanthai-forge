// SPDX-License-Identifier: Apache-2.0
import { intentTestContractSchema } from './intent-test-contract.js';
import { decisionRecordSchema } from './decision-types.js';
import { frictionEventSchema } from './friction-types.js';
import { checkEnvironmentSchema } from './check-environment-schema.js';
export { checkEnvironmentSchema } from './check-environment-schema.js';
import { landingEntrySchema, landingBatchSchema } from './landing-batch-types.js';
import { checkBackendSchema } from './check-backend.js';
import { hostedRecoverySchema } from './recovery-hosted-protocol.js';
import { z } from 'zod';
import { deliveryHandoffSchema } from './agent-handoff-types.js';
import { githubSyncSchema, githubSyncHistorySchema, githubAutoPushSchema } from './github-sync-types.js';
import { workActorSchema } from './work-actor-types.js';
import { autonomyPolicySchema, hostedAcceptanceCommandSchema } from './autonomy-policy.js';
import { nativePrObservationSchema } from './native-pr-pins.js';
import {
  channelBaseSchema,
  intentCreateSchema,
  intentNoteSchema,
  intentStatusSchema,
  metadataCommandSchema,
  sourceAnchorSchema,
} from './work-intent-types.js';
export {
  channelBaseSchema,
  intentCreateSchema,
  intentNoteSchema,
  intentStatusSchema,
  metadataCommandSchema,
  type MetadataCommand,
} from './work-intent-types.js';
import {
  nativeContributionReceiptSchema,
  type NativeContributionCommand,
} from './native-contribution-types.js';
import type { NativeGitContributionCommand } from './native-git-contribution.js';
import type { NativeObjectCommand } from './native-objects.js';
import { historicalWorkSchema, type HistoricalCommand } from './native-history-types.js';
import { companionReceiptSchema, type CompanionCommand } from './native-companion-types.js';
export type { DeclaredInput, InputObservation, InputAssessmentCommand } from './work-input-types.js';
import {
  declaredInputSchema,
  inputObservationSchema,
  type InputAssessmentCommand,
} from './work-input-types.js';
import { planningItemSchema, planningCommentSchema, type PlanningCommand } from './work-planning-types.js';
export {
  planningItemSchema,
  planningCommentSchema,
  planningCommandSchema,
  type PlanningItem,
  type PlanningCommand,
  type PlanningWrite,
} from './work-planning-types.js';
import { safeRelative } from './safe-relative.js';

const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
export type ChannelBase = z.infer<typeof channelBaseSchema>;
export const dependencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('view'), viewId: id, head: oid }),
  z.object({
    kind: z.literal('pr'),
    intentId: id,
    observation: z.number().int().nonnegative(),
    part: z.enum(['head', 'base']).optional(),
    head: oid,
  }),
]);
export type DependencyPin = z.infer<typeof dependencySchema>;
export const noteSchema = z.object({
  handoff: deliveryHandoffSchema.optional(),
  text: z.string().min(1).max(4000),
  at: z.string(),
  kind: z.enum(['comment', 'decision']),
  anchor: sourceAnchorSchema.optional(),
});
export const gitProjectionSchema = z.object({
  state: z.string().regex(/^[0-9a-f]{64}$/),
  head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  format: z.enum(['sha1', 'sha256']),
  bundle: z.string().regex(/^[0-9a-f]{64}$/),
  mapping: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GitProjection = z.infer<typeof gitProjectionSchema>;
export const githubObservationSchema = z.object({
  at: z.string(),
  head: oid,
  base: oid,
  headRef: z.string(),
  baseRef: z.string(),
  title: z.string(),
  author: z.object({ id: z.number().int().positive(), login: z.string().min(1) }),
  prState: z.enum(['open', 'closed']),
  merged: z.boolean(),
  acceptance: z.enum(['unconfirmed', 'accepted']),
  acceptedCommit: oid.optional(),
  baseHead: oid.optional(),
  bundle: oid.optional(),
  native: nativePrObservationSchema.optional(),
  details: z.string(),
});
export const externalSchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  author: z.object({ id: z.number().int().positive(), login: z.string().min(1) }),
  observations: z.array(githubObservationSchema).min(1),
});
const agentOperationSchema = z.object({ id, request: z.string().regex(/^[0-9a-f]{64}$/) });
const lifecycleSchema = z.array(
  z.object({
    from: z.string(),
    to: z.string(),
    at: z.string(),
    reason: z.string().optional(),
    actor: workActorSchema.optional(),
    operation: agentOperationSchema.optional(),
  }),
);
export const captureCoverageSchema = z.object({
  included: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  excluded: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export const automaticActionSchema = z.object({
  actor: z.string(),
  summary: z.string(),
  undo: z.string(),
  runId: z.string().uuid().optional(),
  policy: autonomyPolicySchema.optional(),
});
export const stackSchema = z.object({
  entryId: id.optional(),
  laneId: id,
  startHead: oid,
  head: oid,
  channel: z.string(),
  detached: z.boolean().optional(),
});
export const stackSyncSchema = z.object({
  base: oid,
  before: stackSchema,
  after: stackSchema,
});
const undoSyncDetailsSchema = z.object({
  parent: oid,
  head: oid,
  target: oid,
  status: z.enum(['merged', 'conflict']),
});
const checkpointSchema = z.object({
  workRevision: z.number().safe().nonnegative().optional(),
  actor: workActorSchema.optional(),
  head: oid,
  parent: oid,
  message: z.string(),
  at: z.string(),
  operation: agentOperationSchema.optional(),
  captureCoverage: captureCoverageSchema.optional(),
  automatic: automaticActionSchema.optional(),
  sync: z
    .object({
      channel: z.string(),
      target: oid,
      operation: agentOperationSchema.optional(),
      conflicts: z.array(z.object({ path: z.string(), kind: z.enum(['text', 'binary']) })).optional(),
      changedPaths: z.array(z.string()),
      stack: stackSyncSchema.optional(),
      status: z.enum(['merged', 'conflict']).optional(),
    })
    .optional(),
  undoSync: z.string().uuid().optional(),
  undoSyncDetails: undoSyncDetailsSchema.optional(),
});
export const afterSchema = z.union([z.object({ intentId: id }).strict(), z.object({ viewId: id }).strict()]);
export const laneSchema = z.object({
  startReceipt: z
    .object({
      revision: z.number().safe().nonnegative(),
      result: z.record(z.string(), z.unknown()),
    })
    .optional(),
  agentStart: agentOperationSchema.optional(),
  after: afterSchema.optional(),
  stack: stackSchema.optional(),
  id,
  startedBy: workActorSchema.optional(),
  startedAt: z.string().optional(),
  scope: z.object({ paths: z.array(z.string().refine(safeRelative)) }).optional(),
  owner: z.object({ actor: z.string(), at: z.string(), operationId: id, request: z.string() }).optional(),
  handovers: z
    .array(
      z.object({
        operationId: id,
        request: z.string(),
        actor: z.string(),
        from: z.string().optional(),
        at: z.string(),
        superseded: z.array(id),
        head: oid,
      }),
    )
    .optional(),
  setup: z.object({ machine: z.string(), mcpConfigured: z.boolean() }).optional(),
  intentId: id,
  name: z.string().min(1).max(120),
  base: oid,
  head: oid,
  assignment: z.string().max(200),
  target: z.string().max(200),
  state: z.enum(['creating', 'active', 'paused', 'ready', 'completed', 'abandoned']),
  lifecycle: lifecycleSchema.optional(),
  checkpoints: z.array(checkpointSchema),
  pending: checkpointSchema.optional(),
  pendingSync: checkpointSchema.optional(),
  /** Unresolved sync target; resolution checkpoints retain both source heads. */
  pendingUndo: z
    .object({
      operation: agentOperationSchema,
      from: oid,
      target: oid,
      syncOperationId: id,
      syncDetails: undoSyncDetailsSchema.optional(),
      forced: z.boolean(),
      branchFrom: oid.optional(),
    })
    .optional(),
  pendingMerge: z
    .object({
      parent: oid,
      workspaceHead: oid.optional(),
      stack: stackSyncSchema.optional(),
      channel: z.string(),
      operation: agentOperationSchema,
      conflicts: z.array(z.object({ path: z.string(), kind: z.enum(['text', 'binary']) })),
      automatic: automaticActionSchema.optional(),
      changedPaths: z.array(z.string()).optional(),
    })
    .optional(),
  parent: z.object({ laneId: id, head: oid }).optional(),
  nativeContributionId: id.optional(),
  contribution: z
    .object({
      request: oid,
      head: oid,
      base: oid,
      ref: z.string(),
      size: z.number().safe().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      at: z.string(),
      provenance: z.literal('unverified-git-bundle'),
    })
    .optional(),
});
export const intentSchema = z.object({
  testContracts: z.array(intentTestContractSchema).optional(),
  id,
  mainCheckFailure: z.object({ channel: z.string(), head: oid, landingId: id, runId: id }).optional(),
  agentStart: agentOperationSchema.extend({ laneId: id }).optional(),
  outcome: z.string().min(1).max(500),
  constraints: z.string().max(4000),
  base: oid,
  status: z.enum(['active', 'ready', 'abandoned', 'completed']),
  lifecycle: lifecycleSchema.optional(),
  notes: z.array(noteSchema),
  createdAt: z.string(),
  external: externalSchema.optional(),
  dependencies: z.array(dependencySchema).optional(),
  baseChannel: channelBaseSchema.optional(),
  hostedBase: channelBaseSchema.optional(),
});
export const recoveryCheckSchema = z.object({
  auditRunId: id,
  phase: z.enum(['retry', 'bisect', 'revert']),
  tests: z.array(z.string()).optional(),
});
export const viewSchema = z.object({
  optimistic: z.boolean().optional(),
  recovery: recoveryCheckSchema.optional(),
  id,
  intentId: id,
  base: oid,
  composedMain: oid.optional(),
  mainCheck: z.object({ channel: z.string() }).optional(),
  resolution: z.object({ viewId: id, laneId: id, head: oid }).optional(),
  operation: z.object({ id, request: oid }).optional(),
  inputs: z.array(z.object({ laneId: id, head: oid })),
  status: z.enum(['clean', 'conflict']),
  head: oid.optional(),
  details: z.string(),
  at: z.string(),
  dependencies: z.array(dependencySchema).optional(),
});
export const publishSchema = z.object({
  action: z.literal('publish'),
  operationId: id,
  viewId: id,
  expectedHead: oid,
  repository: z.string().trim().min(1),
  base: z.string().trim().default(''),
  title: z.string().trim().min(1),
  draft: z.boolean().default(false),
});
export const publicationSchema = z.object({
  id,
  viewId: id,
  head: oid,
  repository: z.string(),
  base: z.string(),
  title: z.string(),
  draft: z.boolean(),
  at: z.string(),
  projection: gitProjectionSchema.optional(),
  status: z.enum(['pending', 'published']),
  upstream: z.object({ head: oid, status: z.enum(['clean', 'conflict']), details: z.string() }).optional(),
  number: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  prState: z.enum(['open', 'closed']).optional(),
  merged: z.boolean().optional(),
  checks: z.array(githubObservationSchema).optional(),
});
export const githubWorkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import-pr'), url: z.string().trim().min(1) }),
  z.object({ action: z.literal('check-pr'), intentId: id }),
  z.object({ action: z.literal('check-publication'), publicationId: id }),
]);
const artifactPaths = z.array(
  z
    .string()
    .refine(
      path => safeRelative(path) && !path.toLowerCase().split('/').includes('.git'),
      'Select relative build-output file paths.',
    ),
);
const checkEnvNames = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const checkSchema = z.object({
  id,
  name: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  args: z.array(z.string()),
  environmentLabel: z.string(),
  env: checkEnvNames.optional(),
  credentials: checkEnvNames.optional(),
  artifactPaths: artifactPaths.optional(),
  static: z.boolean().optional(),
  measureResources: z.boolean().optional(),
  declaredInputs: z.array(declaredInputSchema).optional(),
  definition: oid,
  at: z.string(),
});
const artifactSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('retained'),
    sourcePath: z.string(),
    filename: z.string().regex(/^artifact-[0-9]+\.bin$/),
    size: z.number().safe().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ status: z.literal('unavailable'), sourcePath: z.string(), details: z.string() }),
]);
const resourceUsageSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('measured'),
    producer: z.string(),
    realSeconds: z.number().finite().nonnegative(),
    userSeconds: z.number().finite().nonnegative(),
    systemSeconds: z.number().finite().nonnegative(),
    peakRssBytes: z.number().safe().nonnegative(),
    report: z.string(),
    details: z.string(),
  }),
  z.object({ status: z.literal('unavailable'), producer: z.string().optional(), details: z.string() }),
]);
export const interactionRequestSchema = z.object({
  version: z.literal(1),
  reusedRunId: id,
  base: oid,
  checkedHead: oid,
  main: oid,
});
export const interactionEvidenceSchema = interactionRequestSchema.extend({
  mergedHead: oid,
  eligible: z.boolean(),
  reason: z.string(),
  mainRunId: id.optional(),
  basis: z.enum(['docs-overlap', 'main-full-coverage']).optional(),
  lanePaths: z.array(z.string()),
  mainPaths: z.array(z.string()),
  overlap: z.array(z.string()),
});
export const explicitTestsSchema = z
  .array(
    z
      .string()
      .refine(
        path =>
          safeRelative(path) &&
          path.startsWith('tests/') &&
          path.endsWith('.test.mjs') &&
          !/[\x00-\x1f\x7f*?\[\]{}!]/.test(path),
        'Use a relative tests/*.test.mjs file path.',
      ),
  )
  .transform(tests => [...new Set(tests)].sort());
export const checkRunSchema = z
  .object({
    reuseKey: oid.optional(),
    reusedFrom: z.object({ runId: id, endedAt: z.string(), evidence: oid }).optional(),
    supersessionBaseline: id.optional(),
    optimistic: z.boolean().optional(),
    recovery: recoveryCheckSchema.optional(),
    backend: checkBackendSchema.optional(),
    id,
    detailRef: z
      .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
      .optional(),
    detailSummary: z
      .object({
        tests: z.number().safe().nonnegative(),
        coverageTests: z.number().safe().nonnegative(),
        verdicts: z.record(z.string(), z.number().safe().nonnegative()),
        failedTests: z.array(z.string().max(512)).max(20),
      })
      .optional(),
    failureSummary: z.string().max(4096).optional(),
    mainCheck: z.object({ channel: z.string() }).optional(),
    viewId: id,
    head: oid,
    base: oid,
    inputs: viewSchema.shape.inputs,
    dependencies: z.array(dependencySchema),
    check: checkSchema,
    environment: checkEnvironmentSchema,
    inputObservations: z.array(inputObservationSchema).optional(),
    comparisonBase: oid.optional(),
    interaction: interactionEvidenceSchema.nullable().optional(),
    checkSelection: z
      .object({
        partial: z.boolean().optional(),
        scope: z.enum(['docs', 'interaction', 'scoped', 'full', 'partial']),
        reason: z.string(),
        tests: z.array(z.string()),
        coverage: z
          .object({
            mode: z.literal('shadow'),
            head: oid.optional(),
            age: z.number().int().nonnegative().optional(),
            currentCount: z.number().int().nonnegative(),
            coverageCount: z.number().int().nonnegative(),
            tests: z.array(z.string()),
            fallback: z.string().nullable(),
          })
          .optional(),
      })
      .optional(),
    status: z.enum([
      'queued',
      'preparing',
      'running',
      'passed',
      'failed',
      'cancelled',
      'interrupted',
      'runner-unavailable',
      'runner-budget-exhausted',
    ]),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    // A virtual reuse receipt has no process. Older readers reject PID 0 rather
    // than stripping reusedFrom and treating it as an independently executed pass.
    runner: z
      .object({ pid: z.number().int().nonnegative(), host: z.string(), startTime: z.string().optional() })
      .refine(runner => runner.pid > 0 || runner.host === 'retained-check'),
    childPid: z.number().int().positive().optional(),
    childStartTime: z.string().optional(),
    queuedAt: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    cancellation: z
      .object({
        reason: z.enum(['command', 'superseded', 'signal', 'queue']),
        at: z.string(),
        actor: z
          .union([workActorSchema, z.object({ kind: z.literal('system'), name: z.string() })])
          .optional(),
        details: z.string().optional(),
        signal: z.string().optional(),
        supersededBy: id.optional(),
      })
      .optional(),
    cancelRequested: z.boolean().optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    details: z.string(),
    playbookRunId: id.optional(),
    artifacts: z.array(artifactSchema).optional(),
    resourceUsage: resourceUsageSchema.optional(),
  })
  .refine(run => (run.runner.pid === 0) === Boolean(run.reusedFrom), {
    message:
      'A virtual check must retain its source run; executed checks must retain their process identity.',
  });
export const playbookSchema = z.object({
  id,
  name: z.string().trim().min(1),
  checkIds: z.array(id).min(1),
  definition: oid,
  at: z.string(),
});
export const automationEventSchema = z.enum(['clean-view', 'channel-accepted', 'release-created']);
export const automationSchema = z.object({
  id,
  name: z.string().trim().min(1),
  intentId: id,
  enabled: z.boolean(),
  version: z.number().int().positive().default(1),
  event: automationEventSchema.default('clean-view'),
  playbook: playbookSchema,
  checks: z.array(checkSchema).min(1),
  environment: checkEnvironmentSchema,
  onFailure: z.enum(['stop', 'continue']),
  definition: oid,
  at: z.string(),
});
export const playbookRunSchema = z.object({
  id,
  viewId: id,
  head: oid,
  base: oid,
  inputs: viewSchema.shape.inputs,
  automation: z
    .object({ id, name: z.string(), definition: oid, event: automationEventSchema, eventId: id.optional() })
    .optional(),
  dependencies: z.array(dependencySchema),
  playbook: playbookSchema,
  steps: z.array(z.object({ runId: id, check: checkSchema })).min(1),
  environment: checkEnvironmentSchema,
  onFailure: z.enum(['stop', 'continue']),
  status: z.enum([
    'running',
    'passed',
    'failed',
    'cancelled',
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  runner: checkRunSchema.shape.runner,
  cancellation: checkRunSchema.shape.cancellation,
  cancelRequested: z.boolean().optional(),
  details: z.string(),
});
export const playbookCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('define-playbook'),
    playbookId: id.optional(),
    name: z.string().trim().min(1),
    checkIds: z.array(id).min(1),
  }),
  z.object({
    action: z.literal('run-playbook'),
    operationId: id,
    playbookId: id,
    viewId: id,
    expectedHead: oid,
    expectedDefinition: oid,
    expectedEnvironment: oid,
    expectedChecks: z.array(z.object({ id, definition: oid })).min(1),
    onFailure: z.enum(['stop', 'continue']).default('stop'),
  }),
  z.object({
    action: z.literal('cancel-playbook'),
    operationId: id,
    actor: workActorSchema.optional(),
    reason: z.string().optional(),
  }),
  z.object({ action: z.literal('export-playbook'), kind: z.enum(['definition', 'run', 'automation']), id }),
]);
export const invariantPinSchema = z.object({ id, definition: oid });
export const discussionTargetSchema = z.object({ kind: z.enum(['intent', 'publication']), id });
export const githubReviewPolicySchema = z.object({
  target: discussionTargetSchema,
  accountIds: z.array(z.number().int().positive().safe()).min(1),
});
export const githubApprovalSchema = z.object({
  definition: oid,
  target: discussionTargetSchema,
  repository: z.string(),
  number: z.number().int().positive().safe(),
  beforeHead: oid,
  afterHead: oid,
  checkedAt: z.string(),
  complete: z.boolean(),
  reviews: z.array(
    z.object({
      accountId: z.number().int().positive().safe(),
      login: z.string().optional(),
      reviewId: z.number().int().positive().safe().optional(),
      decision: z.string().optional(),
      head: oid.optional(),
      submittedAt: z.string().optional(),
      satisfied: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
});
export const invariantSchema = z.object({
  id,
  operationId: id,
  request: oid,
  previousDefinition: oid.optional(),
  version: z.number().int().positive(),
  intentId: id,
  name: z.string().trim().min(1),
  statement: z.string(),
  checkIds: z.array(id),
  reviewers: z.array(z.string().trim().min(1)),
  githubReview: githubReviewPolicySchema.optional(),
  definition: oid,
  at: z.string(),
});
export const reviewSchema = z.object({
  id,
  viewId: id,
  head: oid,
  reviewer: z.string().trim().min(1),
  decision: z.enum(['approve', 'request-changes', 'comment']),
  text: z.string().default(''),
  at: z.string(),
  provenance: z.literal('user-declared'),
  invariant: invariantPinSchema.optional(),
});
export const invariantAssessmentSchema = z.object({
  policy: invariantSchema,
  currentPolicy: z.boolean(),
  viewId: id,
  head: oid,
  base: oid,
  inputs: viewSchema.shape.inputs,
  dependencies: z.array(dependencySchema),
  environment: checkEnvironmentSchema,
  satisfied: z.boolean(),
  at: z.string(),
  coverage: z.string(),
  githubReview: githubApprovalSchema.optional(),
  checks: z.array(
    z.object({
      id,
      name: z.string(),
      definition: oid.optional(),
      runId: id.optional(),
      status: z.enum([
        'passed',
        'failed',
        'cancelled',
        'interrupted',
        'runner-unavailable',
        'runner-budget-exhausted',
        'pending',
        'missing',
        'stale',
      ]),
      reasons: z.array(z.string()),
    }),
  ),
  reviews: z.array(
    z.object({
      reviewer: z.string(),
      reviewId: id.optional(),
      decision: reviewSchema.shape.decision.optional(),
      satisfied: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
});
export const invariantCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('define-invariant'),
    operationId: id,
    invariantId: id,
    expectedDefinition: oid.optional(),
    intentId: id,
    name: z.string().trim().min(1),
    statement: z.string().default(''),
    checkIds: z.array(id).default([]),
    reviewers: z.array(z.string().trim().min(1)).default([]),
    githubReview: githubReviewPolicySchema.optional(),
  }),
  z.object({
    action: z.literal('assess-invariant'),
    ...invariantPinSchema.shape,
    viewId: id,
    expectedHead: oid,
  }),
]);
export type Invariant = z.infer<typeof invariantSchema>;
export type InvariantAssessment = z.infer<typeof invariantAssessmentSchema>;
export type InvariantCommand = z.infer<typeof invariantCommandSchema>;
export const githubCheckSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  head_sha: oid,
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  app: z
    .object({ id: z.number().int().positive(), name: z.string(), slug: z.string().nullable().optional() })
    .nullable(),
});
export const githubChecksSchema = z.object({
  id,
  viewId: id,
  head: oid,
  repository: z.string(),
  at: z.string(),
  projection: gitProjectionSchema.optional(),
  checks: z.array(githubCheckSchema),
  details: z.string(),
});
export const discussionFeedSchema = z.enum(['conversation', 'reviews', 'inline']);
export const discussionRecordSchema = z.object({
  id,
  target: discussionTargetSchema,
  repository: z.string(),
  number: z.number().int().positive(),
  head: oid,
  providerHead: oid,
  feed: discussionFeedSchema,
  page: z.number().int().positive().safe(),
  at: z.string(),
  count: z.number().int().nonnegative(),
  more: z.boolean(),
  digest: oid,
});
export const discussionCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('import-discussion'),
    operationId: id,
    target: discussionTargetSchema,
    feed: discussionFeedSchema,
    page: z.number().int().positive().safe().default(1),
  }),
  z.object({ action: z.enum(['read-discussion', 'export-discussion']), id }),
]);
export type DiscussionCommand = z.infer<typeof discussionCommandSchema>;
export type DiscussionRecord = z.infer<typeof discussionRecordSchema>;
export const ownerAcceptanceEvidenceSchema = z.object({
  viewId: z.uuid(),
  head: z.string(),
  expectedMain: z.string().nullable(),
  disjoint: z
    .object({
      base: z.string(),
      viewPaths: z.array(z.string()),
      mainPaths: z.array(z.string()),
      currentMain: z.string(),
    })
    .optional(),
});
export const fastPathEvidenceSchema = z.object({
  policy: autonomyPolicySchema,
  kind: z.literal('disjoint-fast-path'),
  checkedViewId: id,
  checkedHead: oid,
  runId: id,
  checkDefinition: oid,
  environmentFingerprint: oid,
  composedMain: oid,
  previousMain: oid,
  lanePaths: z.array(z.string()),
  mainPaths: z.array(z.string()),
  cleanComposition: z.literal(true),
  descendant: z.literal(true),
  postAccept: z.object({ checkId: id, mode: z.literal('full'), required: z.literal(true) }),
});
export const channelMoveSchema = z.object({
  ownerRequest: ownerAcceptanceEvidenceSchema.optional(),
  id,
  acceptedBy: workActorSchema.optional(),
  channel: z.string().trim().min(1),
  viewId: id,
  head: oid,
  previous: oid.nullable(),
  at: z.string(),
  status: z.enum(['pending', 'accepted']),
  provenance: z.literal('user-declared-local'),
  fastPath: fastPathEvidenceSchema.optional(),
  acceptanceRequest: oid.optional(),
  postAcceptRunId: id.optional(),
  postAcceptAuditRunId: id.optional(),
  optimisticRecovery: z
    .object({
      auditRunId: id,
      status: z.enum(['flaky', 'fix-forward', 'reverted']),
      culpritIds: z.array(id),
      acceptanceId: id.optional(),
    })
    .optional(),
  postAccept: z
    .object({
      checkId: id,
      mode: z.literal('full'),
      reason: z.enum(['disjoint-fast-path', 'scoped-check', 'batch']),
    })
    .optional(),
  invariant: invariantAssessmentSchema.optional(),
  automatic: automaticActionSchema.optional(),
});
export const hostedChannelCommandSchema = hostedAcceptanceCommandSchema;
export const hostedChannelMoveSchema = hostedChannelCommandSchema.omit({ action: true }).extend({
  id,
  actor: z.string().min(1),
  at: z.string(),
  projectKey: z.uuid(),
  provenance: z.literal('signed-in-owner-selection'),
  automatic: automaticActionSchema.optional(),
});
export type HostedChannelMove = z.infer<typeof hostedChannelMoveSchema>;
export const channelCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept-channel'),
    operationId: id,
    authorityEpoch: z.number().safe().nonnegative().optional(),
    reuseRunId: id.optional(),
    channel: z.string().trim().min(1),
    viewId: id,
    expectedHead: oid,
    expectedPrevious: oid.nullable(),
    invariant: invariantPinSchema.optional(),
  }),
  z.object({ action: z.literal('export-channel'), id }),
]);
export type ChannelMove = z.infer<typeof channelMoveSchema>;
export type ChannelCommand = z.infer<typeof channelCommandSchema>;
const mirrorDestinationSchema = z.object({ branch: z.string().trim().min(1), previous: oid.nullable() });
export const mirrorSchema = z.object({
  id,
  request: oid,
  acceptance: channelMoveSchema,
  repository: z.string(),
  repositoryId: z.number().safe().positive(),
  ref: z.string(),
  at: z.string(),
  confirmedAt: z.string().optional(),
  observationSequence: z.number().safe().nonnegative(),
  observation: z
    .object({ at: z.string(), head: oid.nullable(), status: z.enum(['missing', 'matching', 'diverged']) })
    .optional(),
  destination: mirrorDestinationSchema.optional(),
  diagnostic: z.enum(['lease-changed', 'non-fast-forward']).optional(),
});
export const mirrorCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mirror-channel'),
    operationId: id,
    acceptanceId: id,
    expectedHead: oid,
    repository: z.string().trim().min(1),
    destination: mirrorDestinationSchema.optional(),
  }),
  z.object({ action: z.literal('check-mirror'), id }),
]);
export type MirrorCommand = z.infer<typeof mirrorCommandSchema>;
export const sourceReleaseSchema = z.object({
  id,
  request: oid,
  name: z.string().trim().min(1),
  notes: z.string(),
  acceptance: channelMoveSchema,
  at: z.string(),
  provenance: z.literal('user-declared-local'),
  buildRuns: z.array(checkRunSchema).optional(),
});
export const releaseCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create-release'),
    operationId: id,
    acceptanceId: id,
    expectedHead: oid,
    name: z.string().trim().min(1),
    notes: z.string().default(''),
    buildRunIds: z.array(id).optional(),
  }),
  z.object({ action: z.literal('export-release'), id }),
]);
export type SourceRelease = z.infer<typeof sourceReleaseSchema>;
export type ReleaseCommand = z.infer<typeof releaseCommandSchema>;
export const deploymentFileSchema = z.object({
  runId: id,
  sourcePath: z.string(),
  path: z.string(),
  size: z.number().safe().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const deploymentSchema = z.object({
  id,
  request: oid,
  releaseId: id,
  releaseDefinition: oid,
  head: oid,
  siteId: id,
  files: z.array(deploymentFileSchema),
  at: z.string(),
  attemptedAt: z.string().optional(),
  directory: z.string().optional(),
  providerId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  providerConfirmedAt: z.string().optional(),
  observationSequence: z.number().safe().nonnegative().default(0),
  observation: z
    .object({
      at: z.string(),
      providerId: z.string().nullable(),
      state: z.string(),
      context: z.string().nullable(),
      publishedAt: z.string().nullable(),
      url: z.string().nullable(),
      files: z.array(
        z.object({
          path: z.string(),
          status: z.enum(['verified', 'unconfirmed']),
          httpStatus: z.number().optional(),
          size: z.number().safe().nonnegative().optional(),
          sha256: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
export const deploymentCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('deploy-release'),
    operationId: id,
    releaseId: id,
    expectedHead: oid,
    siteId: id.toLowerCase(),
    files: z.array(z.object({ runId: id, sourcePath: z.string().min(1), path: z.string().min(1) })).min(1),
  }),
  z.object({ action: z.literal('check-deployment'), id }),
]);
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentCommand = z.infer<typeof deploymentCommandSchema>;
export const environmentMoveSchema = z.object({
  id,
  request: oid,
  name: z.string().trim().min(1),
  previous: id.nullable(),
  at: z.string(),
  deployment: deploymentSchema.pick({
    id: true,
    releaseId: true,
    releaseDefinition: true,
    head: true,
    siteId: true,
    files: true,
    providerId: true,
    observation: true,
  }),
});
export const environmentCommandSchema = z.object({
  action: z.literal('select-preview-environment'),
  operationId: id,
  name: z.string().trim().min(1),
  deploymentId: id,
  expectedPrevious: id.nullable(),
});
export type EnvironmentCommand = z.infer<typeof environmentCommandSchema>;
export const evidenceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('export-check'), id }),
  z.object({
    action: z.literal('run-check'),
    tests: explicitTestsSchema.optional(),
    operationId: id,
    viewId: id,
    expectedHead: oid,
    checkId: id,
    expectedDefinition: oid,
    expectedEnvironment: oid,
    interaction: interactionRequestSchema.nullable().optional(),
  }),
  z.object({
    action: z.literal('cancel-check'),
    operationId: id,
    actor: workActorSchema.optional(),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('read-check-output'),
    shard: z.union([z.number().int().nonnegative(), z.literal('static')]).optional(),
    attempt: z.number().int().positive().optional(),
    operationId: id,
    stream: z.enum(['stdout', 'stderr']),
    offset: z.number().int().nonnegative().default(0),
    bytes: z.number().int().min(1).max(65536).default(16384),
    /** Read the last `tail` bytes instead of a page at `offset`. */
    tail: z.number().int().min(1).max(65536).optional(),
  }),
  z.object({
    action: z.literal('import-checks'),
    operationId: id,
    viewId: id,
    expectedHead: oid,
    repository: z.string().trim().min(1),
    destination: mirrorDestinationSchema.optional(),
  }),
]);
export const sourceReturnSchema = z.object({
  action: z.literal('source-return'),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  workSha256: z.string().regex(/^[0-9a-f]{64}$/),
  previousArchiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  previousRevision: z.number().safe().nonnegative(),
});
export const hostedCommandSchema = z.union([
  metadataCommandSchema,
  sourceReturnSchema,
  hostedChannelCommandSchema,
]);
export const hostedEventSchema = z.object({
  automatic: automaticActionSchema.optional(),
  id,
  projectKey: z.uuid(),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  actor: z.string().min(1),
  at: z.string(),
  request: oid,
  previousRevision: z.number().safe().nonnegative(),
  command: hostedCommandSchema,
});
export type HostedEvent = z.infer<typeof hostedEventSchema>;
export const workSchema = z
  .object({
    nativeHead: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    historicalWork: z.array(historicalWorkSchema).optional(),
    nativeCompanionReceipts: z.array(companionReceiptSchema).optional(),
    nativeContributionReceipts: z.array(nativeContributionReceiptSchema).optional(),
    schema: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(12),
      z.literal(13),
      z.literal(14),
      z.literal(15),
      z.literal(17),
      z.literal(19),
      z.literal(21),
      z.literal(23),
    ]),
    landingEntries: z.array(landingEntrySchema).optional(),
    landingBatches: z.array(landingBatchSchema).optional(),
    revision: z.number().int().nonnegative(),
    autonomyPolicy: autonomyPolicySchema.optional(),
    policyChanges: z
      .array(
        z.object({
          id,
          request: oid,
          actor: z.string(),
          at: z.string(),
          previous: autonomyPolicySchema,
          policy: autonomyPolicySchema,
        }),
      )
      .optional(),
    automaticActions: z
      .array(
        z.object({
          id,
          at: z.string(),
          action: automaticActionSchema,
          result: z.string().optional(),
          resultRef: z
            .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
            .optional(),
        }),
      )
      .optional(),
    frictionEvents: z.array(frictionEventSchema).optional(),
    decisions: z.array(decisionRecordSchema).optional(),
    hostedEvents: z.array(hostedEventSchema).default([]),
    intents: z.array(intentSchema),
    lanes: z.array(laneSchema),
    views: z.array(viewSchema),
    githubSync: githubSyncSchema.optional(),
    // New collections stay absent in old checkpoints so journal digests remain exact.
    githubSyncHistory: z.array(githubSyncHistorySchema).optional(),
    githubAutoPush: githubAutoPushSchema.optional(),
    mirrors: z.array(mirrorSchema).default([]),
    publications: z.array(publicationSchema).default([]),
    checks: z.array(checkSchema).default([]),
    runs: z.array(checkRunSchema).default([]),
    reviews: z.array(reviewSchema).default([]),
    githubChecks: z.array(githubChecksSchema).default([]),
    playbooks: z.array(playbookSchema).default([]),
    playbookRuns: z.array(playbookRunSchema).default([]),
    automations: z.array(automationSchema).default([]),
    githubDiscussions: z.array(discussionRecordSchema).default([]),
    channelMoves: z.array(channelMoveSchema).default([]),
    invariants: z.array(invariantSchema).default([]),
    planningItems: z.array(planningItemSchema).default([]),
    planningComments: z.array(planningCommentSchema).default([]),
    releases: z.array(sourceReleaseSchema).default([]),
    deployments: z.array(deploymentSchema).default([]),
    environmentMoves: z.array(environmentMoveSchema).default([]),
    hostedChannelMoves: z.array(hostedChannelMoveSchema).optional(),
    hostedRecovery: hostedRecoverySchema.optional(),
  })
  .refine(
    data =>
      ((!data.landingEntries?.length &&
        !data.landingBatches?.length &&
        !data.channelMoves.some(move => move.postAccept?.reason === 'batch')) ||
        data.schema >= 17) &&
      (!data.runs.some(
        run =>
          run.interaction !== undefined ||
          ['interaction', 'partial'].includes(run.checkSelection?.scope ?? ''),
      ) ||
        data.schema >= 15) &&
      ((!data.autonomyPolicy?.acceptance.disjointFastPath &&
        !data.channelMoves.some(move => move.fastPath)) ||
        data.schema >= 14) &&
      ((!data.lanes.some(
        lane => lane.state === 'abandoned' || lane.lifecycle?.some(entry => entry.operation),
      ) &&
        !data.intents.some(intent => intent.lifecycle?.some(entry => entry.operation))) ||
        data.schema >= 13) &&
      ((!data.runs.some(run => run.detailRef) && !data.automaticActions?.some(action => action.resultRef)) ||
        data.schema >= 23) &&
      (!data.lanes.some(lane => lane.stack) || data.schema >= 21) &&
      (!data.lanes.some(
        lane =>
          lane.after ||
          lane.agentStart ||
          lane.pending?.actor ||
          lane.pendingSync?.actor ||
          lane.checkpoints.some(save => save.actor),
      ) ||
        data.schema >= 12) &&
      ((!data.autonomyPolicy &&
        !data.policyChanges?.length &&
        !data.automaticActions?.length &&
        !data.channelMoves.some(move => move.automatic) &&
        !data.lanes.some(lane => lane.checkpoints.some(cp => cp.automatic || cp.undoSync))) ||
        data.schema >= 11) &&
      (!data.lanes.some(lane => lane.pendingMerge) || data.schema >= 10) &&
      (!data.intents.some(intent => intent.notes.some(note => note.anchor)) || data.schema >= 9) &&
      ((!data.intents.some(intent => intent.status === 'completed' || intent.lifecycle?.length) &&
        !data.lanes.some(lane => lane.state === 'completed' || lane.lifecycle?.length)) ||
        data.schema >= 8) &&
      ((!data.intents.some(intent => intent.agentStart) &&
        !data.lanes.some(
          lane => lane.pending?.operation || lane.checkpoints.some(checkpoint => checkpoint.operation),
        )) ||
        data.schema >= 7) &&
      (!data.nativeContributionReceipts?.some(item => item.provenance === 'unverified-git-bundle') ||
        data.schema >= 6) &&
      (!data.historicalWork?.length || data.schema >= 2) &&
      (!data.nativeCompanionReceipts?.length || data.schema >= 3) &&
      ((!data.nativeContributionReceipts?.length && !data.lanes.some(lane => lane.nativeContributionId)) ||
        data.schema >= 4) &&
      ((!data.checks.some(check => check.declaredInputs?.length) &&
        !data.runs.some(run => run.check.declaredInputs?.length || run.inputObservations?.length) &&
        !data.automations.some(rule => rule.checks.some(check => check.declaredInputs?.length)) &&
        !data.playbookRuns.some(run => run.steps.some(step => step.check.declaredInputs?.length))) ||
        data.schema >= 5) &&
      (!data.intents.some(intent => intent.external?.observations.some(observation => observation.native)) ||
        (data.schema >= 5 && !!data.nativeHead)) &&
      (data.schema === 1 || data.schema >= 5 || !!data.nativeHead) &&
      ((!data.historicalWork?.length &&
        !data.nativeCompanionReceipts?.length &&
        !data.nativeContributionReceipts?.length &&
        !data.lanes.some(lane => lane.nativeContributionId)) ||
        !!data.nativeHead),
    'Extended Work requires its versioned format; native history retains its native owner.',
  );
export type WorkData = z.infer<typeof workSchema>;
export type Lane = z.infer<typeof laneSchema>;
export type WorkView = z.infer<typeof viewSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type PublishCommand = z.infer<typeof publishSchema>;
export type GithubObservation = z.infer<typeof githubObservationSchema>;
export type ExternalIntent = z.infer<typeof externalSchema>;
export type Check = z.infer<typeof checkSchema>;
export type CheckRun = z.infer<typeof checkRunSchema>;
export type CheckEnvironment = z.infer<typeof checkEnvironmentSchema>;
export type EvidenceCommand = z.infer<typeof evidenceCommandSchema>;
export type PlaybookRun = z.infer<typeof playbookRunSchema>;
export type PlaybookCommand = z.infer<typeof playbookCommandSchema>;
export type Automation = z.infer<typeof automationSchema>;
export const historyCommandSchema = z.object({
  action: z.enum(['read-history', 'export-history']),
  viewId: id,
  expectedHead: oid,
  offset: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(100).default(20),
});
export type HistoryCommand = z.infer<typeof historyCommandSchema>;
export const interactionCommandSchema = z.object({
  action: z.literal('compare-views'),
  viewId: id,
  expectedHead: oid,
  otherViewId: id,
  otherHead: oid,
  offset: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(100).default(20),
});
export type InteractionCommand = z.infer<typeof interactionCommandSchema>;

export const defineCheckCommandSchema = z.object({
  action: z.literal('define-check'),
  checkId: id.optional(),
  name: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  environmentLabel: z.string().default(''),
  env: checkEnvNames.optional(),
  credentials: checkEnvNames.optional(),
  artifactPaths: artifactPaths.optional(),
  static: z.boolean().optional(),
  measureResources: z.boolean().optional(),
  declaredInputs: z.array(declaredInputSchema).optional(),
});
export const commandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve-native-view'),
    operationId: id,
    viewId: id,
    laneId: id,
    expectedHead: oid,
  }),
  intentCreateSchema.extend({ operationId: id.optional() }),
  z.object({
    action: z.literal('lane'),
    intentId: id,
    name: z.string().trim().min(1).max(120),
    assignment: z.string().max(200).default(''),
    target: z.string().max(200).default(''),
  }),
  z.object({
    action: z.literal('child-lane'),
    parentLaneId: id,
    expectedHead: oid,
    baseHead: oid.optional(),
    name: z.string().trim().min(1).max(120),
    assignment: z.string().max(200).default(''),
    target: z.string().max(200).default(''),
  }),
  z.object({
    action: z.literal('checkpoint'),
    laneId: id,
    expectedHead: oid,
    expectedTree: oid,
    message: z.string().trim().min(1).max(500),
  }),
  z.object({ action: z.literal('undo'), laneId: id, expectedHead: oid }),
  z.object({ action: z.literal('resume'), laneId: id }),
  z.object({
    action: z.literal('lane-status'),
    laneId: id,
    expectedHead: oid.optional(),
    state: z.enum(['active', 'paused', 'ready', 'completed']),
  }),
  intentStatusSchema,
  intentNoteSchema,
  z.object({
    action: z.literal('compose'),
    operationId: id.optional(),
    intentId: id,
    inputs: z.array(z.object({ laneId: id, head: oid })).max(8),
    dependencies: z.array(dependencySchema).optional(),
  }),
  z.object({
    action: z.literal('define-automation'),
    automationId: id,
    expectedDefinition: oid.optional(),
    intentId: id,
    name: z.string().trim().min(1),
    event: automationEventSchema.default('clean-view'),
    playbookId: id,
    expectedPlaybook: oid,
    expectedChecks: z.array(z.object({ id, definition: oid })).min(1),
    expectedEnvironment: oid,
    onFailure: z.enum(['stop', 'continue']),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal('automation-enabled'),
    automationId: id,
    expectedDefinition: oid,
    enabled: z.boolean(),
  }),
  defineCheckCommandSchema,
  z.object({
    action: z.literal('review-view'),
    viewId: id,
    expectedHead: oid,
    reviewer: z.string().trim().min(1),
    decision: z.enum(['approve', 'request-changes', 'comment']),
    text: z.string().default(''),
    invariant: invariantPinSchema.optional(),
  }),
]);
export const contributionCommandSchema = z.object({
  action: z.literal('import-bundle'),
  operationId: id,
  intentId: id,
  expectedBase: oid,
  expectedHead: oid,
  path: z.string().min(1),
  ref: z.string().default('refs/heads/contribution'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().trim().min(1).max(120),
});
export type ContributionCommand = z.infer<typeof contributionCommandSchema>;
export type LocalWorkCommand = z.infer<typeof commandSchema>;
export const exportWorkCommandSchema = z.object({
  action: z.literal('export-work'),
  archive: z.boolean().optional(),
  deduplicateArtifacts: z.boolean().optional(),
});
export const detailCommandSchema = z.discriminatedUnion('kind', [
  z.object({ action: z.literal('read-work-detail'), kind: z.literal('run'), id, expectedHead: oid }),
  z.object({ action: z.literal('read-work-detail'), kind: z.literal('automatic-action'), id }),
  z.object({
    action: z.literal('read-work-detail'),
    kind: z.literal('lane'),
    id,
    expectedHead: oid.nullable(),
  }),
  z.object({
    action: z.literal('read-work-detail'),
    kind: z.literal('view'),
    id,
    expectedHead: oid.optional(),
    expectedBase: oid,
    expectedStatus: z.enum(['clean', 'conflict']),
  }),
  z.object({
    action: z.literal('read-work-detail'),
    kind: z.literal('external'),
    id,
    observation: z.number().int().nonnegative(),
    expectedHead: oid,
    expectedBase: oid,
  }),
]);
export type WorkCommand =
  | InputAssessmentCommand
  | NativeGitContributionCommand
  | NativeContributionCommand
  | NativeObjectCommand
  | CompanionCommand
  | HistoricalCommand
  | z.infer<typeof detailCommandSchema>
  | z.infer<typeof exportWorkCommandSchema>
  | MirrorCommand
  | EnvironmentCommand
  | DeploymentCommand
  | ContributionCommand
  | LocalWorkCommand
  | PublishCommand
  | z.infer<typeof githubWorkSchema>
  | EvidenceCommand
  | PlaybookCommand
  | HistoryCommand
  | InteractionCommand
  | DiscussionCommand
  | ChannelCommand
  | InvariantCommand
  | PlanningCommand
  | ReleaseCommand;
