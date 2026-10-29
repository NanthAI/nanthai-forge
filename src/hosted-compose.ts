import { batchComposeSchema, batchDroppedSchema } from './hosted-landing-batch.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  saveObjectSchema as object,
  saveWorkerObjectSchema,
  saveExpectedSchema,
  saveBytes,
  savePin,
} from './hosted-save.js';
import { stateSchema } from './native-state-format.js';
import { invariant } from './errors.js';
export const COMPOSE_ALGORITHM = 'forge-native-compose-v1';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const main = z.object({ head: object.shape.sha256, receiptId: z.string().min(1) }).strict();
export const composeLaneSchema = saveExpectedSchema
  .extend({ laneId: z.uuid(), state: saveWorkerObjectSchema })
  .strict();
export const composeDependencySchema = z
  .object({ candidateId: z.uuid(), head: object.shape.sha256, state: saveWorkerObjectSchema })
  .strict();
export const composeEntrySchema = z.union([composeLaneSchema, composeDependencySchema]);
export const composePageSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-compose-page'),
    entries: z.array(composeEntrySchema).max(100),
    next: object.nullable(),
  })
  .strict();
export const composeManifestSchema = z.object({ root: object, pages: count.min(1), count }).strict();
export const composeRequestSchema = z
  .object({
    operationId: z.uuid(),
    intentId: z.uuid(),
    authorityEpoch: count,
    expectedMain: main,
    inputs: composeManifestSchema,
    dependencies: composeManifestSchema,
    message: z.string(),
  })
  .strict()
  .refine(value => value.inputs.count + value.dependencies.count > 0, 'Select a Lane or dependency.');
export const composeInputSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-compose-input'),
    batch: batchComposeSchema.optional(),
    base: main,
    main: saveWorkerObjectSchema,
    inputs: composeManifestSchema,
    dependencies: composeManifestSchema,
    algorithm: z.literal(COMPOSE_ALGORITHM),
    message: z.string(),
    at: z.iso.datetime(),
  })
  .strict();
export const composeResultSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-compose-result'),
    dropped: batchDroppedSchema.optional(),
    input: object,
    algorithm: z.literal(COMPOSE_ALGORITHM),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('clean'), state: object, paths: z.array(z.string()).optional() }).strict(),
      z.object({ status: z.literal('conflict'), conflicts: object }).strict(),
    ]),
  })
  .strict();
const file = stateSchema.shape.files.element;
export const composeConflictPageSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-compose-conflicts'),
    left: object.shape.sha256,
    right: object.shape.sha256,
    // Exact side States and their verified parents retain recursive-base alternatives.
    paths: z
      .array(
        z
          .object({
            path: z.string(),
            base: file.nullable(),
            left: file.nullable(),
            right: file.nullable(),
            reason: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    next: object.nullable(),
  })
  .strict();
export type ComposeRequest = z.infer<typeof composeRequestSchema>;
export type ComposeEntry = z.infer<typeof composeEntrySchema>;
export function validateComposePage(value: unknown) {
  const page = composePageSchema.parse(value);
  invariant(
    saveBytes(page).length <= 128 * 1024 && (page.entries.length > 0 || page.next === null),
    'BAD_ARGUMENT',
    'Continue compose metadata in smaller pages.',
  );
  return page;
}
/** Preserve declared order while automatically splitting transport windows. */
export function buildComposePages(entries: ComposeEntry[]) {
  const groups: ComposeEntry[][] = [];
  let group: ComposeEntry[] = [];
  const placeholder = { sha256: '0'.repeat(64), size: Number.MAX_SAFE_INTEGER };
  for (const entry of entries.map(value => composeEntrySchema.parse(value))) {
    if (
      group.length &&
      (group.length === 100 ||
        saveBytes({
          schema: 1,
          kind: 'forge-hosted-compose-page',
          entries: [...group, entry],
          next: placeholder,
        }).length >
          128 * 1024)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(entry);
  }
  groups.push(group);
  let next: z.infer<typeof object> | null = null;
  const pages = [];
  for (const entries of groups.reverse()) {
    const value = validateComposePage({ schema: 1, kind: 'forge-hosted-compose-page', entries, next });
    next = savePin(value);
    pages.unshift({ pin: next, value });
  }
  return { manifest: { root: next!, pages: pages.length, count: entries.length }, pages };
}
