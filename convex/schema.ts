// SPDX-License-Identifier: Apache-2.0
import { backfillFields } from './r2BackfillFields';
import { ownerAcceptanceTables } from './ownerAcceptanceFields';
import { sourceAuthority } from './projectSourceAuthorityFields';
import { actorTables } from './projectActorFields';
import { autonomyPolicy, autonomyTables, automaticAction } from './autonomyFields';
import { briefTables } from './agentBriefFields';
import { deviceTables } from './deviceFields';
import { clientErrorTables } from './clientErrorFields';
import { indexTables } from './projectWorkIndexFields';
import { hostedRecordTables } from './projectHostedRecordFields';
import { hostedComposeTables } from './projectHostedComposeFields';
import { hostedSaveTables } from './projectHostedSaveFields';
import { hostedSnapshotTables } from './projectHostedSnapshotFields';
import { checkTables } from './projectCheckFields';
import { coordinationTables } from './coordinationFields';
import { githubImportTables } from './projectGithubImportFields';
import { publicationTables } from './projectPublicationFields';
import { objectTables } from './projectObjectFields';
import { artifactBlobTables } from './artifactBlobFields';
import { derivedFields } from './derivedArtifactFields';
import { defineSchema, defineTable } from 'convex/server';
import { accountFields, accountItemFields } from './accountTypes';
import { v } from 'convex/values';
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
  sealed: sealedSecret,
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
};
export const hostedWorkEventDocument = v.object({
  _id: v.id('projectWorkEvents'),
  _creationTime: v.number(),
  ...hostedWorkEventFields,
});
export const projectRemoval = v.union(v.literal('trash'), v.literal('deleting'), v.literal('deleted'));
const projectFields = {
  sourceAuthority: v.optional(sourceAuthority),
  visibility: v.optional(v.union(v.literal('private'), v.literal('public'))),
  hostingRequest: v.optional(v.string()),
  autonomyPolicy: v.optional(autonomyPolicy),
  agentGuidance: v.optional(v.string()),
  exchangeCleanupCursor: v.optional(v.string()),
  exchangeCleanupDone: v.optional(v.boolean()),
  /** Owner opt-in for new objects in R2 (also needs FORGE_BLOBS=r2). Default off. */
  r2Writes: v.optional(v.boolean()),
  r2BackfillRevision: v.optional(v.number()),
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
    v.object({ operationId: v.string(), action: v.string(), expectedRevision: v.number() }),
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
  archiveReceipt: v.optional(
    v.object({
      digest: v.string(),
      size: v.number(),
      storageId: v.id('_storage'),
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
  // Explicit current Channel pins; recovery/display snapshots never select these.
  projectHostedChannels: defineTable({
    operationId: v.string(),
    projectId: v.id('hostedProjects'),
    name: v.string(),
    selection: v.string(),
  }).index('by_project_and_name', ['projectId', 'name']),
  projectReturnSupersessions: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    pushOperationId: v.string(),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    replacementId: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  forgeAccounts: defineTable({ owner: v.string(), handle: v.string() })
    .index('by_owner', ['owner'])
    .index('by_handle', ['handle']),
  accountHandles: defineTable({ owner: v.string(), handle: v.string() }).index('by_handle', ['handle']),
  handleOperations: defineTable({ owner: v.string(), operationId: v.string(), handle: v.string() }).index(
    'by_owner_and_operation',
    ['owner', 'operationId'],
  ),
  projectSlugs: defineTable({ owner: v.string(), slug: v.string(), projectId: v.id('hostedProjects') }).index(
    'by_owner_and_slug',
    ['owner', 'slug'],
  ),
  ...ownerAcceptanceTables,
  ...autonomyTables,
  ...briefTables,
  ...actorTables,
  ...deviceTables,
  ...clientErrorTables,
  ...checkTables,
  ...coordinationTables,
  ...indexTables,
  ...hostedRecordTables,
  ...hostedSaveTables,
  ...hostedComposeTables,
  ...hostedSnapshotTables,
  ...objectTables,
  ...artifactBlobTables,
  ...githubImportTables,
  derivedArtifacts: defineTable(derivedFields)
    .index('by_original_and_kind_and_pin', ['original', 'kind', 'pin'])
    .index('by_original_and_removed', ['original', 'removed']),
  accountOperations: defineTable(accountFields)
    .index('by_owner_and_operation', ['owner', 'operationId'])
    .index('by_owner', ['owner']),
  accountItems: defineTable(accountItemFields)
    .index('by_account_and_key', ['accountId', 'key'])
    .index('by_account_and_hidden_and_key', ['accountId', 'hidden', 'key'])
    .index('by_resource_and_kind', ['resourceId', 'kind'])
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
    task: v.optional(v.id('_scheduled_functions')),
  })
    .index('by_upload', ['uploadId'])
    .index('by_project', ['projectId'])
    .index('by_project_and_upload', ['projectId', 'uploadId'])
    .index('by_project_and_pending', ['projectId', 'pending']),
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
    operationId: v.string(),
    person: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  projectInvites: defineTable({ projectId: v.id('hostedProjects'), email: v.string() })
    .index('by_project_and_email', ['projectId', 'email'])
    .index('by_email', ['email']),
  projectContributors: defineTable(projectContributorFields)
    .index('by_project_and_contributor', ['projectId', 'contributor'])
    .index('by_contributor', ['contributor']),
  projectProposals: defineTable(projectProposalFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_storage', ['storageId']),
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
    .index('by_owner', ['owner'])
    .index('by_owner_and_key', ['owner', 'key'])
    .index('by_owner_and_slug', ['owner', 'slug']),
  ...publicationTables,
  projectBackups: defineTable(projectBackupFields)
    .index('by_archive_storage', ['archiveReceipt.storageId'])
    .index('by_project', ['projectId'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_storage', ['storageId']),
  projectInterests: defineTable(interestFields)
    .index('by_importId', ['importId'])
    .index('by_owner_and_importId', ['owner', 'importId'])
    .index('by_owner_and_active', ['owner', 'active']),
  interestChanges: defineTable(interestReceipt)
    .index('by_owner_and_operationId', ['owner', 'operationId'])
    .index('by_importId', ['importId']),
  sourceZones: defineTable(zoneFields)
    .index('by_owner_and_operationId', ['owner', 'operationId'])
    .index('by_owner_and_importId', ['owner', 'importId'])
    .index('by_importId', ['importId']),
  zoneReaders: defineTable({ zoneId: v.id('sourceZones'), reader: v.string() })
    .index('by_zoneId_and_reader', ['zoneId', 'reader'])
    .index('by_reader_and_zoneId', ['reader', 'zoneId']),
  zoneChanges: defineTable(zoneChange)
    .index('by_zoneId_and_operationId', ['zoneId', 'operationId'])
    .index('by_zoneId', ['zoneId']),
  agentGrants: defineTable(agentFields)
    .index('by_owner_and_operationId', ['owner', 'operationId'])
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
  })
    .index('by_secretId', ['secretId'])
    .index('by_owner', ['owner'])
    .index('by_owner_and_creationOperationId', ['owner', 'creationOperationId']),
  secretObjects: defineTable(secretFields).index('by_owner_and_operationId', ['owner', 'operationId']),
  secretVersions: defineTable(secretVersionFields)
    .index('by_secretId_and_version', ['secretId', 'version'])
    .index('by_secretId_and_operationId', ['secretId', 'operationId']),
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
  })
    .index('by_secretId_and_principal', ['secretId', 'principal'])
    .index('by_principal_and_discover_and_secretId', ['principal', 'discover', 'secretId']),
  secretEvents: defineTable(secretEventFields)
    .index('by_secretId_and_principal_and_policyRevision', ['secretId', 'principal', 'policyRevision'])
    .index('by_secretId', ['secretId'])
    .index('by_secretId_and_actor_and_operationId', ['secretId', 'actor', 'operationId']),
  teams: defineTable({
    owner: v.string(),
    name: v.string(),
    operationId: v.string(),
    removal: v.optional(v.union(v.literal('deleting'), v.literal('deleted'))),
    removalOperation: v.optional(v.string()),
    task: v.optional(v.id('_scheduled_functions')),
  }).index('by_owner_and_operationId', ['owner', 'operationId']),
  teamMembers: defineTable({ teamId: v.id('teams'), member: v.string() })
    .index('by_teamId_and_member', ['teamId', 'member'])
    .index('by_member_and_teamId', ['member', 'teamId']),
  teamImports: defineTable({ teamId: v.id('teams'), importId: v.id('imports') })
    .index('by_teamId_and_importId', ['teamId', 'importId'])
    .index('by_importId_and_teamId', ['importId', 'teamId']),
  importRemovalOperations: defineTable({
    owner: v.string(),
    operationId: v.string(),
    target: v.string(),
  }).index('by_owner_and_operationId', ['owner', 'operationId']),
  savedViews: defineTable({ owner: v.string(), ...savedLink })
    .index('by_importId', ['importId'])
    .index('by_owner', ['owner'])
    .index('by_owner_and_operationId', ['owner', 'operationId']),
  imports: defineTable(jobFields)
    .index('by_scope_and_repository_and_ref', ['scope', 'repository', 'ref'])
    .index('by_repository', ['repository'])
    .index('by_owner_and_visibility', ['owner', 'visibility'])
    .index('by_visibility', ['visibility'])
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
