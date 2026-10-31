import { finishRetryReasonSchema } from './hosted-landing.js';
import { effectiveAgentDefaultsSchema } from './agent-parallel-defaults.js';
import { hostedRecordCommands } from './hosted-record-input.js';
import { hostedMirrorStatusSchema } from './hosted-github-mirror-status.js';
import { contractTestsInput } from './intent-test-contract.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { githubActionsRunsOnSchema } from './github-actions-runner-label.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { revertTargetSchema } from './hosted-sync.js';
import { saveExpectedSchema } from './hosted-save.js';
import { safeRelative } from './safe-relative.js';
import { planningCommentCommandSchema, planningPutSchema } from './work-planning-types.js';
import { invariant } from './errors.js';
import { hostedCheckCommandSchema, hostedCheckRunnerSchema } from './hosted-check.js';
export const hostedAgentActions = [
  'tests',
  'confirm-tests',
  'start',
  'open',
  'save',
  'compose',
  'sync',
  'resolve',
  'check',
  'finish',
  'cancel',
  'revert',
  'abandon',
  'reopen',
  'complete',
  'complete-merged',
  'status',
  'observe',
  'capabilities',
  'planning',
  'put-planning-item',
  'comment-planning-item',
] as const;
/** Backlog actions are advertised only to clients that ask (planningVersion), so released clients
 * that parse the capability list strictly keep working. */
export const hostedAgentPlanningActions = ['planning', 'put-planning-item', 'comment-planning-item'] as const;
/** Owner settings commands. Not advertised in capabilities: released clients parse
 * that list strictly, and the server enforces owner authority on each call. */
export const hostedAgentOwnerActions = [
  'prioritize',
  'configure-check',
  'configure-runner',
  'check-settings',
  'metrics',
] as const;
// Kept outside the strictly parsed advertised capability list.
export const hostedAgentRecordActions = [
  'friction',
  'decide',
  'decisions',
  'peer-ack',
  'overlap-acks',
] as const;
/** Composed by the client from existing reads and mutations; never advertised in capabilities. */
export const hostedAgentClientActions = ['ack', 'preflight', 'source-pack'] as const;
export const hostedAgentAddressSchema = z.object({ url: z.url(), projectId: z.string().min(1) }).strict();
export type HostedAgentAddress = z.infer<typeof hostedAgentAddressSchema>;
export const hostedAgentCapabilitiesSchema = z
  .object({
    overlapVersion: z.literal(1).optional(),
    /** Deferred caller outcome/delivery receipts may ride on CLI mutations. */
    metricReceiptVersion: z.literal(1).optional(),
    /** Effective parallel-work defaults (project policy), when the client asks with defaultsVersion:1. */
    agentDefaults: effectiveAgentDefaultsSchema.optional(),
    needsFix: z.array(z.record(z.string(), z.json())).optional(),
    githubMirror: hostedMirrorStatusSchema.nullable().optional(),
    schema: z.literal(1),
    projectId: z.string(),
    actor: z.string(),
    authority: sourceAuthoritySchema,
    actions: z.array(z.enum(hostedAgentActions)),
    mainReady: z.boolean(),
    sourceWorkerConfigured: z.boolean(),
    checkCallbackConfigured: z.boolean(),
    nativeOwnerRequired: z.literal(false),
    observation: z.literal('finite'),
  })
  .strict();
export type HostedAgentCapabilities = z.infer<typeof hostedAgentCapabilitiesSchema>;
const planningStatuses = ['proposed', 'open', 'in-progress', 'closed', 'abandoned'] as const;
const uuid = z.uuid(),
  hash = z.string().regex(/^[0-9a-f]{64}$/);
const lane = { laneId: uuid.optional() };
const message = { message: z.string().default('Agent change') };
const selection = {
  ...lane,
  ...message,
  intentId: uuid.optional(),
  inputs: z.array(z.object({ laneId: uuid, expected: saveExpectedSchema.optional() }).strict()).optional(),
  dependencies: z.array(z.object({ candidateId: uuid, head: hash.optional() }).strict()).default([]),
};
const check = z
  .object({
    checkId: uuid,
    expectedDefinition: hash.optional(),
    expectedConfiguration: hash.optional(),
    expectedEnvironment: hash.optional(),
  })
  .strict();
