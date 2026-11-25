// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invitationState, invitationMail, invitationTables } from './projectInvitationFields';
import {
  journalTables,
  journalReceiptTables,
  planningArchiveBackfillProgress,
  planningArchiveIndexVersion,
} from './projectJournalFields';
import { liveLineTables } from './projectLiveLineFields';
import { publicDiscoveryTables } from './publicDiscoveryFields';
import { landingReadTables } from './projectLandingReadFields';
import { statsTables } from './projectStatsFields';
import { personDayTables } from './personDayFields';
import { finishReadTables } from './projectFinishReadFields';
import { hostedOverlapTables } from './projectHostedOverlapFields';
import { boardTables } from './projectBoardFields';
import { laneSnapshotTables } from './projectLaneSnapshotFields';
import { abuseLimitTables } from './abuseLimitFields';
import { abuseReportTables } from './abuseReportFields';
import { connectedApps } from './agentConnectionFields';
import { hostedFrictionTables } from './projectHostedFrictionFields';
import { selfMetricBillTables } from './projectSelfMetricBillFields';
import { selfMetricReceiptTables } from './projectSelfMetricReceiptFields';
import { hostedDecisionTables } from './projectHostedDecisionsFields';
import { hostedTrustTables } from './projectHostedTrustFields';
import { githubBindingTables } from './githubBindingFields';
import { githubMirrorTables } from './projectGithubMirrorFields';
import { deployTables } from './projectDeployFields';
import { sourceStepTables } from './projectSourceStepFields';
import { workDetailMigration, workDetailTables } from './projectWorkDetailFields';
import { hostedSeedTables } from './projectHostedSeedFields';
import { backfillFields } from './r2BackfillFields';
import { r2ReferencePosition } from './projectPurgeReferenceFields';
import { sourceAuthority, sourceAuthorityTables } from './projectSourceAuthorityFields';
import { actorTables } from './projectActorFields';
import { autonomyPolicy, autonomyTables, automaticAction } from './autonomyFields';
import { briefTables } from './agentBriefFields';
import { deviceTables } from './deviceFields';
import { sealedSecretTables } from './sealedSecretFields';
import { clientErrorTables } from './clientErrorFields';
import { indexTables } from './projectWorkIndexFields';
import { hostedRecordTables } from './projectHostedRecordFields';
import { hostedSyncTables } from './projectHostedSyncFields';
import { hostedComposeTables } from './projectHostedComposeFields';
import { hostedCheckTables } from './projectHostedCheckFields';
import { hostedMainAuditTables } from './projectHostedMainAuditFields';
import { hostedOutputTables } from './projectHostedOutputFields';
import { hostedActionsTables } from './projectHostedActionsFields';
import { hostedFinishTables } from './projectHostedFinishFields';
import { hostedApprovalTables } from './projectHostedApprovalFields';
import { hostedLandingTables } from './projectHostedLandingFields';
import { landingSpeedTables } from './projectLandingSpeedFields';
import { failureLogTables } from './projectFailureLogFields';
import { hostedSaveTables } from './projectHostedSaveFields';
import { hostedSnapshotTables } from './projectHostedSnapshotFields';
import { checkTables } from './projectCheckFields';
import { coordinationTables } from './coordinationFields';
import { planningReactionTables } from './planningReactionFields';
import { githubImportTables } from './projectGithubImportFields';
import { historyTables } from './projectHistoryFields';
import { publicationTables } from './projectPublicationFields';
import { objectTables } from './projectObjectFields';
import { artifactBlobTables } from './artifactBlobFields';
import { derivedFields } from './derivedArtifactFields';
import { hostedLifecycleTables } from './projectHostedLifecycleFields';
import { hostedAcceptanceTables } from './projectHostedAcceptanceFields';
import { intentLandingNoteTables } from './projectIntentLandingNoteFields';
import { initiativeWorkTables } from './projectInitiativeWorkFields';
import { deleteRequestTables } from './projectDeleteRequestFields';
import { defineSchema, defineTable } from 'convex/server';
import { feedTables } from './projectFeedFields';
import { accountClosing, accountFields, accountItemFields } from './accountTypes';
import { v } from 'convex/values';
import { authTables } from './authFields';
import { AGENT_TOOLS } from '../src/types';

