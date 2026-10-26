// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { HOSTED_RECORD_PAGE_ROWS, HOSTED_RECORD_PAGE_BYTES } from './hosted-records.js';
import { invariant } from './errors.js';
const count = z.number().safe().nonnegative();
export const seedPinSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: count }).strict();
export const seedRequestSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    revision: count,
    sourceHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    format: z.enum(['native', 'git']),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    main: seedPinSchema.nullable(),
    receipt: seedPinSchema.nullable(),
    receiptId: z.string().nullable(),
    previousHead: z.string().nullable(),
    previousReceiptId: z.string().nullable(),
    work: seedPinSchema,
    manifest: seedPinSchema,
    root: seedPinSchema,
    recovery: seedPinSchema,
    pages: count,
    objects: count,
    chain: z.string().regex(/^[a-f0-9]{64}$/),
    preview: z
      .object({ intents: count, lanes: count, views: count, runs: count, files: count, unavailable: count })
      .strict(),
  })
  .strict();
export type SeedRequest = z.infer<typeof seedRequestSchema>;
export const seedEntrySchema = seedPinSchema
  .extend({
    kind: z.enum(['object', 'state', 'metadata']),
    records: z
      .array(z.object({ collection: z.string(), key: z.string(), format: count }).strict())
      .optional(),
  })
  .strict();
export type SeedEntry = z.infer<typeof seedEntrySchema>;
export const seedPageSchema = z.array(seedEntrySchema).min(1).max(HOSTED_RECORD_PAGE_ROWS);
export const SEED_EMPTY = digest('forge-hosted-seed-v1');
export const seedPageChain = (previous: string, index: number, entries: SeedEntry[]) =>
  digest(canonicalPayload({ previous, index, entries }));
export function validateSeedPage(entries: SeedEntry[]) {
  seedPageSchema.parse(entries);
  invariant(
    new TextEncoder().encode(canonicalPayload(entries)).length <= HOSTED_RECORD_PAGE_BYTES,
    'BAD_ARGUMENT',
    'Continue seed metadata in bounded pages.',
  );
  invariant(
    new Set(entries.map(p => p.sha256)).size === entries.length,
    'INVALID_WORK_BACKUP',
    'Seed pages must not repeat an object.',
  );
}
export function buildSeedPages(entries: SeedEntry[]) {
  const pages: SeedEntry[][] = [];
  let current: SeedEntry[] = [];
  for (const entry of entries) {
    if (
      current.length &&
      (current.length === HOSTED_RECORD_PAGE_ROWS ||
        ((entry.kind === 'state' || entry.records) &&
          current.some(p => p.kind === 'state' || p.records) &&
          current.filter(p => p.kind === 'state' || p.records).reduce((n, p) => n + p.size, entry.size) >
            2 * 1024 * 1024) ||
        new TextEncoder().encode(canonicalPayload([...current, entry])).length > HOSTED_RECORD_PAGE_BYTES)
    ) {
      pages.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) pages.push(current);
  let chain = SEED_EMPTY;
  for (const [index, page] of pages.entries()) {
    validateSeedPage(page);
    chain = seedPageChain(chain, index, page);
  }
  return { pages, chain };
}
