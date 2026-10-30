// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  CALLER_RECEIPT_BATCH,
  callerReceiptKey,
  callerReceiptSchema,
  mutationReceiptKey,
  type MetricMutationAction,
} from '../src/self-metric-receipts';

type Row = {
  projectId: Id<'hostedProjects'>;
  key: string;
  kind: 'outcome' | 'delivery' | 'mutation';
  actor: string;
  at: string;
  value: string;
};
async function insertOnce(ctx: MutationCtx, row: Row) {
  const old = await ctx.db
    .query('projectSelfMetricReceipts')
    .withIndex('by_project_and_key', q => q.eq('projectId', row.projectId).eq('key', row.key))
    .unique();
  if (old) return false;
  await ctx.db.insert('projectSelfMetricReceipts', row);
  return true;
}
/** Successful owner command, written inside the same mutation. Replays collapse. */
export async function recordMutationReceipt(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    operationId: string;
    action: MetricMutationAction;
    at?: string;
  },
) {
  const at = input.at ?? new Date().toISOString();
  await insertOnce(ctx, {
    projectId: input.projectId,
    key: mutationReceiptKey(input.actor, input.operationId, input.action),
    kind: 'mutation',
    actor: input.actor,
    at,
    value: canonicalPayload({ action: input.action, operationId: input.operationId }),
  });
}
const DAY = 86_400_000;
/** Caller receipts ride on an existing successful mutation. Invalid, foreign or
 * implausibly timed receipts are skipped, never allowed to fail the host mutation. */
export async function recordCallerReceipts(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  raw: string,
) {
  let values: unknown;
  try {
    values = raw.length <= 64 * 1024 ? JSON.parse(raw) : [];
  } catch {
    return 0;
  }
  if (!Array.isArray(values)) return 0;
  const now = Date.now();
  let written = 0;
  for (const value of values.slice(0, CALLER_RECEIPT_BATCH)) {
    const parsed = callerReceiptSchema.safeParse(value);
    if (!parsed.success) continue;
    const receipt = parsed.data;
    const at = Date.parse(receipt.at);
    if ((receipt.actor !== null && receipt.actor !== actor) || at > now + 300_000 || at < now - 30 * DAY)
      continue;
    const { actor: _declared, kind, at: observedAt, ...rest } = receipt;
    void _declared;
    if (
      await insertOnce(ctx, {
        projectId,
        key: callerReceiptKey(receipt, actor),
        kind,
        actor,
        at: observedAt,
        value: canonicalPayload(rest),
      })
    )
      written++;
  }
  return written;
}
