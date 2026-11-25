// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { initiativeProgressRequested } from './hosted-contract-features.js';
import { looseEndIntentBatchSchema } from './hosted-lifecycle.js';
import { finishRetryReasonSchema, landingTokensSchema } from './hosted-landing.js';
import { notVerifiedInput } from './agent-handoff-types.js';
import { effectiveAgentDefaultsWireSchema } from './agent-parallel-defaults.js';
import { hostedRecordCommands } from './hosted-record-input.js';
import { hostedMirrorStatusSchema } from './hosted-github-mirror-status.js';
import { contractTestsInput } from './intent-test-contract.js';
import { z } from 'zod';
import { predecessorPinSchema } from './early-resolution.js';
import { landingMessageSchema, noteSchema } from './landing-message.js';
import { githubActionsRunsOnSchema } from './github-actions-runner-label.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedMainV2Schema, mainDaySchema } from './hosted-main.js';
import { revertTargetSchema } from './hosted-sync.js';
import { saveExpectedSchema } from './hosted-save.js';
import { snapshotsCommandSchema } from './lane-snapshot-contract.js';
import { safeRelative } from './safe-relative.js';
import { guardCandidatesSchema } from './hosted-lane.js';
import { parkInputSchema } from './hosted-records.js';
import {
  planningCommentCommandSchema,
  planningModelPutKeys,
  planningWaitingKinds,
  planningPutAgentFields,
  planningPutSchema,
  relationKinds,
} from './work-planning-types.js';
const omitKeys = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map(key => [key, true])) as Record<K, true>;
import { invariant } from './errors.js';
import { planningIssueFields, planningRef } from './planning-issue-arguments.js';
import { autonomyPolicySchema, policyWriteObject } from './autonomy-policy.js';
import { hostedCheckCommandSchema, hostedCheckRunnerSchema } from './hosted-check.js';
import { submoduleAllowChangesSchema } from './submodule-allowlist.js';
import { metricContextField, metricPagingFields } from './self-metrics-page.js';
import { HOLDER_REASON_MAX } from './hosted-lane.js';
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
export const hostedAgentPlanningActions = [
  'planning',
  'put-planning-item',
  'comment-planning-item',
  'tick-planning-item',
] as const;
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
  'report-abuse',
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
  'undo',
  'tick-planning-item',
] as const;
export { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-address.js';
export const hostedAgentCapabilitiesSchema = z
  .object({
    device: z
      .object({
        id: z.string(),
        code: z.string().nullable(),
        name: z.string().optional(),
        approvedAt: z.number().nullable(),
        expiresAt: z.number(),
        source: z.enum(['write', 'read', 'coordination']),
        projects: z
          .union([
            z.object({ kind: z.literal('all') }).strict(),
            z.object({ kind: z.literal('project'), projectId: z.string() }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    protectedPathPolicy: z
      .object({ acceptance: autonomyPolicySchema.shape.acceptance, checkEntries: z.array(z.string()) })
      .strict()
      .optional(),
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
    /** The rolling day behind the top bar's main figure (Item 32e8de50), on a bare status only. */
    mainDay: mainDaySchema.optional(),
    schema: z.literal(1),
    projectId: z.string(),
    actor: z.string(),
    authority: sourceAuthoritySchema,
    actions: z.array(z.enum(hostedAgentActions)),
    mainReady: z.boolean(),
    /** Opt-in snapshot of the deployment's live queue switches, by documented name. */
    queueSwitches: z.record(z.string(), z.boolean()).optional(),
    /** Feature capabilities-main: hosted main as projectHostedChannels:current returns it, read with
     * this reply; absent when main is unseeded or its authority differs from the project's. */
    main: hostedMainV2Schema.optional(),
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
    /** The learned preflight guard-set candidates (13ea93bf), when the caller sent another
     * `guardRevision`. A hint: an unreadable one is dropped, never a failed command. */
    guardSet: guardCandidatesSchema.optional().catch(undefined),
  })
  .strict();
export type HostedAgentCapabilities = z.infer<typeof hostedAgentCapabilitiesSchema>;
const planningStatuses = [
  'proposed',
  'open',
  'in-progress',
  'closed',
  'abandoned',
  'archived',
  'deleted',
] as const;
const uuid = z.uuid(),
  hash = z.string().regex(/^[0-9a-f]{64}$/);
const lane = { laneId: uuid.optional() };
const message = { message: noteSchema.default('Agent change') };
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
      model: z
        .string()
        .optional()
        .describe(
          'Your model ID, or set FORGE_AGENT_MODEL. Missing: the start records "unknown" and tips once.',
        ),
      outcome: z.string().min(1).optional(),
      constraints: z.string().optional(),
      intentId: uuid.optional(),
      initialHead: hash.optional(),
      stackOn: uuid.optional(),
      stackEntry: uuid.optional(),
      /** Start from a planned Issue: its title and body become the Intent, and it moves to in-progress. */
      ...planningIssueFields,
      /** Declared paths (a trailing / selects a directory): the start receipt names open Lanes that
       * already saved files there (D2). Client-side only; never part of the start request. */
      scope: z
        .object({ paths: z.array(z.string().refine(path => safeRelative(path.replace(/\/$/, '')))).max(50) })
        .strict()
        .optional(),
    })
    .strict()
    // Each refusal names the field to drop (593fc2d7): the Issue's title and body are the outcome.
    .refine(command => !command.planningItemId || !command.outcome, {
      path: ['outcome'],
      message:
        'drop it: planningItemId starts from its Issue, whose title and body are the outcome (outcome alone starts unplanned work)',
    })
    .refine(command => !command.planningItemId || !command.intentId, {
      path: ['intentId'],
      message: 'drop it: planningItemId starts from its Issue (intentId alone joins an Intent)',
    }),
  open: z
    .object({
      laneId: uuid,
      takeover: z.literal(true).optional(),
      acceptHandoff: z.uuid().optional(),
      reason: z.string().trim().min(1).max(HOLDER_REASON_MAX).optional(),
      handoff: z
        .object({
          sessionId: z.string().regex(/^[0-9a-f]{64}$/),
          agent: z.string().optional(),
          person: z.string().optional(),
        })
        .strict()
        .optional(),
      expected: saveExpectedSchema.omit({ lifecycleVersion: true }).optional(),
      paths: z.array(z.string().refine(safeRelative)).optional(),
    })
    .strict(),
  /** `park` (Item e1633718): after the save, park the Lane on a holder (`@handle` or `handle/word-word`) with a
   * reason, or with a reason only (no one named); `park: null` clears it. */
  save: z
    .object({
      ...lane,
      ...message,
      model: z.string().optional(),
      supersedeFinish: z.boolean().optional(),
      park: parkInputSchema.optional(),
      notVerified: notVerifiedInput,
    })
    .strict(),
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
      predecessor: predecessorPinSchema.optional(),
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
      model: z.string().optional(),
      ...selection,
      message: landingMessageSchema.optional(),
      check: check.optional(),
      candidateId: uuid.optional(),
      composeOperationId: uuid.optional(),
      after: uuid.nullable().default(null),
      accept: z.boolean().optional(),
      notVerified: notVerifiedInput,
      keepOpen: z.boolean().optional(),
      closes: z
        .boolean()
        .optional()
        .describe(
          'Boolean: true closes this Lane’s Intent under project policy; false keeps it open. It is not a list of Issue ids.',
        ),
      priority: z.enum(['urgent', 'normal']).optional(),
      tokens: landingTokensSchema
        .optional()
        .describe(
          'Optional: tokens your own work on this landing used, as your harness counts them (whole number, at most 1e9). Stats shows the measured total; never billed.',
        ),
      /** Land a Lane whose saved head changes nothing against its base (otherwise refused). */
      allowEmpty: z.boolean().optional(),
      /** Submit only while the queue holds fewer than N checks; judged by the server with the submit,
       * and a land without room waits for it on a live query, never polling (ad80e037). */
      maxChecks: z
        .number()
        .int()
        .min(1)
        .max(64)
        .optional()
        .describe(
          'Submit only while fewer than N checks run or wait, so at most N with this one (held entries out, preparing landings in); a land without room waits for one.',
        ),
      retry: z.boolean().optional(),
      reason: finishRetryReasonSchema.optional(),
    })
    .strict()
    .refine(
      command => !command.retry || Boolean(command.reason),
      'A retry records its reason: add "reason" (flake, main-moved, infra or other; a failed check names it next.retryReason).',
    )
    .refine(
      command => command.maxChecks === undefined || command.accept !== false,
      'maxChecks limits a land that queues; a check-only run (accept:false) never queues, so drop maxChecks.',
    )
    .refine(command => command.notVerified === undefined || command.accept !== false, {
      path: ['notVerified'],
      message: 'Use save to report notVerified on source that will only be checked.',
    }),
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
      /** The landing message this Lane will land with: checked against the landing limit before any
       * test runs (ad80e037); preflight never lands or stores it. */
      message: z.string().optional(),
    })
    .strict(),
  /** Client-composed operator repair: pack the current hosted main and publish it to R2. */
  'source-pack': z.object({}).strict(),
  /** Unsaved-work snapshots (7ac4e32f): the Lane's operation log, undo/redo/restore, owner purge. */
  snapshots: snapshotsCommandSchema,
  undo: z
    .object({
      ...lane,
      saveId: uuid.optional().describe('Restore the head of this Lane save (from records saves).'),
      version: saveExpectedSchema.shape.version
        .optional()
        .describe('Restore an exact retained Lane version from a receipt.'),
      apply: z.boolean().default(true).describe('Also restore the checkout here, if open.'),
    })
    .strict()
    .refine(
      command => command.saveId === undefined || command.version === undefined,
      'Select saveId or version, or omit both to undo the last save.',
    ),
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
    .refine(command => !(command.submissionId && command.laneId), 'Select laneId or submissionId, not both.'),
  revert: z.object({ ...message, target: revertTargetSchema }).strict(),
  abandon: z
    .object({
      ...lane,
      reason: z.string().min(1),
      authorityEpoch: looseEndIntentBatchSchema.shape.authorityEpoch.optional(),
      intents: looseEndIntentBatchSchema.shape.intents.optional(),
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
    .strict()
    .refine(
      command =>
        command.intents
          ? command.authorityEpoch !== undefined &&
            !command.laneId &&
            !command.target &&
            !command.saveFirst &&
            !command.keepPatch &&
            looseEndIntentBatchSchema.shape.reason.safeParse(command.reason).success
          : command.authorityEpoch === undefined,
      'Batch abandonment takes only the Intent selections, authorityEpoch and reason.',
    ),
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
      whoami: z.literal(true).optional(),
      kind: z.enum(['save', 'compose', 'sync', 'revert', 'lifecycle']).optional(),
      operationId: uuid.optional(),
      submissionId: uuid.optional(),
      runId: uuid.optional(),
      version: z.number().int().nonnegative().optional(),
      /** With runId: counts, failed/flaky file names, timings and selection scope, under 8 KB, not the 80 KB run. */
      summary: z
        .boolean()
        .optional()
        .describe(
          'Requires runId; returns the selected check run summary. For a Lane summary pass laneId without summary.',
        ),
      reports: z
        .union([
          z.literal('failed'),
          z.object({ files: z.array(z.string()).max(256) }).strict(),
          z.literal(true),
        ])
        .optional(),
      selection: z
        .union([z.literal(true), z.literal('timing-history')])
        .optional()
        .describe('With runId, reads the retained check selection or its exact timing snapshot.'),
      cursor: z.string().nullable().optional(),
      /** Why main failed (ae068e0c): the newest red (true) or the red at this audit event sequence, with its failed
       * run, the landings since the last pass, the culprit when proven and how it ended. */
      main: z.union([z.literal(true), z.number().int().nonnegative()]).optional(),
      /** From a Lane folder: the files that differ from its saved head (git status), answered
       * locally with no server call (ad80e037). */
      files: z.literal(true).optional(),
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
      /** Owner-only, alone: start an optional red-audit drill. From an agent it opens an
       * approval request for the owner person. Legacy backfill is an inert compatibility reply. */
      mainAudit: z
        .union([
          z.object({ drill: z.literal('start') }).strict(),
          z.object({ backfill: z.object({ since: z.iso.datetime() }).strict() }).strict(),
        ])
        .optional(),
    })
    .strict(),
  'check-settings': z.object({}).strict(),
  /** Effective project policy, one read. */
  policy: z.object({}).strict(),
  /** The approve link of a landing (operationId = its original landing UUID) for a signed-in owner. */
  'approve-link': z.object({}).strict(),
  /** Ask the project owner to approve a saved Lane (default: this checkout's Lane) with a reason;
   * landing it holds until they approve it. withdraw:true drops your request. */
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
      ...planningIssueFields,
      transfer: z.unknown().optional(),
      search: z.string().trim().min(1).optional(),
      /** Prepare agent-side refinement of one Item, only if enabled in the project. No model is called. */
      refine: z.literal(true).optional(),
      kind: z.enum(['issue', 'initiative']).optional(),
      status: z
        .union([z.enum([...planningStatuses, 'active', 'all']), z.array(z.enum(planningStatuses)).nonempty()])
        .optional(),
      initiativeId: planningRef.optional(),
      waitingOn: z
        .string()
        .refine(
          value => value === 'none' || planningWaitingKinds.some(kind => kind === value),
          'waitingOn: owner, design, evidence, item or none.',
        )
        .optional(),
      /** Same filters as the web Plan views (src/planning-filter.ts); owner/relation "none" = without one. */
      type: z.string().trim().min(1).max(32).optional(),
      owner: z.string().trim().min(1).max(200).optional(),
      // A checked string, not an enum, so the per-session tool listing names the field without its values
      // (tests/mcp-tool-list.test.mjs budget); help and docs/planning.md list them.
      relation: z
        .string()
        .refine(value => ['depends-on', 'duplicate-of', 'related', 'none'].includes(value), {
          message: 'relation: depends-on, duplicate-of, related or none.',
        })
        .optional(),
      /** Group the returned page by an already-loaded field. A checked string keeps MCP tools/list compact. */
      groupBy: z
        .string()
        .refine(
          value => ['initiative', 'parent', 'type', 'owner', 'status', 'kind', 'none'].includes(value),
          'groupBy: initiative, parent, type, owner, status, kind or none.',
        )
        .optional(),
      /** Return stored state counts in one bounded read; continue with the returned cursor. */
      counts: z.boolean().optional(),
      /** true: 14 UTC days of Initiative closes (with counts:true), or one Item's paged audit timeline (with planningItemId). {from,to?,change?}: Items closed, reopened or changed in a UTC window. */
      history: z
        .union([
          z.literal(true),
          z
            .object({
              from: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
              to: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
              change: z.enum(['all', 'closed', 'reopened', 'changed']).optional(),
            })
            .strict(),
        ])
        .optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().nullable().default(null),
      /** An Item read lists this many newest comments (default 50); commentsCursor continues. Smaller pages keep
       * the reply short. */
      commentLimit: z.number().int().min(1).max(50).optional(),
      /** Close or abandon Issues whose Intent finished; reports what it changed. Default: list reads
       * reconcile; search and Item (id/planningItemId) reads do not. */
      reconcile: z.boolean().optional(),
      /** Also suggest which open Issues can run in parallel and which should stack, from the files
       * each names (src/work-schedule.ts). Advice only; reads up to 5 pages to cover the backlog. */
      schedule: z.boolean().optional(),
    })
    .strict()
    .refine(
      input =>
        !(
          input.counts &&
          (input.id ||
            input.search ||
            input.schedule ||
            input.type ||
            input.owner ||
            input.relation ||
            input.status === 'active' ||
            Array.isArray(input.status))
        ),
      'Use counts with a list read (kind, one stored status, initiativeId and waitingOn filters only).',
    )
    .refine(
      input =>
        input.history !== true ||
        Boolean(
          (input.id || input.planningItemId || input.itemId) &&
          !input.counts &&
          !input.search &&
          !input.schedule &&
          !input.waitingOn,
        ) ||
        initiativeProgressRequested(input),
      'Use history:true with planningItemId for an Item timeline, or with counts:true and an unfiltered Initiative.',
    )
    .refine(
      input =>
        typeof input.history !== 'object' ||
        (!input.id &&
          !input.planningItemId &&
          !input.itemId &&
          !input.counts &&
          !input.search &&
          !input.schedule &&
          !input.waitingOn &&
          !input.status &&
          !input.type &&
          !input.owner &&
          !input.relation &&
          !input.kind),
      'Use history:{from,to?,change?} with optional initiativeId, limit and cursor only.',
    )
    .refine(
      input =>
        !input.groupBy ||
        !(
          input.id ||
          input.itemId ||
          input.planningItemId ||
          input.counts ||
          input.history ||
          input.transfer
        ),
      'Use groupBy on an Item list or search page.',
    )
    .refine(
      input =>
        !input.refine ||
        (!!(input.id || input.itemId || input.planningItemId) &&
          !(
            input.search ||
            input.counts ||
            input.history ||
            input.transfer ||
            input.groupBy ||
            input.cursor ||
            input.reconcile
          )),
      'refine:true needs one Item id, with no search, paging or reconciliation.',
    )
    .refine(input => !(input.id && input.search), 'Use planningItemId or search, not both.')
    .refine(input => !(input.id && input.waitingOn), 'Use waitingOn with a list or search read.')
    .refine(input => !(input.schedule && (input.id || input.search)), 'Use schedule with a list read.'),
  'put-planning-item': planningPutSchema
    .omit({
      action: true,
      operationId: true,
      itemId: true,
      agent: true,
      agentClient: true,
      statusPinBy: true,
      statusPinUndo: true,
      statusPinRestore: true,
      ...omitKeys(planningModelPutKeys),
    })
    .extend({
      ...planningIssueFields,
      initiativeId: planningRef.nullable().optional(),
      fields: planningPutAgentFields
        .extend({
          parentId: planningRef.nullable().optional(),
          relations: z
            .array(z.object({ kind: z.enum(relationKinds), id: planningRef }))
            .max(20)
            .optional(),
        })
        .optional(),
      /** Change one Done-when line without sending the body (src/hosted-agent-planning-tick.ts): with `line` (1-based
       * checkbox position or unique text prefix) the text replaces that line; without it one open checkbox is added.
       * Needs no expectedVersion. */
      doneWhen: z
        .object({
          line: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
          text: z.string().trim().min(1).max(2000),
        })
        .optional(),
      /** One backlog batch (src/hosted-agent-planning-batch.ts): up to 100 puts or comments, one call, one Undo. */
      batch: z.array(z.record(z.string(), z.unknown())).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      value =>
        value.batch === undefined ||
        Object.keys(value).every(key => key === 'batch' || key === 'expectedVersion'),
      'batch: send the entries alone.',
    )
    .refine(
      value => !value.doneWhen || value.body === undefined,
      'doneWhen edits one line; do not send body with it.',
    ),
  'comment-planning-item': planningCommentCommandSchema
    .omit({
      action: true,
      operationId: true,
      agent: true,
      agentClient: true,
      decidedBy: true,
      attachments: true,
      line: true, // Only accepted by the atomic Item tick batch, not by standalone comments.
    }) // Set by the session and server.
    // Local file paths: the CLI uploads them to R2 and names them on the comment (src/hosted-agent-planning-attach.ts).
    .extend({ ...planningIssueFields, files: z.array(z.string()).max(4).optional() })
    .strict()
    .refine(
      value => Boolean(value.planningItemId || value.id || value.itemId),
      'planningItemId: name the Issue.',
    ),
  /** Tick one Done-when line and post its evidence, composed from put-planning-item and comment-planning-item
   * (src/hosted-agent-planning-tick.ts). Never advertised: it works on every server that has those two. */
  'tick-planning-item': z
    .object({
      ...planningIssueFields,
      line: z.union([z.number().int().positive(), z.string().trim().min(1)]),
      evidence: z.string().trim().min(1),
      authorLabel: z.string().trim().default(''),
      replyTo: planningRef.optional(),
    })
    .strict()
    .refine(
      value => Boolean(value.planningItemId || value.id || value.itemId),
      'planningItemId: name the Issue.',
    ),
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