export const syncResult = v.object({
  checkedAt: v.number(),
  result: v.union(v.literal('checked'), v.literal('unavailable'), v.literal('error')),
  head: v.optional(v.string()),
});
export const jobFields = {
  r2Writes: v.optional(v.boolean()),
  scope: v.string(),
  repository: v.string(),
  ref: v.string(),
  owner: v.string(),
  visibility: v.union(v.literal('public'), v.literal('private')),
  phase: v.union(
    v.literal('queued'),
    v.literal('fetching'),
    v.literal('indexing'),
    v.literal('ready'),
    v.literal('error'),
  ),
  processed: v.number(),
  total: v.number(),
  error: v.optional(v.string()),
  artifactKey: v.optional(v.string()),
  head: v.optional(v.string()),
  analysisVersion: v.optional(v.string()),
  generation: v.number(),
  task: v.optional(v.id('_scheduled_functions')),
  // Left on older rows by the retired hosted analysis worker (Item ef6aa22a); a rerun clears them.
  remote: v.optional(v.boolean()),
  workerClaimed: v.optional(v.boolean()),
  syncRevision: v.optional(v.number()),
  syncEventRevision: v.optional(v.number()),
  sync: v.optional(syncResult),
  removal: v.optional(v.union(v.literal('trash'), v.literal('deleting'))),
  removedAt: v.optional(v.number()),
};
export const jobDocument = v.object({ _id: v.id('imports'), _creationTime: v.number(), ...jobFields });
export const savedRoute = v.object({
  view: v.union(v.literal('home'), v.literal('readme'), v.literal('map'), v.literal('source')),
  state: v.string(),
  file: v.string(),
  line: v.number(),
  document: v.optional(v.string()),
  anchor: v.optional(v.string()),
  symbol: v.optional(v.string()),
  lens: v.optional(v.union(v.literal('imports'), v.literal('references'))),
});
export const savedLink = {
  importId: v.id('imports'),
  operationId: v.string(),
  name: v.string(),
  route: savedRoute,
};
export const secretCapability = v.union(
  v.literal('discover'),
  v.literal('names'),
  v.literal('use'),
  v.literal('reveal'),
  v.literal('modify'),
  v.literal('delegate'),
);
export const sealedSecret = v.object({
  keyId: v.string(),
  nonce: v.string(),
  tag: v.string(),
  ciphertext: v.string(),
});
export const agentTool = v.union(...AGENT_TOOLS.map(tool => v.literal(tool)));
export const agentFields = {
  owner: v.string(),
  name: v.string(),
  operationId: v.string(),
  request: v.string(),
  importId: v.id('imports'),
  artifactKey: v.string(),
  sourceId: v.string(),
  gitHead: v.string(),
  files: v.array(v.string()),
  tools: v.array(agentTool),
  expiresAt: v.number(),
  revoked: v.boolean(),
  tokenHash: v.string(),
  /** Retired: the token sealed under the server keyring. Never written now; purged by convex/secretObjectsRetire.ts and
   * dropped from the schema by the follow-up landing. */
  sealed: v.optional(sealedSecret),
};
export const agentDocument = v.object({
  _id: v.id('agentGrants'),
  _creationTime: v.number(),
  ...agentFields,
});
export const zoneFields = {
  owner: v.string(),
  importId: v.id('imports'),
  name: v.string(),
  operationId: v.string(),
  request: v.string(),
  artifactKey: v.string(),
  sourceId: v.string(),
  gitHead: v.string(),
  files: v.array(v.string()),
  enabled: v.boolean(),
  revision: v.number(),
};
export const zoneDocument = v.object({ _id: v.id('sourceZones'), _creationTime: v.number(), ...zoneFields });
export const zoneUpdate = v.union(
  v.object({ kind: v.literal('reader'), reader: v.string(), present: v.boolean() }),
  v.object({ kind: v.literal('enabled'), enabled: v.boolean() }),
);
export const zoneChange = {
  zoneId: v.id('sourceZones'),
  operationId: v.string(),
  request: v.string(),
  previousRevision: v.number(),
  revision: v.number(),
  at: v.number(),
  update: zoneUpdate,
};
export const interestUpdate = v.union(
  v.object({ kind: v.literal('star'), value: v.boolean() }),
  v.object({ kind: v.literal('watch'), value: v.boolean() }),
  v.object({ kind: v.literal('seen'), head: v.string() }),
);
export const interestFields = {
  owner: v.string(),
  importId: v.id('imports'),
  repository: v.string(),
  ref: v.string(),
  starred: v.boolean(),
  watching: v.boolean(),
  seenHead: v.union(v.string(), v.null()),
  active: v.boolean(),
  revision: v.number(),
};
export const interestDocument = v.object({
  _id: v.id('projectInterests'),
  _creationTime: v.number(),
  ...interestFields,
});
export const interestReceipt = {
  owner: v.string(),
  importId: v.id('imports'),
  operationId: v.string(),
  request: v.string(),
  revision: v.number(),
  at: v.number(),
  update: interestUpdate,
};
export const secretFields = {
  owner: v.string(),
  name: v.string(),
  operationId: v.string(),
  repository: v.string(),
  ref: v.string(),
  version: v.number(),
  disabled: v.boolean(),
  policyRevision: v.number(),
  archived: v.optional(v.boolean()),
  archiveRevision: v.optional(v.number()),
  deleting: v.optional(v.boolean()),
};
export const secretVersionFields = {
  secretId: v.id('secretObjects'),
  version: v.number(),
  operationId: v.string(),
  previousVersion: v.number(),
  inputTag: v.string(),
  sealed: sealedSecret,
};
export const secretEventFields = {
  secretId: v.id('secretObjects'),
  actor: v.string(),
  operationId: v.string(),
  kind: v.union(
    v.literal('create'),
    v.literal('rotate'),
    v.literal('grant'),
    v.literal('expire'),
    v.literal('cascade-revoke'),
    v.literal('enable'),
    v.literal('disable'),
    v.literal('use'),
    v.literal('reveal'),
    v.literal('archive'),
    v.literal('unarchive'),
  ),
  version: v.number(),
  policyRevision: v.number(),
  at: v.number(),
  principal: v.optional(v.string()),
  capabilities: v.optional(v.array(secretCapability)),
  expiresAt: v.optional(v.number()),
  sha: v.optional(v.string()),
  archiveRevision: v.optional(v.number()),
  cascadeFrom: v.optional(v.string()),
  affectedGrants: v.optional(
    v.array(
      v.object({
        principal: v.string(),
        capabilities: v.array(secretCapability),
        expiresAt: v.union(v.number(), v.null()),
      }),
    ),
  ),
};
export const projectBackupPreview = v.object({
  manifestDigest: v.string(),
  head: v.string(),
  format: v.union(v.literal('sha1'), v.literal('sha256'), v.literal('native')),
  revision: v.number(),
  intents: v.number(),
  lanes: v.number(),
  views: v.number(),
  runs: v.number(),
  files: v.number(),
  unavailable: v.number(),
  channels: v.array(v.object({ name: v.string(), head: v.string() })),
});
export const hostedWorkFields = v.object({
  recordDetails: v.optional(workDetailMigration),
  intentMigration: v.optional(
    v.object({ operationId: v.string(), revision: v.number(), generationId: v.id('projectWorkGenerations') }),
  ),
  generationId: v.optional(v.id('projectWorkGenerations')),
  backupId: v.id('projectBackups'),
  originBackupId: v.optional(v.id('projectBackups')),
  operationId: v.string(),
  initialRevision: v.number(),
  revision: v.number(),
});
export const hostedWorkEventFields = {
  automatic: v.optional(automaticAction),
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  request: v.string(),
  previousRevision: v.number(),
  revision: v.number(),
  actor: v.string(),
  at: v.string(),
  command: v.string(),
  baseBackupId: v.optional(v.id('projectBackups')),
  /** A purged row (Item 4c9e961e): the purge operation that removed its words. `command` then holds the row's own
   * command with every word replaced; readers accept it only when that purge exists, comes later and names the same
   * Item. */
  purged: v.optional(v.string()),
};
export const hostedWorkEventDocument = v.object({
  _id: v.union(v.id('projectWorkEvents'), v.id('projectHostedRecordBodies')),
  _creationTime: v.number(),
  ...hostedWorkEventFields,
});
export const projectRemoval = v.union(v.literal('trash'), v.literal('deleting'), v.literal('deleted'));
export const projectPurgeBlocked = v.union(
  /** Retired: the prefix purge no longer reads the global flag; kept for existing rows. */
  v.literal('R2_MAINTENANCE_DISABLED'),
  v.literal('R2_PURGE_RETRY_EXHAUSTED'),
  v.literal('R2_PURGE_UNAUTHORIZED'),
  v.literal('R2_PURGE_SHARED'),
);
export const projectRetention = v.object({
  purgeAt: v.number(),
  task: v.optional(v.id('_scheduled_functions')),
  /** Grant/runner revocation still has pages left; restore waits for it. */
  revoking: v.optional(v.boolean()),
  measure: v.optional(
    v.object({
      stage: v.number(),
      cursor: v.union(v.string(), v.null()),
      task: v.id('_scheduled_functions'),
    }),
  ),
  retainedBytes: v.number(),
  retainedObjects: v.number(),
  measured: v.boolean(),
});
export const projectPurge = v.object({
  operationId: v.string(),
  reason: v.union(v.literal('retention'), v.literal('owner')),
  startedAt: v.number(),
  table: v.optional(v.number()),
  rows: v.number(),
  bytes: v.number(),
  pages: v.number(),
  /** R2 objects and bytes removed under the project prefix. */
  r2Objects: v.optional(v.number()),
  r2Bytes: v.optional(v.number()),
  /** Whether this purge kept the original alias-to-key metadata through the row phase. */
  artifactInventoryIntact: v.optional(v.boolean()),
  completedAt: v.optional(v.number()),
});
const projectFields = {
  /** What waits on a person in the project's sealed secrets: the sum of its sets' `needs` (convex/sealedSecretNeeds.ts),
   * moved by the same writes that change a marker, a proposal or a rotate row. Absent when zero. Item 41a0df87. */
  secretsNeeds: v.optional(v.number()),
  /** How many `projectTeams` links this project has (Item b6588425, docs/access.md#teams). Kept with each link
   * change in the same transaction, so a project without teams resolves roles with no team read. */
  teamLinks: v.optional(v.number()),
  /** Bumped by every team-link change; `projectTeamAccess.set` compares it so a retried or stale edit cannot
   * re-grant access the owner removed since. */
  teamRevision: v.optional(v.number()),
  /** One durable, project-scoped physical seed; source jobs own its pages and retries. */
  physicalSeed: v.optional(
    v.object({
      jobId: v.string(),
      state: v.object({ sha256: v.string(), size: v.number() }),
      base: v.optional(v.object({ sha256: v.string(), size: v.number() })),
    }),
  ),
  /** Physical history relocation fence, independent of logical Work revision. */
  journalRevision: v.optional(v.number()),
  /** Purge selection pins event bytes independently of append-only journal publication. */
  journalEventRewriteRevision: v.optional(v.number()),
  /** Indexed purge is safe once every legacy archive is covered. New word-bearing publications advance its fence. */
  planningArchiveIndexed: v.optional(v.union(v.literal(true), v.literal(planningArchiveIndexVersion))),
  planningArchiveBackfill: v.optional(
    v.union(
      v.object({ legacyRecords: v.boolean(), cursor: v.union(v.string(), v.null()) }),
      planningArchiveBackfillProgress,
    ),
  ),
  planningArchiveEventRevision: v.optional(v.number()),
  journalRecordReceipts: v.optional(v.literal(true)),
  /** Flip 5 Work store mode (Issue 0695ab24): absent = journal only; dual = planning writes also store
   * their Issue version, comment or note record in the same mutation; records = dual, and the planning
   * reads (Issues, versions, comments) and an Intent's notes and moves come from the store. */
  workStoreWriters: v.optional(
    v.array(
      v.union(v.literal('note'), v.literal('intent'), v.literal('intent-status'), v.literal('planning')),
    ),
  ),
  workStoreCutoverRevision: v.optional(v.number()),
  workStoreEventWindows: v.optional(v.array(v.object({ revision: v.number(), storeFirst: v.boolean() }))),
  workStore: v.optional(v.union(v.literal('dual'), v.literal('records'))),
  /** Durable one-time Item Intent and Lane membership repair frontier; true is complete. */
  itemLaneMembership: v.optional(v.union(v.string(), v.literal(true))),
  /** Roll-up's independent coverage proof for existing open-Lane tally rows. */
  planLaneMarkCoverage: v.optional(
    v.object({ generationId: v.id('projectWorkGenerations'), cursor: v.union(v.string(), v.null()) }),
  ),
  needsFix: v.optional(v.record(v.string(), v.string())),
  checkLogSweep: v.optional(
    v.object({
      operationId: v.string(),
      cutoff: v.number(),
      sequence: v.number(),
      task: v.id('_scheduled_functions'),
      running: v.boolean(),
      settling: v.optional(v.boolean()),
    }),
  ),
  checkLogSweptAt: v.optional(v.number()),
  purgeBlocked: v.optional(projectPurgeBlocked),
  /** Owner-restorable deletion window; one scheduled expiry, never a polling cron. */
  retention: v.optional(projectRetention),
  /** Paged permanent purge receipt: operation id and progress for the owner. */
  purge: v.optional(projectPurge),
  /** Item purges (Item 4c9e961e, convex/projectPlanningPurge.ts): one entry per purge, ids and decision requests the
   * redaction needs, `purgedAt` only once the completeness check found no words left. Bounded: an unfinished purge
   * stays until it finishes; finished ones keep the newest few. */
  /** Invalidates whole-Work and recovery reads that crossed the end of a physical Item redaction. */
  planningPurgeRevision: v.optional(v.number()),
  /** The one record-detail migration whose staged copy (a copy of every word) exists (Item b6588425 line 2e): purges
   * refuse to start while it is set; set by the stage, cleared when the copy is published or deleted. */
  stagedDetailMigration: v.optional(v.object({ operationId: v.string(), at: v.number() })),
  itemPurges: v.optional(
    v.array(
      v.object({
        operationId: v.string(),
        itemId: v.string(),
        /** One comment's purge whose row is in the journal archive (convex/projectCommentPurgeArchive.ts): only the
         * segment sweep runs, for that comment; the Item is not purged. */
        commentId: v.optional(v.string()),
        ids: v.array(v.string()),
        intentId: v.optional(v.string()),
        intentKeys: v.optional(v.array(v.string())),
        version: v.number(),
        decisions: v.array(v.array(v.string())),
        rows: v.number(),
        // Revision of the Item's creation row: it must stay after the stored base until the purge is done.
        created: v.optional(v.number()),
        startedAt: v.number(),
        purgedAt: v.optional(v.number()),
        /** One comment's purge whose words are in the stored base checkpoint (convex/projectCommentPurgeBase.ts): the
         * backup it scrubs, then, once the scrubbed root is published and the old objects tombstoned, the R2 work
         * left; `done` once those bytes are gone. */
        baseScrub: v.optional(
          v.object({
            backupId: v.id('projectBackups'),
            done: v.boolean(),
            pending: v.optional(
              v.object({
                deletes: v.array(v.string()),
                zero: v.array(v.object({ key: v.string(), offset: v.number(), size: v.number() })),
              }),
            ),
          }),
        ),
        segmentSweep: v.optional(
          v.object({
            after: v.union(v.string(), v.null()),
            indexed: v.optional(v.literal(true)),
            done: v.boolean(),
            claim: v.optional(v.object({ id: v.string(), until: v.number() })),
            pending: v.optional(
              v.object({
                key: v.string(),
                planned: v.optional(v.array(v.string())),
                retire: v.optional(v.array(v.string())),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  r2Purge: v.optional(
    v.object({
      generation: v.number(),
      cursor: v.union(v.string(), v.null()),
      failures: v.number(),
      references: v.optional(
        v.object({ operationId: v.string(), next: v.union(r2ReferencePosition, v.null()) }),
      ),
    }),
  ),
  sourceAuthority: v.optional(sourceAuthority),
  /** Minimum State-source reader after a trusted complete physical root is committed. */
  sourceManifestVersion: v.optional(v.literal(2)),
  /** Legacy, trees in packs (tried and dropped, docs/decisions.md): never written or read; tolerated so
   * a project row written before the rollback still validates. Remove with `stateTree` on objects. */
  stateTrees: v.optional(v.any()),
  sourceCutover: v.optional(v.object({ minimumCliVersion: v.string(), at: v.string() })),
  /** A legacy recovery published a root without complete writer membership. */
  metricContextGap: v.optional(v.string()),
  metricContextBootstrap: v.optional(v.string()),
  metricContextCoverage: v.optional(
    v.object({
      generation: v.string(),
      authorityEpoch: v.number(),
      cutover: v.union(v.string(), v.null()),
      from: v.number(),
      to: v.number(),
    }),
  ),
  metricSaveHeadResume: v.optional(
    v.object({
      operationId: v.string(),
      requestedAt: v.number(),
      phase: v.union(v.literal('pending'), v.literal('watching'), v.literal('scheduled')),
    }),
  ),
  visibility: v.optional(v.union(v.literal('private'), v.literal('public'))),
  /** Public plan setting (src/planning-model.ts publicPlanVisible): absent = the plan of a public project is public;
   * 'members' keeps every Item, Initiative and comment to members. */
  planVisibility: v.optional(v.literal('members')),
  hostingRequest: v.optional(v.string()),
  autonomyPolicy: v.optional(autonomyPolicy),
  planningRollupCatchup: v.optional(v.id('projectWorkDataRecords')),
  /** Desired mirror direction retained while its existing policy is disabled. */
  githubMirrorPausedInbound: v.optional(v.boolean()),
  /** Entry files of every check definition and setup action (src/public-governance.ts); kept current by the definition save. Absent until the first save after this field existed. */
  checkEntries: v.optional(v.array(v.string())),
  /** Server-selected verify (or sole) definition; null means the definition set is ambiguous. */
  landingCheckId: v.optional(v.union(v.string(), v.null())),
  /** Declared `globalRiskPaths` globs of every check definition, refreshed with `checkEntries`; global-risk only, never owner-protected. */
  globalRiskPaths: v.optional(v.array(v.string())),
  agentGuidance: v.optional(v.string()),
  exchangeCleanupCursor: v.optional(v.string()),
  exchangeCleanupDone: v.optional(v.boolean()),
  /** Retired opt-in; kept for existing rows. Placement no longer reads it: bytes always go to R2. */
  r2Writes: v.optional(v.boolean()),
  r2BackfillRevision: v.optional(v.number()),
  /** Retired flag; kept for existing rows. Nothing writes or reads it. */
  r2StorageUsed: v.optional(v.boolean()),
  r2PrefixPurged: v.optional(v.boolean()),
  owner: v.string(),
  key: v.string(),
  name: v.string(),
  slug: v.optional(v.string()),
  currentBackup: v.union(v.id('projectBackups'), v.null()),
  revision: v.number(),
  work: v.optional(hostedWorkFields),
  removal: v.optional(projectRemoval),
  removedAt: v.optional(v.number()),
  /** Purge acknowledgments must remain attributable after rename, address reuse or source deletion. */
  snapshotHide: v.optional(v.array(v.object({ id: v.id('publicSnapshotJobs'), generation: v.number() }))),
  snapshotProfileRevocation: v.optional(
    v.object({ epoch: v.number(), scanning: v.boolean(), pending: v.number() }),
  ),
  task: v.optional(v.id('_scheduled_functions')),
  nameChange: v.optional(
    v.object({
      operationId: v.string(),
      expectedRevision: v.number(),
      name: v.string(),
      slug: v.optional(v.string()),
    }),
  ),
  lifecycle: v.optional(
    v.object({
      operationId: v.string(),
      action: v.string(),
      expectedRevision: v.number(),
      /** A restore that moved to a free address (Item eb631a53): its answer, kept for a retry. */
      address: v.optional(v.object({ slug: v.string(), previousSlug: v.string() })),
      /** A person joined after this restore (Item 966cb821): its Undo no longer applies. */
      shared: v.optional(v.literal(true)),
    }),
  ),
};
const projectBackupFields = {
  ...backfillFields,
  displayProtocol: v.optional(v.literal(3)),
  metadataPublication: v.optional(v.id('projectPublications')),
  ownerDerived: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  validatedWorkRecords: v.optional(v.literal(1)),
  validatedClosure: v.optional(v.literal(1)),
  historyBackfilling: v.optional(v.boolean()),
  objectManifest: v.optional(v.object({ digest: v.string(), size: v.number() })),
  /** The scrubbed exchange root a purge wrote over this base (Item b6588425 line 2d, src/work-base-scrub.ts): every
   * base reader reads it (backupRootPin) and checks its manifest digest; `originalWork` is the whole-Work digest the
   * backup's derived owner pages and returned-source events name. */
  scrubbed: v.optional(
    v.object({
      operationId: v.string(),
      root: v.object({ sha256: v.string(), size: v.number() }),
      manifestDigest: v.string(),
      originalWork: v.string(),
      at: v.number(),
    }),
  ),
  archiveReceipt: v.optional(
    v.object({
      digest: v.string(),
      size: v.number(),
      storageId: v.optional(v.id('_storage')),
      ...backfillFields,
      operationId: v.string(),
      at: v.number(),
    }),
  ),
  transport: v.optional(v.literal('objects')),
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  request: v.string(),
  nonce: v.string(),
  previous: v.union(v.id('projectBackups'), v.null()),
  digest: v.string(),
  size: v.number(),
  preview: projectBackupPreview,
  status: v.union(v.literal('uploading'), v.literal('stored')),
  storageId: v.optional(v.id('_storage')),
};
export const projectDocument = v.object({
  _id: v.id('hostedProjects'),
  _creationTime: v.number(),
  ...projectFields,
});
export const projectBackupDocument = v.object({
  _id: v.id('projectBackups'),
  _creationTime: v.number(),
  ...projectBackupFields,
});
export const projectContributorFields = {
  projectId: v.id('hostedProjects'),
  contributor: v.string(),
  agentGuidanceMaintainer: v.optional(v.boolean()),
  /** Fixed-size fresh-operation counters; absent for memberships created before work budgets. */
  workBudget: v.optional(
    v.object({ day: v.number(), checks: v.number(), composes: v.number(), submissions: v.number() }),
  ),
};
export const projectProposalFields = {
  ...backfillFields,
  transport: v.optional(v.literal('objects')),
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  operationId: v.string(),
  request: v.string(),
  nonce: v.string(),
  intentId: v.string(),
  baseBackupId: v.id('projectBackups'),
  baseArchiveSha256: v.string(),
  baseState: v.string(),
  head: v.string(),
  viewId: v.string(),
  digest: v.string(),
  size: v.number(),
  preview: projectBackupPreview,
  status: v.union(v.literal('uploading'), v.literal('stored')),
  storageId: v.optional(v.id('_storage')),
};
export const projectProposalDocument = v.object({
  _id: v.id('projectProposals'),
  _creationTime: v.number(),
  ...projectProposalFields,
});
export default defineSchema({
  ...authTables,
  ...invitationTables,
  ...journalTables,
  ...journalReceiptTables,
  ...finishReadTables,
  ...liveLineTables,
  ...publicDiscoveryTables,
  ...landingReadTables,
  ...statsTables,
  ...personDayTables,
  legacyStorageTombstones: defineTable({
    storageId: v.id('_storage'),
    digest: v.string(),
    size: v.number(),
    copyKey: v.string(),
    operationId: v.string(),
    contentType: v.optional(v.string()),
  })
    .index('by_storage', ['storageId'])
    .index('by_copy_key', ['copyKey']),
  legacyStorageCleanupWindows: defineTable({
    operationId: v.string(),
    deployment: v.string(),
    startedAt: v.number(),
    expiresAt: v.number(),
    active: v.boolean(),
    endedAt: v.optional(v.number()),
  }).index('by_operation', ['operationId']),
  legacyStorageCleanupPages: defineTable({
    operationId: v.string(),
    part: v.string(),
    request: v.string(),
    result: v.string(),
  }).index('by_operation_and_part', ['operationId', 'part']),
  ...githubMirrorTables,
  ...deployTables,
  ...githubBindingTables,
  ...sourceStepTables,
  ...workDetailTables,
  projectCheckLogCleanupPages: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    part: v.string(),
    position: v.number(),
    value: v.string(),
  }).index('by_project_and_operation_and_part_and_position', [
    'projectId',
    'operationId',
    'part',
    'position',
  ]),
  projectCheckLogRetentions: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    expiresAt: v.number(),
  })
    .index('by_project_and_key', ['projectId', 'key'])
    .index('by_project_and_expiry', ['projectId', 'expiresAt']),
  projectCheckLogSourcePins: defineTable({
    projectId: v.id('hostedProjects'),
    digest: v.string(),
  }).index('by_project', ['projectId']),
  projectCheckLogCleanups: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    value: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  ...hostedSeedTables,
  // Explicit current Channel pins; recovery/display snapshots never select these.
  projectHostedChannels: defineTable({
    operationId: v.string(),
    projectId: v.id('hostedProjects'),
    name: v.string(),
    selection: v.string(),
  }).index('by_project_and_name', ['projectId', 'name']),
  // Owner signatures over released States; the CLI updater verifies them (convex/projectReleaseSignatures.ts).
  projectReleaseSignatures: defineTable({
    projectId: v.id('hostedProjects'),
    head: v.string(),
    keyId: v.string(),
    signature: v.string(),
    /** Signed release number (v2 signatures); absent on v1 rows made before release numbers. */
    release: v.optional(v.number()),
    actor: v.string(),
    at: v.number(),
  })
    .index('by_project_and_head', ['projectId', 'head'])
    .index('by_project_and_release', ['projectId', 'release']),
  projectReturnSupersessions: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    pushOperationId: v.string(),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    replacementId: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  forgeAccounts: defineTable({
    owner: v.string(),
    handle: v.string(),
    connectedApps: v.optional(connectedApps),
    /** True until the person picks or keeps a handle once; unset until first checked. */
    handlePrompt: v.optional(v.boolean()),
    /** Retired Secret Object review fields: never written now, cleared by convex/secretObjectsRetire.ts, dropped by the
     * next landing. */
    secretsReview: v.optional(v.object({ epoch: v.number(), operationId: v.string() })),
    secretsLeftBelow: v.optional(v.number()),
    secretsLeftBefore: v.optional(v.number()),
    /** Set while the account closes (convex/accountClose.ts): its operation, start time and where the background
     * removal stands. The row itself goes last. */
    closing: v.optional(accountClosing),
  })
    .index('by_owner', ['owner'])
    .index('by_handle', ['handle']),
  accountHandles: defineTable({ owner: v.string(), handle: v.string() })
    .index('by_handle', ['handle'])
    // Closing an account releases every handle it ever held (convex/accountClose.ts).
    .index('by_owner', ['owner']),
  handleOperations: defineTable({ owner: v.string(), operationId: v.string(), handle: v.string() }).index(
    'by_owner_and_operation',
    ['owner', 'operationId'],
  ),
  // Item 3d5d8839: a person's projects in activity order (convex/accountProjectOrder.ts); an ordering hint, never access.
  accountProjectOrder: defineTable({
    person: v.string(),
    projectId: v.id('hostedProjects'),
    role: v.union(v.literal('owner'), v.literal('write'), v.literal('read')),
    activityHour: v.number(),
  })
    .index('by_person_and_activity', ['person', 'activityHour', 'projectId'])
    .index('by_project_and_person', ['projectId', 'person'])
    .index('by_project_and_activity', ['projectId', 'activityHour']),
  projectSlugs: defineTable({ owner: v.string(), slug: v.string(), projectId: v.id('hostedProjects') })
    .index('by_owner_and_slug', ['owner', 'slug'])
    .index('by_project', ['projectId']),
  ...sourceAuthorityTables,
  ...autonomyTables,
  ...briefTables,
  ...actorTables,
  ...deviceTables,
  ...sealedSecretTables,
  ...clientErrorTables,
  ...checkTables,
  ...coordinationTables,
  ...planningReactionTables,
  ...indexTables,
  ...hostedRecordTables,
  // Disposable Item History summaries; not journal or exported source records.
  projectPlanningAudit: defineTable({
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    version: v.number(),
    value: v.string(),
  }).index('by_project_and_item_and_version', ['projectId', 'itemId', 'version']),
  ...hostedSaveTables,
  ...hostedComposeTables,
  ...hostedSyncTables,
  ...hostedCheckTables,
  ...hostedMainAuditTables,
  ...hostedOutputTables,
  ...hostedActionsTables,
  ...hostedLandingTables,
  ...feedTables,
  ...landingSpeedTables,
  ...failureLogTables,
  ...hostedFinishTables,
  ...hostedApprovalTables,
  ...hostedAcceptanceTables,
  ...intentLandingNoteTables,
  ...initiativeWorkTables,
  ...deleteRequestTables,
  ...hostedLifecycleTables,
  ...hostedSnapshotTables,
  ...objectTables,
  ...artifactBlobTables,
  ...githubImportTables,
  ...historyTables,
  derivedArtifacts: defineTable(derivedFields)
    .index('by_original_and_kind_and_pin', ['original', 'kind', 'pin'])
    .index('by_original_and_removed', ['original', 'removed']),
  accountOperations: defineTable(accountFields)
    .index('by_owner_and_operation', ['owner', 'operationId'])
    // index-order: caller: convex/accountPlan.ts#receipts; order: account receipt list exposes newest-first creation-time pages.
    .index('by_owner', ['owner']),
  accountItems: defineTable(accountItemFields)
    .index('by_account_and_key', ['accountId', 'key'])
    .index('by_account_and_hidden_and_key', ['accountId', 'hidden', 'key'])
    .index('by_owner_and_kind_and_creation_operation_and_state', [
      'owner',
      'kind',
      'expected.creationOperationId',
      'state',
    ]),
  projectUploadCleanup: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    actor: v.string(),
    uploadId: v.string(),
    operationId: v.string(),
    kind: v.union(v.literal('backup'), v.literal('proposal')),
    nonce: v.string(),
    digest: v.string(),
    size: v.number(),
    cursor: v.optional(v.string()),
    pending: v.boolean(),
    r2Key: v.optional(v.string()),
    task: v.optional(v.id('_scheduled_functions')),
  })
    .index('by_upload', ['uploadId'])

    .index('by_project_and_pending', ['projectId', 'pending'])
    .index('by_r2Key', ['r2Key']),
  projectReaders: defineTable({ projectId: v.id('hostedProjects'), reader: v.string() })
    .index('by_project_and_reader', ['projectId', 'reader'])
    .index('by_reader', ['reader']),
  projectReaderOperations: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    reader: v.string(),
    present: v.boolean(),
    operationId: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  projectAccessOperations: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    // The generation counter alone omits this; request writers require a string operation id.
    operationId: v.optional(v.string()),
    person: v.string(),
    invitationEpoch: v.optional(v.number()),
    role: v.optional(v.union(v.literal('read'), v.literal('write'))),
    // One invitation email's send state (convex/projectInviteMail.ts); never the address body or token.
    mail: v.optional(
      v.object({
        status: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed'), v.literal('off')),
        sends: v.number(),
        at: v.number(),
        code: v.optional(v.string()),
        resend: v.optional(v.string()),
      }),
    ),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  projectInvites: defineTable({
    projectId: v.optional(v.id('hostedProjects')),
    teamId: v.optional(v.id('teams')),
    email: v.string(),
    target: v.optional(v.string()),
    kind: v.optional(v.union(v.literal('email'), v.literal('handle'))),
    inviter: v.optional(v.string()),
    recipient: v.optional(v.string()),
    invitationEpoch: v.optional(v.number()),
    state: v.optional(invitationState),
    expiresAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    answer: v.optional(v.object({ operationId: v.string(), person: v.string(), choice: v.string() })),
    mail: v.optional(invitationMail),
    role: v.optional(v.union(v.literal('read'), v.literal('write'))),
    operationId: v.optional(v.string()),
  })
    // index-order: caller: convex/projectAccess.ts#people; order: invitation history exposes newest-first creation-time pages, not target or operation order.
    .index('by_project', ['projectId'])
    .index('by_project_and_email', ['projectId', 'email'])
    .index('by_email', ['email'])
    .index('by_recipient', ['recipient'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_state_and_expiry', ['projectId', 'kind', 'state', 'expiresAt'])
    // index-order: caller: convex/teamInvitationReads.ts#pending; order: show the newest pending invitations first.
    .index('by_teamId_and_state', ['teamId', 'state'])
    .index('by_teamId_and_operationId', ['teamId', 'operationId'])
    .index('by_teamId_and_email_and_state', ['teamId', 'email', 'state']),
  projectContributors: defineTable(projectContributorFields)
    .index('by_project_and_contributor', ['projectId', 'contributor'])
    .index('by_contributor', ['contributor']),
  projectProposals: defineTable(projectProposalFields)
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_storage', ['storageId'])
    .index('by_r2Key', ['r2Key']),
  projectItemRetention: defineTable({
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    kind: v.union(v.literal('deadline'), v.literal('attempt')),
    version: v.optional(v.number()),
    purgeAt: v.optional(v.number()),
    position: v.optional(v.number()),
    itemKind: v.optional(v.union(v.literal('issue'), v.literal('initiative'))),
    initiativeId: v.optional(v.string()),
    attemptAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    purgedAt: v.optional(v.number()),
  })
    .index('by_project_and_item_and_kind', ['projectId', 'itemId', 'kind'])
    .index('by_project_and_kind_and_position', ['projectId', 'kind', 'itemKind', 'position'])
    .index('by_project_and_kind_and_initiative_and_position', [
      'projectId',
      'kind',
      'itemKind',
      'initiativeId',
      'position',
    ])
    .index('by_attempt_at', ['attemptAt']),
  projectWorkHeads: defineTable({
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    revision: v.number(),
    metadata: v.optional(v.string()),
  }).index('by_project', ['projectId']),
  projectWorkEvents: defineTable(hostedWorkEventFields)
    .index('by_project_and_revision', ['projectId', 'revision'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
  projectRecoveryConnections: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    request: v.string(),
    receipt: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  hostedProjects: defineTable(projectFields)
    // index-order: caller: convex/projectBackups.ts#list; order: active and removed project lists expose newest-first creation-time pages.
    .index('by_owner_and_removal', ['owner', 'removal'])
    .index('by_owner_and_key', ['owner', 'key']),
  ...publicationTables,
  projectBackups: defineTable(projectBackupFields)
    .index('by_archive_storage', ['archiveReceipt.storageId'])
    // index-order: caller: convex/projectBackups.ts#history; order: backup history exposes newest-first creation-time pages.
    .index('by_project', ['projectId'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_storage', ['storageId'])
    .index('by_r2Key', ['r2Key'])
    .index('by_archive_r2Key', ['archiveReceipt.r2Key']),
  projectInterests: defineTable(interestFields)
    .index('by_importId', ['importId'])
    .index('by_owner_and_importId', ['owner', 'importId'])
    .index('by_owner_and_active', ['owner', 'active']),
  interestChanges: defineTable(interestReceipt).index('by_importId', ['importId']),
  sourceZones: defineTable(zoneFields)
    .index('by_owner_and_importId', ['owner', 'importId'])
    .index('by_importId', ['importId']),
  zoneReaders: defineTable({ zoneId: v.id('sourceZones'), reader: v.string() })
    .index('by_zoneId_and_reader', ['zoneId', 'reader'])
    .index('by_reader_and_zoneId', ['reader', 'zoneId']),
  zoneChanges: defineTable(zoneChange).index('by_zoneId_and_operationId', ['zoneId', 'operationId']),
  agentGrants: defineTable(agentFields)
    .index('by_owner_and_operationId', ['owner', 'operationId'])
    // index-order: caller: convex/agentGrants.ts#listRows; order: grant list exposes newest-first creation-time pages.
    .index('by_owner', ['owner'])
    .index('by_tokenHash', ['tokenHash'])
    .index('by_importId', ['importId']),
  agentEvents: defineTable({
    agentId: v.id('agentGrants'),
    actor: v.string(),
    at: v.number(),
    kind: v.union(
      v.literal('create'),
      v.literal('revoke'),
      v.literal('expire'),
      v.literal('cascade-revoke'),
      v.literal('describe'),
      v.literal('read'),
    ),
    tool: v.optional(agentTool),
  }).index('by_agentId', ['agentId']),
  // Retired Secret Objects (Item 41a0df87, slice 6): nothing reads or writes these tables, so they keep no index. The
  // one-off purge (convex/secretObjectsRetire.ts) deletes their rows; the next landing drops the tables.
  secretDeletions: defineTable({
    secretId: v.id('secretObjects'),
    owner: v.string(),
    creationOperationId: v.string(),
    operationId: v.string(),
    expectedVersion: v.number(),
    expectedPolicyRevision: v.number(),
    expectedArchiveRevision: v.number(),
    at: v.number(),
    status: v.union(v.literal('deleting'), v.literal('deleted')),
    task: v.optional(v.id('_scheduled_functions')),
  }),
  secretObjects: defineTable(secretFields),
  secretVersions: defineTable(secretVersionFields),
  secretGrants: defineTable({
    secretId: v.id('secretObjects'),
    principal: v.string(),
    capabilities: v.array(secretCapability),
    expiresAt: v.optional(v.number()),
    discover: v.boolean(),
    activeUntil: v.number(),
    grantedBy: v.optional(v.string()),
    parentGrantId: v.optional(v.id('secretGrants')),
    revokedAt: v.optional(v.number()),
    grantedAt: v.optional(v.number()),
    epoch: v.optional(v.number()),
  }),
  secretEvents: defineTable(secretEventFields),
  teams: defineTable({
    owner: v.string(),
    name: v.string(),
    invitationEpoch: v.optional(v.number()),
    operationId: v.string(),
    removal: v.optional(v.union(v.literal('deleting'), v.literal('deleted'))),
    removalOperation: v.optional(v.string()),
    task: v.optional(v.id('_scheduled_functions')),
    /** While a deleted team's purge marks the members of a write link for sealed-secret removal: that link and the
     * last member checked (convex/teamLifecycle.ts). */
    marking: v.optional(v.object({ link: v.id('projectTeams'), after: v.string() })),
  })
    .index('by_owner_and_operationId', ['owner', 'operationId'])
    .index('by_owner_and_name', ['owner', 'name']),
  teamMembers: defineTable({
    teamId: v.id('teams'),
    member: v.string(),
    /** The member's handle, kept current by convex/accountTeams.ts (Item a841a76d) so the account's team page reads
     * handles with its rows; null for an account with no handle. Absent only until the one-time backfill. */
    handle: v.optional(v.union(v.string(), v.null())),
    /** Daily work counters of a member who writes through a team grant (no contributor row to carry them). */
    workBudget: v.optional(
      v.object({ day: v.number(), checks: v.number(), composes: v.number(), submissions: v.number() }),
    ),
  })
    .index('by_teamId_and_member', ['teamId', 'member'])
    .index('by_member_and_teamId', ['member', 'teamId']),
  /** A team's role on one project (Item b6588425, docs/access.md#teams): its current members get that role.
   * A separate row, so one team serves many projects and an organization can own teams later. */
  projectTeams: defineTable({
    projectId: v.id('hostedProjects'),
    teamId: v.id('teams'),
    role: v.union(v.literal('read'), v.literal('write')),
  })
    .index('by_projectId_and_teamId', ['projectId', 'teamId'])
    .index('by_teamId_and_projectId', ['teamId', 'projectId']),
  teamImports: defineTable({ teamId: v.id('teams'), importId: v.id('imports') })
    .index('by_teamId_and_importId', ['teamId', 'importId'])
    .index('by_importId_and_teamId', ['importId', 'teamId']),
  importRemovalOperations: defineTable({
    owner: v.string(),
    operationId: v.string(),
    target: v.string(),
  }).index('by_owner_and_operationId', ['owner', 'operationId']),
  ...selfMetricBillTables,
  savedViews: defineTable({ owner: v.string(), ...savedLink })
    .index('by_importId', ['importId'])
    // index-order: caller: convex/savedViews.ts#listRows; order: saved view list exposes newest-first creation-time pages.
    .index('by_owner', ['owner'])
    .index('by_owner_and_operationId', ['owner', 'operationId']),
  ...hostedFrictionTables,
  ...selfMetricReceiptTables,
  ...hostedOverlapTables,
  ...boardTables,
  ...laneSnapshotTables,
  ...abuseLimitTables,
  ...abuseReportTables,
  ...hostedDecisionTables,
  ...hostedTrustTables,
  imports: defineTable(jobFields)
    .index('by_scope_and_repository_and_ref', ['scope', 'repository', 'ref'])
    .index('by_repository', ['repository'])
    .index('by_owner_and_visibility', ['owner', 'visibility'])
    .index('by_artifactKey', ['artifactKey']),
  importArtifacts: defineTable({ importId: v.id('imports'), artifactKey: v.string() })
    .index('by_importId_and_artifactKey', ['importId', 'artifactKey'])
    .index('by_artifactKey', ['artifactKey']),
  importReaders: defineTable({ importId: v.id('imports'), reader: v.string() })
    .index('by_importId_and_reader', ['importId', 'reader'])
    .index('by_reader_and_importId', ['reader', 'importId']),
  githubDeliveries: defineTable({
    delivery: v.string(),
    event: v.string(),
    repository: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    complete: v.boolean(),
    task: v.optional(v.id('_scheduled_functions')),
  }).index('by_delivery', ['delivery']),
});
