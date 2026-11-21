// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { hostedRecordBody, recordVersion } from './projectHostedRecords';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedRecord } from '../src/hosted-records';
import {
  CODE_HISTORY_READ_BYTES,
  CODE_RECEIPT_ID,
  codeHistoryRow,
  type CodeFileHistoryPage,
} from '../src/code-history';
import { CODE_DIR_DEPTH } from '../src/code-tree';
import { invariant } from '../src/errors';
import { safeRelative } from '../src/safe-relative';

const SCAN_ROWS = 8;
const CANDIDATE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
type Candidate = Extract<HostedRecord, { kind: 'candidate' }>;

/** An older match from a file page links straight to its receipt. */
export async function codeHistoryReceipt(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receiptId: string,
  visitor: boolean,
) {
  if (!CODE_RECEIPT_ID.test(receiptId)) return [];
  const row = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
    .unique();
  return row ? [codeHistoryRow(JSON.parse(row.value) as HostedAcceptance, row.sequence, visitor)] : [];
}

/** Scan one bounded window of receipts. A Candidate's governance paths are the exact net change
 * against its composed base, including combined Candidates. They were recorded during composition
 * from States already in memory. File history needs neither the States nor their objects. */
export async function codeFileHistory(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  path: string,
  before: number | null,
  visitor: boolean,
): Promise<CodeFileHistoryPage> {
  invariant(
    safeRelative(path) &&
      path.split('/').length <= CODE_DIR_DEPTH + 1 &&
      (before === null || (Number.isSafeInteger(before) && before > 0)),
    'BAD_ARGUMENT',
    'Choose a file path and a landing page.',
  );
  const page = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      before === null ? q.eq('projectId', projectId) : q.eq('projectId', projectId).lt('sequence', before),
    )
    .order('desc')
    .paginate({
      cursor: null,
      numItems: SCAN_ROWS,
      maximumRowsRead: SCAN_ROWS,
      maximumBytesRead: CODE_HISTORY_READ_BYTES,
    });
  const landings: CodeFileHistoryPage['landings'] = [];
  const seen = new Map<string, boolean | null>();
  let missing = 0;
  let bytes = 0;
  let scanned = 0;
  for (const row of page.page) {
    // The receipt pins the shared Candidate in a batch, just as the source comparison did.
    const receipt = JSON.parse(row.value) as HostedAcceptance;
    const { id, head, digest } = receipt.candidate;
    const base = receipt.previous.head;
    const pins = `${id}:${base}:${head}:${digest}`;
    let touched = head === base ? false : seen.get(pins);
    if (touched === undefined) {
      const record = id ? await recordVersion(ctx, projectId, 'candidate', id, 0) : null;
      if (record) {
        // Reading the already-selected header may cross the target by one document. Finish the
        // first receipt even if it is large so that every continuation makes progress.
        bytes += encoder.encode(JSON.stringify(record)).length;
        const bodyBytes = record.inline === undefined ? record.bytes : 0;
        if (scanned && bytes + bodyBytes > CANDIDATE_BYTES) break;
        bytes += bodyBytes;
      }
      let candidate: Candidate | null = null;
      if (record && record.digest === digest && !record.journalSegment) {
        candidate = JSON.parse(await hostedRecordBody(ctx, record)) as Candidate;
      }
      touched =
        candidate?.kind === 'candidate' &&
        candidate.id === id &&
        candidate.base.head === base &&
        candidate.result.status === 'clean' &&
        candidate.result.head === head
          ? (candidate.governance?.paths.includes(path) ?? null)
          : null;
      seen.set(pins, touched);
    }
    scanned += 1;
    if (touched === null) missing += 1;
    if (touched) landings.push(codeHistoryRow(receipt, row.sequence, visitor));
  }
  return {
    landings,
    missing,
    nextBefore:
      scanned && (scanned < page.page.length || !page.isDone) ? page.page[scanned - 1]!.sequence : null,
  };
}
