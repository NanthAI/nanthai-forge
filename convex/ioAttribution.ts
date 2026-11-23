// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx } from './_generated/server';

/** Code-chosen read labels only (never arguments, ids or user text): the spend ledger keeps them. */
const ioAttributionLabel = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){0,3}$/;

/** One console line per call splits a function's billed I/O by read shape in the spend ledger
 * (scripts/convex-spend-model.mjs). It reads only this transaction's own meter: no document,
 * no call, and it never changes the answer. */
export async function logIoAttribution(ctx: Pick<QueryCtx, 'meta'>, label: string) {
  if (!ioAttributionLabel.test(label) || label.length > 64) return;
  let metrics;
  try {
    metrics = await ctx.meta.getTransactionMetrics();
  } catch {
    metrics = null;
  }
  console.log(
    `FORGE_IO_ATTRIBUTION ${JSON.stringify({
      label,
      ...(metrics ? { documentsRead: metrics.documentsRead.used, bytesRead: metrics.bytesRead.used } : {}),
    })}`,
  );
}
