// SPDX-License-Identifier: Apache-2.0
import schema from './schema';
import { invariant } from '../src/errors';
/** Owner-approved frozen table counts. Project identity stays in the private manifest. */
export const approvedBenchCounts = {
  projectObjects: 36835,
  projectHostedRecordBodies: 30188,
  projectHostedRecords: 30188,
  projectSourceTasks: 8433,
  projectHostedLandingObservations: 7900,
  projectCheckLogSourcePins: 6727,
  projectHostedOperations: 5625,
  projectHostedRecordHeads: 4485,
  projectSelfMetricReceipts: 2635,
  projectSourceBatches: 2574,
  projectSourceSteps: 1665,
  projectHostedStates: 1144,
  projectHostedLandingAttempts: 1121,
  projectHostedComposePages: 1082,
  projectHostedComposes: 944,
  projectHostedAcceptancePages: 876,
  projectHostedCheckCallbacks: 828,
  projectHostedOverlapLanes: 690,
  projectHostedLifecycleEvents: 658,
  projectHostedLifecyclePlans: 658,
  projectHostedLifecycleGuards: 594,
  projectHostedSaves: 594,
  projectHostedSavePages: 547,
  projectHostedComposeSelections: 541,
  projectHostedLandingDesired: 541,
  projectHostedFinishes: 538,
  projectHostedLandingRequests: 538,
  projectHostedAcceptancePlans: 438,
  projectHostedCheckRuns: 431,
  projectHostedLandingCheckWakes: 431,
  projectHostedAcceptanceEvents: 420,
  projectHostedAcceptanceSnapshots: 420,
  projectHostedAcceptances: 420,
  projectHostedActionsResults: 414,
  projectHostedCheckShards: 414,
  projectHostedOutputChunks: 414,
  projectHostedOutputHeads: 414,
  projectHostedOutputStreams: 414,
  projectHostedSeedPages: 292,
  projectHostedOverlapAcks: 219,
  projectHostedLandingBatches: 207,
  projectHostedSyncs: 176,
  projectHostedOverlapDeliveries: 163,
  projectHostedAckBatches: 139,
  projectHostedStallAlerts: 24,
  hostedProjects: 1,
  projectHostedChannels: 1,
  projectHostedCheckSettingVersions: 1,
  projectHostedCheckSettings: 1,
  projectHostedLandingQueues: 1,
  projectHostedMainAudits: 1,
  projectHostedOverlapMain: 1,
  projectHostedSeeds: 1,
  projectHostedTestTimings: 1,
  projectSlugs: 1,
  projectSourceCutovers: 1,
  projectSourcePacks: 1,
  projectUploadCleanup: 1,
} as const;
export type BenchTable = keyof typeof approvedBenchCounts;
export const benchTables = Object.keys(approvedBenchCounts) as BenchTable[];
/** A row has one owning project field; references to accounts or other row kinds
 * do not make that row shared between hosted projects. Refuse a schema change
 * that adds another typed hosted-project owner before deleting anything. */
export function benchOwnershipSchema(table: BenchTable) {
  const validator = schema.tables[table].validator;
  const owners: string[] = [];
  type Shape = {
    kind: string;
    tableName?: string;
    fields?: Record<string, Shape>;
    members?: Shape[];
    element?: Shape;
    value?: Shape;
    isOptional?: string;
  };
  function walk(value: Shape, path: string) {
    if (value.kind === 'id' && value.tableName === 'hostedProjects') owners.push(path);
    for (const [key, child] of Object.entries(value.fields ?? {})) walk(child, path ? path + '.' + key : key);
    for (const child of value.members ?? []) walk(child, path);
    if (value.element) walk(value.element, path + '[]');
    if (value.value) walk(value.value, path + '{}');
  }
  walk(validator as unknown as Shape, '');
  invariant(validator.kind === 'object', 'LEGACY_BENCH_SCHEMA_CHANGED', 'Recheck row ownership.');
  if (table === 'hostedProjects')
    invariant(owners.length === 0, 'LEGACY_BENCH_SCHEMA_CHANGED', 'Project root ownership changed.');
  else
    invariant(
      owners.length === 1 &&
        owners[0] === 'projectId' &&
        (validator as unknown as Shape).fields?.projectId?.isOptional === 'required',
      'LEGACY_BENCH_SCHEMA_CHANGED',
      'Every approved row must have one required project owner.',
    );
  return table === 'hostedProjects' ? '_id' : 'projectId';
}
