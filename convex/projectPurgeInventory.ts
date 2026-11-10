// SPDX-License-Identifier: Apache-2.0
import schema from './schema';

/** Every table that owns rows through `projectId`, with the index whose first field
 * is `projectId`. The purge walks this list in order; tests/project-purge-inventory
 * fails the build when a schema table with a hosted-project id is missing here. */
export const projectPurgeTables = {
  projectFinishReadRows: 'by_project',
  projectGithubMirrors: 'by_project',
  projectGithubMirrorJobs: 'by_project_and_state',
  projectGithubBindings: 'by_project_and_name',
  githubBindingOperations: 'by_project_and_operation',
  githubBindingRemovals: 'by_project_and_operation',
  projectSourceSteps: 'by_project_and_job',
  projectSourceBatches: 'by_project_and_job_and_step',
  projectSourceTasks: 'by_project',
  projectWorkDetailMigrations: 'by_project',
  projectCheckLogCleanupPages: 'by_project_and_operation_and_part_and_position',
  projectCheckLogRetentions: 'by_project_and_key',
  projectCheckLogSourcePins: 'by_project',
  projectCheckLogCleanups: 'by_project_and_operation',
  projectHostedSeeds: 'by_project',
  projectHostedSeedPages: 'by_project',
  projectHostedChannels: 'by_project_and_name',
  projectReleaseSignatures: 'by_project_and_head',
  projectReturnSupersessions: 'by_project_and_operation',
  projectSlugs: 'by_project',
  projectSourceCutovers: 'by_project_and_operation',
  projectSourceAuthorityTransitions: 'by_project_and_operation',
  projectPolicyChanges: 'by_project_and_operation',
  agentGuidanceMaintainerOperations: 'by_project',
  /** Personal operations may carry an incidental projectId; only project scope is project-owned. */
  agentGuidanceOperations: { index: 'by_project_and_scope', scope: 'project' },
  projectBriefingSources: 'by_projectId_and_backupId_and_head_and_part',
  projectActorNames: 'by_project',
  clientErrors: 'by_projectId',
  projectCheckRunners: 'by_project',
  projectCheckRequests: 'by_project',
  projectCoordinationSessions: 'by_project',
  projectCoordinationEvents: 'by_project',
  projectCoordinationReceipts: 'by_project',
  projectCoordinationClaims: 'by_project_and_claim',
  projectReturnPages: 'by_project',
  projectWorkGenerations: 'by_project',
  projectWorkRecords: 'by_project',
  projectHostedRecordBodies: 'by_project',
  projectHostedRecords: 'by_project',
  projectHostedRecordHeads: 'by_project',
  projectHostedOperations: 'by_project_and_metric_action',
  projectHostedSaves: 'by_project_and_job',
  projectHostedSavePages: 'by_project_and_actor_and_operation_and_index',
  projectHostedStates: 'by_project',
  projectHostedComposes: 'by_project_and_job',
  projectHostedComposePages: 'by_project_and_actor_and_operation_and_kind_and_index',
  projectHostedComposeSelections: 'by_project_and_kind_and_key',
  projectHostedSyncs: 'by_project_and_job',
  projectHostedTestTimings: 'by_project',
  projectHostedActionsResults: 'by_project_and_run_and_index',
  projectHostedCheckWorkers: 'by_project_and_machine',
  projectHostedCheckSettings: 'by_project_and_kind',
  projectHostedCheckSettingVersions: 'by_project_and_kind_and_key_and_version',
  projectHostedCheckRuns: 'by_project',
  projectHostedCheckCallbacks: 'by_project_and_run',
  projectHostedCheckShards: 'by_project_and_run',
  projectHostedMainAudits: 'by_project',
  projectHostedMainAuditEvents: 'by_project_and_sequence',
  projectHostedOutputSummaries: 'by_project_and_run_and_stream_and_position',
  projectHostedOutputHeads: 'by_project_and_run',
  projectHostedOutputStreams: 'by_project_and_run',
  projectHostedOutputChunks: 'by_project_and_run',
  projectSourcePacks: 'by_project',
  projectHostedActionsExports: 'by_project_and_run',
  projectHostedLandingQueueStatus: 'by_project_and_page',
  projectHostedStallAlerts: 'by_project_and_submission',
  projectHostedLandingBatches: 'by_project_and_batch',
  projectHostedLandingDesired: 'by_project_and_submission',
  projectHostedLandingAliases: 'by_project_and_actor_and_operation',
  projectHostedLandingObservations: 'by_project_and_submission_and_version',
  projectHostedLandingCheckWakes: 'by_project_and_run',
  projectHostedLandingQueues: 'by_project_and_channel',
  projectHostedLandingRequests: 'by_project',
  projectHostedLandingAttempts: 'by_project',
  projectHostedFinishes: 'by_project_and_submission',
  projectHostedApprovals: 'by_project_and_lane',
  projectHostedAcceptances: 'by_project',
  projectHostedAcceptanceSnapshots: 'by_project_and_snapshot',
  projectHostedAcceptanceEvents: 'by_project_and_sequence',
  projectHostedAcceptancePlans: 'by_project_and_receipt',
  projectHostedAcceptancePages: 'by_project_and_receipt_and_kind_and_index',
  projectHostedLifecyclePlans: 'by_project_and_actor_and_operation',
  projectHostedLifecycleGuards: 'by_project_and_intent',
  projectHostedLifecyclePointers: 'by_project_and_lane',
  projectHostedLifecycleEvents: 'by_project_and_kind_and_key',
  projectHostedSnapshots: 'by_project_and_snapshot',
  projectHostedSnapshotPages: 'by_project',
  projectHostedSnapshotHeads: 'by_project',
  projectHostedDisplayRecords: 'by_project',
  projectObjects: 'by_project',
  projectObjectCatalog: 'by_project',
  projectGithubImportInventory: 'by_project',
  projectGithubImports: 'by_project',
  projectHistory: 'by_project',
  projectHistoryPacks: 'by_project',
  projectGitLaneCommits: 'by_project',
  projectGitMainCommits: 'by_project_and_state',
  projectUploadCleanup: 'by_project',
  projectReaders: 'by_project_and_reader',
  projectReaderOperations: 'by_project_and_operation',
  projectAccessOperations: 'by_project_and_operation',
  projectInvites: 'by_project_and_email',
  projectContributors: 'by_project_and_contributor',
  projectProposals: 'by_project',
  projectWorkHeads: 'by_project',
  projectWorkEvents: 'by_project_and_revision',
  projectRecoveryConnections: 'by_project_and_operation',
  projectPublicationAttempts: 'by_project',
  projectPublications: 'by_project',
  projectPublicationPages: 'by_project',
  projectBackups: 'by_project',
  projectSelfMetricBills: 'by_project_and_operation',
  projectHostedFriction: 'by_project_and_id',
  projectHostedFrictionHints: 'by_project',
  projectHostedOverlapAcks: 'by_project_and_id',
  projectHostedAckBatches: 'by_project_and_id',
  projectSelfMetricReceipts: 'by_project_and_key',
  projectHostedOverlapLanes: 'by_project_and_lane',
  projectHostedPresence: 'by_project_and_lane',
  projectHostedStackDependents: 'by_project_and_lane',
  projectHostedOverlapDeliveries: 'by_project_and_id',
  projectHostedConflictNotices: 'by_project_and_lane_and_open',
  projectHostedOverlapMain: 'by_project',
  projectBoardMessages: 'by_project_and_id',
  projectBoardInboxes: 'by_project_and_key',
  projectBoardSenders: 'by_project_and_key',
  projectReadBudgets: 'by_project_and_shard',
  projectStorageUsage: 'by_project_and_shard',
  projectBoardProjects: 'by_project',
  projectBoardClaims: 'by_project_and_lane_and_path',
  boardEvidence: 'by_project_and_at',
  projectHostedDecisions: 'by_project',
  projectHostedDecisionMaintainers: 'by_project_and_actor',
  projectHostedTrust: 'by_project_and_actor',
  projectLandingSpeed: 'by_project',
  projectLaneSnapshots: 'by_project_and_lane_and_seq',
} as const satisfies Record<string, string | { index: string; scope: string }>;
export type ProjectPurgeTable = keyof typeof projectPurgeTables;
export const projectPurgeOrder = Object.keys(projectPurgeTables) as ProjectPurgeTable[];
/** Index and optional second equality for one covered table. */
export function purgeIndex(table: ProjectPurgeTable): { index: string; scope?: string } {
  const entry: string | { index: string; scope: string } = projectPurgeTables[table];
  return typeof entry === 'string' ? { index: entry } : entry;
}

