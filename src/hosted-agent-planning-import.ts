// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Loaded only for a requested transfer. Ordinary CLI/MCP planning startup is unchanged.
import { z } from 'zod';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import type { PlanningPort } from './hosted-agent-planning.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  importPageOperationId,
  planningImportPages,
  planningImportRowSchema,
  type PlanningImportResult,
} from './planning-import.js';

const transferSchema = z
  .object({
    mode: z.literal('import'),
    apply: z.boolean().default(false),
    batchId: z.uuid().optional(),
    rows: z.array(planningImportRowSchema),
  })
  .strict();
export async function importPlanning(
  port: PlanningPort,
  actor: string,
  input: Record<string, unknown>,
  operationId?: string,
) {
  const read = hostedAgentCommandSchemas.planning.parse(input);
  invariant(
    !read.id &&
      !read.search &&
      !read.counts &&
      !read.schedule &&
      !read.kind &&
      !read.status &&
      !read.initiativeId &&
      !read.type &&
      !read.owner &&
      !read.relation &&
      !read.cursor,
    'BAD_ARGUMENT',
    'Use transfer without planning list filters.',
  );
  const transfer = transferSchema.parse(read.transfer);
  invariant(
    port.serverFeatures?.includes('planning-import-pages'),
    'HOSTED_ACTION_UNSUPPORTED',
    'This server does not support backlog import pages yet.',
  );
  // Preparation and apply share the exact source request; preparation changes no server record.
  const request = { rows: transfer.rows, ...(transfer.batchId ? { batchId: transfer.batchId } : {}) };
  const journal = new HostedAgentJournal(
    port.root,
    port.address,
    actor,
    'planning-import',
    request,
    operationId,
  );
  port.retainOperation?.(journal.operationId);
  const batchId = transfer.batchId ?? journal.operationId;
  const pages = planningImportPages(transfer.rows, batchId);
  const created: string[] = [],
    skipped: string[] = [];
  const rows: PlanningImportResult['rows'] = [];
  for (const page of pages) {
    const pageId = importPageOperationId(journal.operationId, page.page);
    const args = { operationId: pageId, request: canonicalPayload(page) };
    try {
      const result = transfer.apply
        ? await journal.retain(`applied:${page.page}`, () =>
            port.mutation<PlanningImportResult>('projectPlanningImport:apply', args),
          )
        : await port.query<PlanningImportResult>('projectPlanningImport:preview', args);
      created.push(...result.created);
      skipped.push(...result.skipped);
      rows.push(...result.rows);
    } catch (error) {
      const failure = hostedActionError(error, 'backlog import');
      return {
        operationId: journal.operationId,
        result: {
          batchId,
          applyRequested: transfer.apply,
          status: created.length || skipped.length ? 'partial' : 'failed',
          retainedRows: rows,
          created,
          skipped,
          failedPage: page.page,
          pendingKeys: pages
            .slice(page.page)
            .flatMap(part => part.rows.filter(row => row.selected).map(row => row.key)),
          error: { code: failure.code, message: failure.message },
          next: 'Replay the same request and operationId. Confirmed pages stay retained; an unconfirmed page reconciles its original receipt.',
        },
      };
    }
  }
  return {
    operationId: journal.operationId,
    result: {
      batchId,
      applyRequested: transfer.apply,
      status: 'complete',
      created,
      skipped,
      rows: rows.sort((a, b) => Number(b.action === 'attention') - Number(a.action === 'attention')),
      pages: pages.length,
      ...(!transfer.apply
        ? { next: 'Review every row, then replay this request and operationId with transfer.apply:true.' }
        : {}),
    },
  };
}