export const hostedAgentCommandSchemas = {
  ...hostedRecordCommands,
  tests: contractTestsInput.omit({ operationId: true, laneId: true }).extend({ candidateId: uuid }).strict(),
  'confirm-tests': contractTestsInput
    .omit({ operationId: true, laneId: true })
    .extend({ candidateId: uuid })
    .strict(),
  start: z
    .object({
      outcome: z.string().min(1).optional(),
      constraints: z.string().optional(),
      intentId: uuid.optional(),
      initialHead: hash.optional(),
      stackOn: uuid.optional(),
      stackEntry: uuid.optional(),
      /** Start from a planned Issue: its title and body become the Intent, and it moves to in-progress. */
      planningItemId: uuid.optional(),
    })
    .strict(),
  open: z
    .object({
      laneId: uuid,
      expected: saveExpectedSchema.omit({ lifecycleVersion: true }).optional(),
      paths: z.array(z.string().refine(safeRelative)).optional(),
    })
    .strict(),
  save: z.object({ ...lane, ...message, supersedeFinish: z.boolean().optional() }).strict(),
  compose: z.object(selection).strict(),
  sync: z
    .object({
      ...lane,
      ...message,
      candidateId: uuid.optional(),
      target: z
        .union([
          z.object({ kind: z.literal('main'), head: hash, receiptId: z.string() }).strict(),
          z.object({ kind: z.literal('candidate'), candidateId: uuid, head: hash }).strict(),
        ])
        .optional(),
      ontoMain: z.boolean().optional(),
      apply: z.boolean().default(true),
    })
    .strict(),
  resolve: z.object({ ...lane, ...message }).strict(),
  check: check.extend({ candidateId: uuid, expectedHead: hash.optional() }).strict(),
  finish: z
    .object({
      ...selection,
      check: check.optional(),
      candidateId: uuid.optional(),
      composeOperationId: uuid.optional(),
      after: uuid.nullable().default(null),
      accept: z.boolean().optional(),
      keepOpen: z.boolean().optional(),
      priority: z.enum(['urgent', 'normal']).optional(),
      retry: z.boolean().optional(),
      reason: finishRetryReasonSchema.optional(),
    })
    .strict()
    .refine(command => !command.retry || Boolean(command.reason), 'A retry records its reason.'),
  /** asOwner: the project owner is issuing this, not an agent acting alone (urgentRoles). */
  prioritize: z
    .object({
      submissionId: uuid,
      priority: z.enum(['urgent', 'normal']),
      asOwner: z.literal(true).optional(),
    })
    .strict(),
  /** Client-composed: answer every pending overlap notice on the Lane in one batch. */
  ack: z
    .object({
      ...lane,
      choice: z.enum(['accept-order', 'swap', 'split']).default('accept-order'),
      text: z.string().min(1).max(2000).optional(),
    })
    .strict(),
  /** Client-composed: select the saved head's affected tests, run them here and record the result. */
  preflight: z.object({ ...lane, run: z.boolean().default(true) }).strict(),
  /** Client-composed operator repair: pack the current hosted main and publish it to R2. */
  'source-pack': z.object({}).strict(),
  cancel: z.object({ submissionId: uuid }).strict(),
  revert: z.object({ ...message, target: revertTargetSchema }).strict(),
  abandon: z
    .object({
      ...lane,
      reason: z.string().min(1),
      saveFirst: z.boolean().default(false),
      /** Keep unsaved edits in a local patch next to the checkout, then abandon. */
      keepPatch: z.boolean().default(false),
      target: z
        .object({
          kind: z.literal('intent'),
          intentId: uuid,
          version: z.number().int().nonnegative(),
          cascade: z.boolean().default(false),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /** Close one Lane whose work landed; a repeat is a no-op. */
  complete: z.object({ ...lane }).strict(),
  /** Close every active Lane whose exact saved head an accepted receipt landed. */
  'complete-merged': z.object({}).strict(),
  reopen: z
    .object({
      ...lane,
      target: z
        .object({
          kind: z.literal('intent'),
          intentId: uuid,
          version: z.number().int().nonnegative(),
          cascade: z.literal(false).default(false),
        })
        .strict()
        .optional(),
    })
    .strict(),
  status: z
    .object({
      ...lane,
      kind: z.enum(['save', 'compose', 'sync', 'revert', 'lifecycle']).optional(),
      operationId: uuid.optional(),
      submissionId: uuid.optional(),
      runId: uuid.optional(),
      version: z.number().int().nonnegative().optional(),
    })
    .strict(),
  observe: z
    .object({
      kind: z.enum(['save', 'compose', 'sync', 'revert', 'lifecycle']).optional(),
      operationId: uuid.optional(),
      submissionId: uuid.optional(),
      runId: uuid.optional(),
      version: z.number().int().nonnegative().optional(),
    })
    .strict(),
  metrics: z.object({ from: z.string().optional(), to: z.string().optional() }).strict(),
  capabilities: z.object({}).strict(),
  /** Owner-only. Default imports the hosted Work check named verify; command defines one. */
  'configure-check': z
    .object({
      name: z.string().min(1).max(200).optional(),
      checkId: uuid.optional(),
      command: hostedCheckCommandSchema.optional(),
      expected: hash.nullable().optional(),
    })
    .strict(),
  /** Owner-only. provider self-hosted (legacy mac alias) fills runtime and environment from this installed package and process;
   * provider github-actions selects the Convex-dispatched App runner (installation derived via the App). */
  'configure-runner': z
    .object({
      provider: z.enum(['mac', 'self-hosted', 'github-actions']).optional(),
      runsOn: githubActionsRunsOnSchema.optional(),
      concurrencyBudget: z.number().safe().int().min(2).optional(),
      machineId: uuid.optional(),
      labels: z.array(z.string().min(1)).optional(),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .optional(),
      configuration: hostedCheckRunnerSchema.optional(),
      expected: hash.nullable().optional(),
    })
    .strict(),
  'check-settings': z.object({}).strict(),
  /** Finite page of the backlog (Initiatives and Issues). id reads one item with its comments. */
  planning: z
    .object({
      id: uuid.optional(),
      kind: z.enum(['issue', 'initiative']).optional(),
      status: z.enum(planningStatuses).optional(),
      initiativeId: uuid.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().nullable().default(null),
      /** Close or abandon Issues whose Intent finished; reports what it changed. */
      reconcile: z.boolean().default(true),
    })
    .strict(),
  'put-planning-item': planningPutSchema
    .omit({ action: true, operationId: true, itemId: true })
    .extend({ itemId: uuid.optional() })
    .strict(),
  'comment-planning-item': planningCommentCommandSchema.omit({ action: true, operationId: true }).strict(),
};
export type HostedAgentAction = keyof typeof hostedAgentCommandSchemas;
export function hostedAgentAction(action: string): HostedAgentAction {
  const value =
    action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action === 'landing' ? 'observe' : action;
  invariant(
    Object.hasOwn(hostedAgentCommandSchemas, value),
    'HOSTED_ACTION_UNSUPPORTED',
    'This action is not supported by the hosted agent transport. Read capabilities for supported actions.',
  );
  return value as HostedAgentAction;
}
