// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedMainV2Schema } from './hosted-main.js';
import { saveObjectSchema } from './hosted-save.js';

// Transport windows only; every table continues through its opaque cursor.
export const RECOVERY_PAGE_ROWS = 64;
export const RECOVERY_PAGE_BYTES = 128 * 1024;
export const recoveryTables = [
  'projectSourceCutovers',
  'projectHostedRecordBodies',
  'projectHostedRecords',
  'projectHostedRecordHeads',
  'projectHostedOperations',
  'projectHostedStates',
  'projectHostedSaves',
  'projectHostedSavePages',
  'projectHostedComposes',
  'projectHostedComposePages',
  'projectHostedComposeSelections',
  'projectHostedSyncs',
  'projectHostedFinishes',
  'projectHostedLandingQueues',
  'projectHostedLandingRequests',
  'projectHostedLandingAttempts',
  'projectHostedLandingObservations',
  'projectHostedAcceptances',
  'projectHostedAcceptanceSnapshots',
  'projectHostedAcceptanceEvents',
  'projectHostedAcceptancePlans',
  'projectHostedAcceptancePages',
  'projectHostedLifecyclePlans',
  'projectHostedLifecycleGuards',
  'projectHostedLifecyclePointers',
  'projectHostedLifecycleEvents',
  'projectHostedCheckRuns',
  'projectHostedCheckCallbacks',
  'projectHostedCheckShards',
  'projectReturnSupersessions',
] as const;
export const recoveryTableSchema = z.enum(recoveryTables);
export type RecoveryTable = z.infer<typeof recoveryTableSchema>;
export const hostedRecoveryPageSchema = z
  .object({
    table: recoveryTableSchema,
    rows: z.array(z.string()).max(RECOVERY_PAGE_ROWS),
    cursor: z.string().nullable(),
    done: z.boolean(),
  })
  .strict();
export type HostedRecoveryPage = z.infer<typeof hostedRecoveryPageSchema>;
export const hostedRecoverySchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string(),
    main: hostedMainV2Schema,
    pages: saveObjectSchema.nullable(),
    objects: saveObjectSchema.nullable(),
    counts: z.record(z.string(), z.number().safe().nonnegative()),
    rows: z.number().safe().nonnegative(),
    bytes: z.number().safe().nonnegative(),
    maxPageBytes: z.number().safe().nonnegative(),
  })
  .strict();
export type HostedRecovery = z.infer<typeof hostedRecoverySchema>;
export const recoveryRowsSchema = z
  .object({
    kind: z.literal('forge-hosted-recovery-page'),
    previous: saveObjectSchema.nullable(),
    table: recoveryTableSchema,
    rows: z.array(z.string()).max(RECOVERY_PAGE_ROWS),
  })
  .strict();
export const recoveryObjectSchema = z
  .object({
    kind: z.literal('forge-hosted-recovery-object'),
    previous: saveObjectSchema.nullable(),
    object: saveObjectSchema,
    nested: z.boolean(),
  })
  .strict();
