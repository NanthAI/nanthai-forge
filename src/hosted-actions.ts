// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkHash, checkNumber, checkObject, checkPin, type HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

export const hostedActionsRuntime = checkPin(
  'github-actions;node:24.19.0;checkout:v4;setup-node:v4;forge-check:v1',
);
export const actionsAccessMessage = (reason: 'registration' | 'access') =>
  reason === 'registration'
    ? 'Supply the registered GitHub App installation token through the project credential-use reference. Forge did not register an App.'
    : 'Restore this GitHub App installation’s access to the selected repository with Contents and Actions write permissions.';
export const actionsExportSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    bundle: checkObject,
  })
  .strict();
export const hostedActionsRecipeSchema = z
  .object({
    pin: checkHash,
    head: checkHash,
    definition: checkHash,
    selection: z
      .object({
        scope: z.enum(['full', 'scoped', 'docs', 'interaction']),
        reason: z.string(),
        tests: z.array(z.string()),
      })
      .passthrough(),
    groups: z.array(z.array(z.string())),
    standard: z.boolean(),
    interaction: z.boolean(),
    command: z.array(z.string()).min(1),
  })
  .strict();
export const hostedActionsMappingSchema = z
  .object({
    schema: z.literal(1),
    runId: z.uuid(),
    dispatchKey: checkHash,
    head: checkHash,
    configuration: checkHash,
    planDigest: checkHash,
    repository: z.string(),
    branch: z.string(),
    export: actionsExportSchema.nullable(),
    published: z.boolean(),
    dispatching: z.boolean(),
    outcome: z.enum(['accepted', 'rejected', 'ambiguous']).nullable(),
    httpStatus: checkNumber.nullable(),
    rejections: checkNumber,
    emptyLookups: checkNumber,
    recoveryUsed: z.boolean(),
    run: checkNumber.nullable(),
    deleted: z.boolean(),
    nextAt: checkNumber,
    error: z.enum(['registration', 'access']).nullable(),
    lookupReceipt: z.object({ token: checkNumber, digest: checkHash }).strict().nullable(),
    dispatchReceipt: z.object({ token: checkNumber, digest: checkHash }).strict().nullable(),
    reservationToken: checkNumber.nullable(),
    lease: z.object({ owner: z.uuid(), token: checkNumber, until: checkNumber }).strict(),
  })
  .strict();
export type HostedActionsMapping = z.infer<typeof hostedActionsMappingSchema>;
export type ActionsExport = z.infer<typeof actionsExportSchema>;
export type HostedActionsRecipe = z.infer<typeof hostedActionsRecipeSchema>;
export const hostedActionsTransferSchema = z
  .object({
    kind: z.literal('forge-hosted-actions'),
    runId: z.uuid(),
    dispatchKey: checkHash,
    owner: z.uuid(),
    token: checkNumber,
  })
  .strict();
export type HostedActionsTransfer = z.infer<typeof hostedActionsTransferSchema>;
export const hostedActionsCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), owner: z.uuid() }).strict(),
  z
    .object({ kind: z.literal('export'), owner: z.uuid(), token: checkNumber, export: actionsExportSchema })
    .strict(),
  z.object({ kind: z.literal('published'), owner: z.uuid(), token: checkNumber }).strict(),
  z
    .object({ kind: z.literal('reserve'), owner: z.uuid(), token: checkNumber, recovery: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal('dispatch'),
      owner: z.uuid(),
      token: checkNumber,
      outcome: z.enum(['accepted', 'rejected', 'ambiguous']),
      httpStatus: checkNumber.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lookup'),
      owner: z.uuid(),
      token: checkNumber,
      run: checkNumber.nullable(),
      empty: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      owner: z.uuid(),
      token: checkNumber,
      error: z.enum(['registration', 'access']),
    })
    .strict(),
  z.object({ kind: z.literal('deleted'), owner: z.uuid(), token: checkNumber }).strict(),
  z.object({ kind: z.literal('release'), owner: z.uuid(), token: checkNumber }).strict(),
  z.object({ kind: z.literal('heartbeat'), owner: z.uuid(), token: checkNumber }).strict(),
  z.object({ kind: z.literal('cleanup'), owner: z.uuid(), token: checkNumber }).strict(),
]);
export function actionsMappingMatches(mapping: HostedActionsMapping, run: HostedCheckRun) {
  invariant(
    run.configuration.provider === 'github-actions' &&
      run.plan &&
      run.planDigest &&
      mapping.runId === run.id &&
      mapping.dispatchKey === run.dispatchKey &&
      mapping.head === run.request.expectedHead &&
      mapping.configuration === run.request.expectedConfiguration &&
      mapping.planDigest === run.planDigest &&
      mapping.repository === run.configuration.repository &&
      mapping.branch === `forge-check/${run.id}`,
    'EVIDENCE_CHANGED',
    'The retained Actions export differs from the original run pins.',
  );
}
