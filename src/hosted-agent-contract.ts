// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { revertTargetSchema } from './hosted-sync.js';
import { saveExpectedSchema } from './hosted-save.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
export const hostedAgentActions = [
  'start',
  'open',
  'save',
  'compose',
  'sync',
  'check',
  'finish',
  'cancel',
  'revert',
  'abandon',
  'reopen',
  'status',
  'observe',
  'capabilities',
] as const;
export const hostedAgentAddressSchema = z.object({ url: z.url(), projectId: z.string().min(1) }).strict();
export type HostedAgentAddress = z.infer<typeof hostedAgentAddressSchema>;
export const hostedAgentCapabilitiesSchema = z
  .object({
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
  start: z
    .object({
      outcome: z.string().min(1).optional(),
      constraints: z.string().optional(),
      intentId: uuid.optional(),
    })
    .strict(),
  open: z
    .object({
      laneId: uuid,
      expected: saveExpectedSchema.omit({ lifecycleVersion: true }).optional(),
      paths: z.array(z.string().refine(safeRelative)).optional(),
    })
    .strict(),
  save: z.object({ ...lane, ...message }).strict(),
  compose: z.object(selection).strict(),
  sync: z
    .object({
      ...lane,
      ...message,
      target: z
        .union([
          z.object({ kind: z.literal('main'), head: hash, receiptId: z.string() }).strict(),
          z.object({ kind: z.literal('candidate'), candidateId: uuid, head: hash }).strict(),
        ])
        .optional(),
      apply: z.boolean().default(true),
    })
    .strict(),
  check: check.extend({ candidateId: uuid, expectedHead: hash.optional() }).strict(),
  finish: z
    .object({
      ...selection,
      check: check.optional(),
      candidateId: uuid.optional(),
      composeOperationId: uuid.optional(),
      after: uuid.nullable().default(null),
      accept: z.literal(true).optional(),
    })
    .strict(),
  cancel: z.object({ submissionId: uuid }).strict(),
  revert: z.object({ ...message, target: revertTargetSchema }).strict(),
  abandon: z
    .object({
      ...lane,
      reason: z.string().min(1),
      saveFirst: z.boolean().default(false),
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
  capabilities: z.object({}).strict(),
};
export type HostedAgentAction = keyof typeof hostedAgentCommandSchemas;
export function hostedAgentAction(action: string): HostedAgentAction {
  const value = action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action;
  invariant(
    Object.hasOwn(hostedAgentCommandSchemas, value),
    'HOSTED_ACTION_UNSUPPORTED',
    'This action is not supported by the hosted agent transport. Read capabilities for supported actions.',
  );
  return value as HostedAgentAction;
}
