// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { stateSchema } from './native-state-format.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { safeRelative } from './safe-relative.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';

const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const saveObjectSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: number })
  .strict();
export const saveWorkerObjectSchema = z
  .object({ object: saveObjectSchema, recipe: saveObjectSchema.nullable() })
  .strict();
const file = stateSchema.shape.files.element.omit({ path: true });
export const saveChangeSchema = z
  .object({
    path: z
      .string()
      .refine(safeRelative)
      .refine(
        path =>
          !path
            .toLowerCase()
            .split('/')
            .some(p => p === '.forge' || p === '.git'),
      ),
    before: file.nullable(),
    after: file.extend({ content: saveWorkerObjectSchema }).strict().nullable(),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (
      (!change.before && !change.after) ||
      (change.after && change.after.blob !== change.after.content.object.sha256)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A delta must bind an exact source object or explicit deletion.',
      });
  });
export type SaveChange = z.infer<typeof saveChangeSchema>;
export const savePageSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-save-page'),
    changes: z.array(saveChangeSchema).min(1).max(100),
    next: saveObjectSchema.nullable(),
  })
  .strict();
export const saveExpectedSchema = hostedLaneSelectionSchema.pick({
  head: true,
  version: true,
  sourceVersion: true,
  lifecycleVersion: true,
});
export const saveRequestSchema = z
  .object({
    operationId: z.uuid(),
    laneId: z.uuid(),
    authorityEpoch: number,
    expected: saveExpectedSchema,
    message: z.string(),
    pages: saveObjectSchema.nullable(),
    pageCount: number,
    changeCount: number,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.pages === null
        ? value.pageCount !== 0 || value.changeCount !== 0
        : value.pageCount === 0 || value.changeCount === 0) ||
      value.pageCount > value.changeCount
    )
      ctx.addIssue({ code: 'custom', message: 'Delta page and change counts differ.' });
  });
export type SaveRequest = z.infer<typeof saveRequestSchema>;
export const saveInputSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-save-input'),
    baseline: saveWorkerObjectSchema,
    pages: saveObjectSchema,
    pageCount: number,
    changeCount: number,
    message: z.string(),
    at: z.iso.datetime(),
  })
  .strict();
export const saveResultSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    laneId: z.uuid(),
    saveId: z.uuid(),
    head: saveObjectSchema.shape.sha256,
    version: number,
    sourceVersion: number,
    unchanged: z.boolean(),
    at: z.iso.datetime(),
  })
  .strict();
export type SaveResult = z.infer<typeof saveResultSchema>;
export function saveBytes(value: unknown) {
  return new TextEncoder().encode(canonicalPayload(value));
}
export function savePin(value: unknown) {
  const bytes = saveBytes(value);
  return { sha256: digest(bytes), size: bytes.length };
}
export function validateSavePage(value: unknown, previous: string | null) {
  const page = savePageSchema.parse(value);
  invariant(saveBytes(page).length <= 128 * 1024, 'BAD_ARGUMENT', 'Continue save metadata in smaller pages.');
  for (const change of page.changes) {
    invariant(
      previous === null || change.path > previous,
      'WORK_OPERATION_CHANGED',
      'Save paths must be unique and ordered across pages.',
    );
    previous = change.path;
  }
  return { page, lastPath: previous! };
}
/** Automatically split metadata; these are transfer windows, never a source-size limit. */
export function buildSavePages(changes: SaveChange[]) {
  changes = changes
    .map(change => saveChangeSchema.parse(change))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const groups: SaveChange[][] = [];
  let group: SaveChange[] = [];
  const placeholder = { sha256: '0'.repeat(64), size: Number.MAX_SAFE_INTEGER };
  for (const change of changes) {
    if (
      group.length &&
      (group.length === 100 ||
        saveBytes({
          schema: 1,
          kind: 'forge-hosted-save-page',
          changes: [...group, change],
          next: placeholder,
        }).length >
          128 * 1024)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(change);
  }
  if (group.length) groups.push(group);
  let next: z.infer<typeof saveObjectSchema> | null = null;
  const pages: { pin: z.infer<typeof saveObjectSchema>; value: z.infer<typeof savePageSchema> }[] = [];
  for (const entries of groups.reverse()) {
    const value = { schema: 1 as const, kind: 'forge-hosted-save-page' as const, changes: entries, next };
    validateSavePage(value, null);
    next = savePin(value);
    pages.unshift({ pin: next, value });
  }
  return { pages, root: next };
}