/** Project rows that are not keyed by `projectId`; each has its own bounded purge step. */
export const projectPurgeSpecial = {
  /** Root row: purge leaves a nameless owner/key tombstone so a replayed initial upload cannot recreate it. */
  hostedProjects: 'tombstone',
  /** Archive blob rows live under the `v1/p/<projectId>/` namespace prefix. */
  artifactBlobs: 'namespace',
} as const;

type Shape = {
  kind: string;
  tableName?: string;
  fields?: Record<string, Shape>;
  members?: Shape[];
  element?: Shape;
  value?: Shape;
};
/** Paths of typed ids to `target` inside a table document (`a.b`, `list[]`). */
export function idPaths(table: string, target: string) {
  const paths: string[] = [];
  const walk = (value: Shape, path: string) => {
    if (value.kind === 'id' && value.tableName === target) paths.push(path);
    for (const [key, child] of Object.entries(value.fields ?? {})) walk(child, path ? `${path}.${key}` : key);
    for (const child of value.members ?? []) walk(child, path);
    if (value.element) walk(value.element, `${path}[]`);
    if (value.value) walk(value.value, `${path}{}`);
  };
  const tables = schema.tables as unknown as Record<string, { validator: Shape }>;
  walk(tables[table]!.validator, '');
  return [...new Set(paths)];
}
/** Values found at an `idPaths` path; arrays and records are flattened. */
export function valuesAt(row: unknown, path: string): string[] {
  let values: unknown[] = [row];
  for (const part of path.split('.')) {
    const name = part.replace(/(\[\]|\{\})+$/, ''),
      suffix = part.slice(name.length);
    values = values.map(value => (value as Record<string, unknown> | null)?.[name]);
    for (const step of suffix.match(/\[\]|\{\}/g) ?? [])
      values = values.flatMap(value =>
        step === '[]'
          ? Array.isArray(value)
            ? value
            : []
          : value && typeof value === 'object'
            ? Object.values(value)
            : [],
      );
  }
  return values.filter((value): value is string => typeof value === 'string');
}
const cache = new Map<string, { files: string[]; tasks: string[] }>();
/** Convex files and scheduled functions a project row references; derived from the schema. */
export function rowReferences(table: ProjectPurgeTable) {
  let found = cache.get(table);
  if (!found)
    cache.set(
      table,
      (found = { files: idPaths(table, '_storage'), tasks: idPaths(table, '_scheduled_functions') }),
    );
  return found;
}
