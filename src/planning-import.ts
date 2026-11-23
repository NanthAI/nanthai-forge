// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Data only. Agents translate their source; Forge has no tracker-specific parser.
import { z } from 'zod';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import { planningItemSchema, planningPutAgentFields, planningPutSchema } from './work-planning-types.js';
import { planningImportId } from './work-planning-put.js';

const original = planningItemSchema.shape.imported.unwrap();
export const planningImportRowSchema = z
  .object({
    key: original.shape.key,
    source: original.shape.source,
    createdAt: original.shape.createdAt,
    closedAt: original.shape.closedAt,
    originalHandle: original.shape.originalHandle,
    kind: z.enum(['issue', 'initiative']),
    title: z.string().trim().min(1),
    body: z.string().default(''),
    status: planningItemSchema.shape.status.default('closed'),
    reason: z.string().optional(),
    initiativeKey: z.string().trim().min(1).optional(),
    parentKey: z.string().trim().min(1).optional(),
    fields: planningPutAgentFields.omit({ imported: true }).optional(),
    selected: z.boolean().default(true),
  })
  .strict();
export type PlanningImportRow = z.infer<typeof planningImportRowSchema>;
export const planningImportPageSchema = z
  .object({
    batchId: z.uuid(),
    batchHash: z.string().regex(/^[0-9a-f]{64}$/),
    page: z.number().int().nonnegative(),
    rows: z.array(planningImportRowSchema).max(100),
  })
  .strict();
export type PlanningImportPage = z.infer<typeof planningImportPageSchema>;
export type PlanningImportResult = {
  batchId: string;
  page: number;
  created: string[];
  skipped: string[];
  rows: {
    key: string;
    id: string;
    title: string;
    kind: string;
    status: string;
    source: string;
    createdAt: string | null;
    closedAt: string | null;
    originalHandle: string | null;
    action: 'create' | 'skip' | 'not-selected' | 'attention';
    reason?: string;
  }[];
};

export function importPlanningPut(row: PlanningImportRow, batchId: string) {
  const imported = original.parse({
    key: row.key,
    source: row.source,
    batchId,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.closedAt ? { closedAt: row.closedAt } : {}),
    ...(row.originalHandle ? { originalHandle: row.originalHandle } : {}),
  });
  return planningPutSchema.parse({
    action: 'put-planning-item',
    operationId: planningImportId(JSON.stringify(['write', batchId, row.key])),
    itemId: planningImportId(row.key),
    expectedVersion: 0,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...row.fields,
    ...(row.initiativeKey ? { initiativeId: planningImportId(row.initiativeKey) } : {}),
    ...(row.parentKey ? { parentId: planningImportId(row.parentKey) } : {}),
    imported,
  });
}

/** One logical request, bounded transport pages. Initiatives precede their Items; Item order stays stable. */
export function planningImportPages(rows: PlanningImportRow[], batchId: string): PlanningImportPage[] {
  invariant(
    new Set(rows.map(row => row.key)).size === rows.length,
    'BAD_ARGUMENT',
    'Each imported source key must name one row. Combine duplicate source rows before applying.',
  );
  const batchHash = digest(JSON.stringify(rows));
  const ordered = [
    ...rows.filter(row => row.kind === 'initiative'),
    ...rows.filter(row => row.kind === 'issue'),
  ];
  const pages: PlanningImportPage[] = [];
  let page: PlanningImportRow[] = [],
    bytes = 0;
  const flush = () => {
    pages.push({ batchId, batchHash, page: pages.length, rows: page });
    page = [];
    bytes = 0;
  };
  for (const row of ordered) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (page.length && (page.length === 100 || bytes + size > 128 * 1024)) flush();
    page.push(row);
    bytes += size;
  }
  if (page.length || !pages.length) flush();
  return pages;
}

export const importPageOperationId = (operationId: string, page: number) =>
  page === 0 ? operationId : planningImportId(JSON.stringify(['page', operationId, page]));
