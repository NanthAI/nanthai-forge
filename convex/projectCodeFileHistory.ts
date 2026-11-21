// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
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

const MATCHES_PER_PAGE = 8;
const SCAN_ROWS = 96;
const SCAN_BATCH = 16;
const SCAN_RECEIPT_BYTES = 512 * 1024;
const CANDIDATE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const documentBytes = (row: object) => encoder.encode(JSON.stringify(row)).length;
type Candidate = Extract<HostedRecord, { kind: 'candidate' }>;
type Match = boolean | null;

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

/** Find a page of matches within a bounded window of receipts. A Candidate's governance paths are the exact net change
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
  const receipts = (cutoff: number | null) =>
    ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q =>
        cutoff === null ? q.eq('projectId', projectId) : q.eq('projectId', projectId).lt('sequence', cutoff),
      )
      .order('desc');
  // One lookahead makes dense pages cheap. Stop as soon as a receipt crosses the byte target.
  const recent: Doc<'projectHostedAcceptances'>[] = [];
  let receiptBytes = 0;
  let hasOlder = false;
  for await (const row of receipts(before)) {
    const size = documentBytes(row);
    if (recent.length && receiptBytes + size > CODE_HISTORY_READ_BYTES) {
      hasOlder = true;
      break;
    }
    recent.push(row);
    receiptBytes += size;
    if (recent.length > MATCHES_PER_PAGE) {
      hasOlder = true;
      break;
    }
  }
  let rows = recent;
  const landings: CodeFileHistoryPage['landings'] = [];
  const seen = new Map<string, Match>();
  let missing = 0;
  let bytes = 0;
  let scanned = 0;
  while (scanned < rows.length && landings.length < MATCHES_PER_PAGE) {
    if (scanned === MATCHES_PER_PAGE && recent.length > MATCHES_PER_PAGE) {
      const remaining = SCAN_ROWS - recent.length;
      const page = await receipts(recent.at(-1)!.sequence).paginate({
        cursor: null,
        numItems: remaining,
        maximumRowsRead: remaining,
        maximumBytesRead: SCAN_RECEIPT_BYTES - receiptBytes,
      });
      rows = [...recent, ...page.page];
      hasOlder = !page.isDone;
    }
    // Keep dense pages cheap. On sparse pages, read headers and then bodies in parallel.
    const count = scanned ? SCAN_BATCH : MATCHES_PER_PAGE;
    const pending = new Map<string, ReturnType<typeof recordVersion>>();
    const batch = rows.slice(scanned, scanned + count).map(row => {
      const receipt = JSON.parse(row.value) as HostedAcceptance;
      const { id, head, digest } = receipt.candidate;
      const base = receipt.previous.head;
      const pins = `${id}:${base}:${head}:${digest}`;
      if (head !== base && id && !seen.has(pins) && !pending.has(pins))
        pending.set(pins, recordVersion(ctx, projectId, 'candidate', id, 0));
      return { row, receipt, pins };
    });
    const headers = await settledByKey(pending);
    for (const header of headers.values()) {
      if (header.status === 'fulfilled' && header.value) bytes += documentBytes(header.value);
    }
    const reads = new Map<string, Promise<Match>>();
    let end = 0;
    for (const { receipt, pins } of batch) {
      if (!seen.has(pins) && !reads.has(pins)) {
        const header = headers.get(pins);
        if (header?.status === 'rejected') {
          // Surface a speculative read failure only if its receipt is needed to fill this page.
          reads.set(pins, Promise.reject(header.reason));
          end += 1;
          break;
        }
        const record = header?.value;
        const pinned = record && record.digest === receipt.candidate.digest && !record.journalSegment;
        const bodyBytes = pinned && record.inline === undefined ? record.bytes : 0;
        // Allow the first receipt through even if it alone exceeds the byte target.
        if (scanned + end && bodyBytes && bytes + bodyBytes > CANDIDATE_BYTES) break;
        bytes += bodyBytes;
        reads.set(
          pins,
          pinned
            ? candidateMatch(ctx, record, receipt, path)
            : Promise.resolve(receipt.candidate.head === receipt.previous.head ? false : null),
        );
      }
      end += 1;
    }
    const results = await settledByKey(reads);
    for (const { row, receipt, pins } of batch.slice(0, end)) {
      let touched = seen.get(pins);
      if (touched === undefined) {
        const result = results.get(pins)!;
        if (result.status === 'rejected') throw result.reason;
        touched = result.value;
        seen.set(pins, touched);
      }
      scanned += 1;
      if (touched === null) missing += 1;
      if (touched) landings.push(codeHistoryRow(receipt, row.sequence, visitor));
      if (landings.length === MATCHES_PER_PAGE) break;
    }
    if (end < batch.length) break;
  }
  return {
    landings,
    missing,
    scanned,
    nextBefore: scanned && (scanned < rows.length || hasOlder) ? rows[scanned - 1]!.sequence : null,
  };
}

async function settledByKey<T>(reads: Map<string, Promise<T>>) {
  const keys = [...reads.keys()];
  return new Map(
    (await Promise.allSettled(reads.values())).map((result, index) => [keys[index]!, result] as const),
  );
}

async function candidateMatch(
  ctx: QueryCtx,
  record: Doc<'projectHostedRecords'>,
  receipt: HostedAcceptance,
  path: string,
): Promise<Match> {
  const candidate = JSON.parse(await hostedRecordBody(ctx, record)) as Candidate;
  return candidate.kind === 'candidate' &&
    candidate.id === receipt.candidate.id &&
    candidate.base.head === receipt.previous.head &&
    candidate.result.status === 'clean' &&
    candidate.result.head === receipt.candidate.head
    ? (candidate.governance?.paths.includes(path) ?? null)
    : null;
}
