// SPDX-License-Identifier: Apache-2.0
import { finishRetryReasonSchema } from './hosted-landing.js';
import { effectiveAgentDefaultsWireSchema } from './agent-parallel-defaults.js';
import { hostedRecordCommands } from './hosted-record-input.js';
import { hostedMirrorStatusSchema } from './hosted-github-mirror-status.js';
import { contractTestsInput } from './intent-test-contract.js';
import { z } from 'zod';
import { landingMessageSchema } from './landing-message.js';
import { githubActionsRunsOnSchema } from './github-actions-runner-label.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { revertTargetSchema } from './hosted-sync.js';
import { saveExpectedSchema } from './hosted-save.js';
import { snapshotsCommandSchema } from './lane-snapshot-contract.js';
import { safeRelative } from './safe-relative.js';
import { planningCommentCommandSchema, planningPutSchema } from './work-planning-types.js';
import { invariant } from './errors.js';
import { isPlanningRef, planningIdHelp } from './planning-id.js';
import { policyWriteObject } from './autonomy-policy.js';
import { hostedCheckCommandSchema, hostedCheckRunnerSchema } from './hosted-check.js';
import { submoduleAllowChangesSchema } from './submodule-allowlist.js';
import { metricContextField, metricPagingFields } from './self-metrics-page.js';
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
  'pin',
  'configure-check',
  'configure-runner',
  'check-settings',
  'metrics',
  'abandon-dormant',
] as const;
// Kept outside the strictly parsed advertised capability list.
export const hostedAgentRecordActions = [
  'friction',
  'friction-list',
  'friction-triage',
  'decide',
  'decisions',
] as const;
/** Project policy: one Convex call each, served before capability discovery. Not advertised;
 * the server enforces owner authority on set-policy. */
export const hostedAgentPolicyActions = ['policy', 'set-policy'] as const;
/** Owner review (fe5bea80): one query for the approve link of a held landing, and one mutation to
 * request the owner's approval on a Lane. Not advertised. */
export const hostedAgentReviewActions = ['approve-link', 'request-approval'] as const;
/** Landing recovery (78a97771): `land --withdraw` ends the Lane's live landing. Not advertised (released
 * clients parse the capability list strictly); the server feature `landing-withdraw` gates it. */
