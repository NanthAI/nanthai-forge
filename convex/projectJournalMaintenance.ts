// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { JournalSegment, JournalIndex, JOURNAL_TABLES } from '../src/journal-segment';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { journalSourceRow } from './projectJournalCanonical';
export type JournalTable = (typeof JOURNAL_TABLES)[number];
export type JournalRow = Doc<JournalTable>;
export const journalRunArgs = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  phase: v.optional(v.number()),
  part: v.optional(v.number()),
  existing: v.optional(v.boolean()),
  laneId: v.optional(v.string()),
};
export type JournalRunInput = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  phase?: number;
  part?: number;
  existing?: boolean;
  laneId?: string;
};
export type Ref = { table: JournalTable; id: string; hash: string };
export type Proof = { id: string; hash: string };
export type Group = {
  category: Doc<'projectJournalSegments'>['category'];
  scope: string;
  from: number;
  through: number;
  refs: number[];
  keys?: string[];
  startKey?: string;
  endKey?: string;
  laneId?: string;
  intentId?: string;
  recipientActor?: string;
};
export type Pending = {
  pageId: string;
  input: JournalRunInput;
  claim: string;
  until: number;
  refs: Ref[];
  proofs: Proof[];
  groups: Group[];
  cursor: (string | number | null)[];
  done: boolean;
  fragment: number;
  pointers: JournalIndex['pointer'][];
};
export type Control = {
  runId?: string;
  cursor?: Pending['cursor'];
  pending?: Pending;
  last?: { pageId: string; result: string };
};
export const journalEnabled = () => process.env.FORGE_JOURNAL_SEGMENTS === '1';
export const phaseKey = (input: JournalRunInput) =>
  `journal-control:${input.phase ?? 0}:${input.laneId ?? (input.existing && (input.phase ?? 0) < 3 ? 'existing' : 'live')}`;
export const pageKey = (input: JournalRunInput) =>
  `${input.operationId}:${input.phase ?? 0}:${input.laneId ?? (input.existing && (input.phase ?? 0) < 3 ? 'e' : 'l')}:${input.part ?? 0}`;
export const receiptRow = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('projectJournalReceipts')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
export async function putControl(ctx: MutationCtx, input: JournalRunInput, value: Control) {
  const operationId = phaseKey(input),
    envelope = canonicalPayload(value),
    old = await receiptRow(ctx, input.projectId, operationId);
  const fields = { projectId: input.projectId, operationId, hash: digest(envelope), envelope };
  if (old) await ctx.db.replace(old._id, fields);
  else await ctx.db.insert('projectJournalReceipts', fields);
}
export const sourceText = async (row: JournalRow, table?: JournalTable) => {
  const source = journalSourceRow(row);
  if (
    'actor' in row &&
    'value' in row &&
    'operationId' in row &&
    table === 'projectHostedOperations' &&
    row.journalSegment
  ) {
    const { expandOperationReceipt } = await import('../src/compact-operation-receipt');
    source.value = canonicalPayload(expandOperationReceipt(row as Doc<'projectHostedOperations'>));
  }
  return canonicalPayload(source);
};
export async function loadCaptured(ctx: MutationCtx, pending: Pending) {
  const rows: JournalRow[] = [];
  for (const ref of pending.refs) {
    const row = await ctx.db.get(ref.id as Id<JournalTable>);
    if (!row || digest(canonicalPayload(row)) !== ref.hash) return null;
    rows.push(row);
  }
  for (const [n, ref] of pending.refs.entries()) {
    if (ref.table !== 'projectHostedRecords') continue;
    const record = rows[n] as Doc<'projectHostedRecords'>;
    if (!pending.refs.some(item => item.id === record.bodyId)) continue;
    const owners = await ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_body', q => q.eq('projectId', record.projectId).eq('bodyId', record.bodyId))
      .take(2);
    if (owners.length !== 1 || owners[0]!._id !== record._id) return null;
  }
  for (const proof of pending.proofs) {
    const id = ctx.db.normalizeId('projectHostedRecordHeads', proof.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row || digest(canonicalPayload(row)) !== proof.hash) return null;
  }
  return rows;
}
export async function logicalSegments(pending: Pending, rows: JournalRow[]): Promise<JournalSegment[]> {
  const texts = await Promise.all(rows.map((row, i) => sourceText(row, pending.refs[i]!.table)));
  return pending.groups.map(group => {
    const tables: JournalSegment['tables'] = {};
    for (const n of group.refs) (tables[pending.refs[n]!.table] ??= []).push(texts[n]!);
    return {
      protocol: 1,
      kind: 'forge-journal-segment',
      projectId: pending.input.projectId,
      scope: group.scope,
      from: group.from,
      through: group.through,
      ...(group.startKey ? { startKey: group.startKey, endKey: group.endKey } : {}),
      tables,
    };
  });
}