export const hostedAgentLandingActions = ['withdraw'] as const;
/** Composed by the client from existing reads and mutations; never advertised in capabilities. */
export const hostedAgentClientActions = [
  'preflight',
  'source-pack',
  'recover-apply',
  'pull',
  'snapshots',
] as const;
export { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-address.js';
export const hostedAgentCapabilitiesSchema = z
  .object({
    landingMessageVersion: z.literal(1).optional(),
    /** Contract features the server implements, from the ones the client named (a83b6fd5). */
    features: z.array(z.string()).optional(),
    /** start replies list the other open Lanes on the same Intent (openLanes). */
    openLanesVersion: z.literal(1).optional(),
    /** Overlap reads accept `presence` and return related open Lanes (Issue 9c8490a4). */
    presenceVersion: z.literal(1).optional(),
    /** Agent board (Issue 9c8490a4): board verbs and board notes on Lane actions. */
    boardVersion: z.literal(1).optional(),
    overlapVersion: z.literal(1).optional(),
    overlapEvidenceVersion: z.literal(1).optional(),
    /** Deferred caller outcome/delivery receipts may ride on CLI mutations. */
    metricReceiptVersion: z.literal(1).optional(),
    /** Effective parallel-work defaults (project policy), when the client asks with defaultsVersion:1. */
    agentDefaults: effectiveAgentDefaultsWireSchema.optional(),
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
    /** Feature lane-snapshots: true while project policy autoSnapshot is on (Issue 7ac4e32f). */
    laneSnapshots: z.boolean().optional(),
    /** Feature lane-snapshot-packs: minutes between timed snapshots of one Lane (policy
     * autoSnapshotIntervalMinutes, default 10, at least 5), sent while snapshots are on. */
    snapshotIntervalMinutes: z.number().int().min(1).optional(),
    /** Split save (save-settle-background, fea47345 C): the outcome of the save the client named in
     * `settling`, read in this same call (`terminal` null while it is still settling). */
    settledSave: z.object({ operationId: z.string(), terminal: z.unknown().nullable() }).strict().optional(),
  })
  .strict();
export type HostedAgentCapabilities = z.infer<typeof hostedAgentCapabilitiesSchema>;
const planningStatuses = ['proposed', 'open', 'in-progress', 'closed', 'abandoned'] as const;
const uuid = z.uuid(),
  hash = z.string().regex(/^[0-9a-f]{64}$/);
/** A planning id: a complete UUID (used as given) or a unique hex prefix of 8+ characters, which the
 * transport resolves to the full id in the same call (ce863deb). */
const planningRef = z.string().refine(isPlanningRef, `must be ${planningIdHelp}`);
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
  pull: z.object({}).strict(),
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
      planningItemId: planningRef.optional(),
      /** Declared paths (a trailing / selects a directory): the start receipt names open Lanes that
       * already saved files there (D2). Client-side only; never part of the start request. */
      scope: z
        .object({ paths: z.array(z.string().refine(path => safeRelative(path.replace(/\/$/, '')))).max(50) })
        .strict()
        .optional(),
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
          z
            .object({
              kind: z.literal('main'),
              head: hash,
              receiptId: z.string(),
            })
            .strict(),
          z
            .object({
              kind: z.literal('candidate'),
              candidateId: uuid,
              head: hash,
            })
            .strict(),
        ])
        .optional(),
      ontoMain: z.boolean().optional(),
      /** Stack this Lane on an open peer Lane's pending head (its live landing); see stackOffer. */
      stackOn: uuid.optional(),
      apply: z.boolean().default(true),
      /** Restack onto the stack parent only if it applies cleanly; a conflict changes nothing (save runs it). */
      cleanOnly: z.literal(true).optional(),
    })
    .strict(),
  'recover-apply': z.object({ applyOperationId: uuid }).strict(),
  resolve: z
    .object({
      ...lane,
      ...message,
      /** Conflict paths kept as they are although they still hold one side unchanged. */
      keep: z.array(z.string().refine(safeRelative)).min(1).max(1000).optional(),
    })
    .strict(),
  check: check.extend({ candidateId: uuid, expectedHead: hash.optional() }).strict(),
  finish: z
    .object({
      ...selection,
      message: landingMessageSchema.optional(),
      check: check.optional(),
      candidateId: uuid.optional(),
      composeOperationId: uuid.optional(),
      after: uuid.nullable().default(null),
      accept: z.boolean().optional(),
      keepOpen: z.boolean().optional(),
      closes: z.boolean().optional(),
      priority: z.enum(['urgent', 'normal']).optional(),
      /** Land a Lane whose saved head changes nothing against its base (otherwise refused). */
      allowEmpty: z.boolean().optional(),
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
  /** Client-composed: select the saved head's affected tests, run them here and record the result. */
  preflight: z
    .object({
      ...lane,
      run: z.boolean().default(true),
      budgetSeconds: z.number().int().min(1).max(3600).optional(),
      /** false: run every ranked local tier without the time budget (the receipt's rerun command). */
      trim: z.boolean().optional(),
      /** true: run exactly the files the last run stopped for time (receipt `stopped`, its
       * stoppedRerun). Named like finish's retry so the compact tool list stays in budget. */
      retry: z.literal(true).optional(),
    })
    .strict(),
  /** Client-composed operator repair: pack the current hosted main and publish it to R2. */
  'source-pack': z.object({}).strict(),
  /** Unsaved-work snapshots (7ac4e32f): the Lane's operation log, undo/redo/restore, owner purge. */
  snapshots: snapshotsCommandSchema,
  cancel: z.object({ submissionId: uuid }).strict(),
  /** land --withdraw: cancel this Lane's live landing; the Lane, saves and check evidence stay. */
  withdraw: z
    .object({
      ...lane,
      /** The submission from `queue` or a land receipt: reaches a landing that moved to a resolution Lane. */
      submissionId: uuid.optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict()
    .refine(command => !(command.submissionId && command.laneId), 'Select laneId or submissionId, not both.')
    .refine(
      command => !(command.submissionId && command.reason),
      'reason is recorded only for a withdraw by Lane; omit it with submissionId.',
    ),
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
  /** Owner pin: cleanup (complete-merged, completeOnAccept, Intent cascade, prune, cache GC) skips the Lane. */
  pin: z.object({ ...lane, pinned: z.boolean().default(true) }).strict(),
  /** Close every active Lane whose exact saved head an accepted receipt landed. */
  'complete-merged': z.object({}).strict(),
  /** Dormant open Lanes with nothing unlanded: dry run lists them; apply abandons up to `limit` per call. */
  'abandon-dormant': z
    .object({ apply: z.boolean().default(false), limit: z.number().int().min(1).max(25).default(25) })
    .strict(),
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
      /** With runId: counts, failed/flaky file names, timings and selection scope, under 8 KB, not the 80 KB run. */
      summary: z.boolean().optional(),
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
  metrics: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      ...metricPagingFields,
      ...metricContextField,
    })
    .strict(),
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
      publicLogs: z.boolean().optional(),
      submodules: submoduleAllowChangesSchema.optional(),
      /** github-actions: "shared" lets project code run as the runner user where no Candidate user
       * can be set up (macOS/Windows self-hosted); "user" withdraws that. */
      isolation: z.enum(['user', 'shared']).optional(),
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
  /** Effective project policy, one read. */
  policy: z.object({}).strict(),
  /** The approve link of a landing (operationId = its original landing UUID) for a signed-in owner. */
  'approve-link': z.object({}).strict(),
  /** Ask the project owner to approve a saved Lane (default: this checkout's Lane) with a reason;
   * landing it holds until they grant it. withdraw:true drops your request. */
  'request-approval': z
    .object({
      laneId: uuid.optional(),
      reason: z.string().trim().min(1).max(500).optional(),
      withdraw: z.literal(true).optional(),
    })
    .strict()
    .refine(value => Boolean(value.reason) !== Boolean(value.withdraw), 'Give a reason, or withdraw:true.'),
  /** Owner-only merge of policy fields; operationId (a UUID, generated if omitted) makes a replay a no-op. */
  'set-policy': policyWriteObject
    .omit({ action: true, operationId: true })
    .strict()
    .refine(
      value => value.acceptance?.ownerApprovalPaths === undefined || value.governanceVersion === 1,
      'Editing owner approval paths requires governanceVersion:1.',
    ),
  /** Finite page of the backlog (Initiatives and Issues). id reads one item with its comments. */
  planning: z
    .object({
      id: planningRef.optional(),
      search: z.string().trim().min(1).optional(),
      kind: z.enum(['issue', 'initiative']).optional(),
      status: z.enum([...planningStatuses, 'all']).optional(),
      initiativeId: uuid.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().nullable().default(null),
      /** Close or abandon Issues whose Intent finished; reports what it changed. */
      reconcile: z.boolean().default(true),
      /** Also suggest which open Issues can run in parallel and which should stack, from the files
       * each names (src/work-schedule.ts). Advice only; reads up to 5 pages to cover the backlog. */
      schedule: z.boolean().optional(),
    })
    .strict()
    .refine(input => !(input.id && input.search), 'Use id or search, not both.')
    .refine(input => !(input.schedule && (input.id || input.search)), 'Use schedule with a list read.'),
  'put-planning-item': planningPutSchema
    .omit({ action: true, operationId: true, itemId: true })
    .extend({ itemId: planningRef.optional() })
    .strict(),
  'comment-planning-item': planningCommentCommandSchema
    .omit({ action: true, operationId: true })
    .extend({ itemId: planningRef })
    .strict(),
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
