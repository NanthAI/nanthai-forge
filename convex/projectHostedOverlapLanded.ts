// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { patchOverlapRow } from './projectHostedOverlapPeers';
import { acceptancePage, type ReceiptIdentity } from './projectHostedAcceptanceStore';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { recordOverlapLanding } from '../src/hosted-overlap';
import { agentActor } from '../src/agent-slug';

/** One immutable input page is at most 100 entries; later pages are reached through the completion ledger. */
const RETIRE_LIMIT = 100;
/** A Lane whose saved head landed on main is no longer open work for overlap purposes, even when the
 * completion ledger skips it (keepOpen, or its record pins moved after finish). Patches only advisory
 * rows whose head is exactly the landed head; a Lane saved again afterwards is tracked open again by
 * its next record write. Replay-safe: an already retired row is skipped. */
export async function retireLandedOverlapLanes(
  ctx: MutationCtx,
  identity: ReceiptIdentity,
  landed?: { commit: string; at: string; sequence?: number },
) {
  const page = await acceptancePage(ctx, { ...identity, kind: 'inputs', index: 0 });
  if (!page) return 0;
  let retired = 0,
    logged = false;
  const entries = validateComposePage(JSON.parse(page.value)).entries;
  for (const value of entries) {
    if (retired >= RETIRE_LIMIT) break;
    const lane = composeLaneSchema.safeParse(value);
    if (!lane.success) continue;
    const row = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q =>
        q.eq('projectId', identity.projectId).eq('laneId', lane.data.laneId),
      )
      .unique();
    if (!row || row.head !== lane.data.head) continue;
    // The drift nudge names landings: the first landed Lane's public identity goes on the main row's
    // landing log (one indexed read and replace per landing completion, idempotent per sequence).
    if (!logged && landed?.sequence !== undefined) {
      logged = true;
      const main = await ctx.db
        .query('projectHostedOverlapMain')
        .withIndex('by_project', q => q.eq('projectId', identity.projectId))
        .unique();
      if (main) {
        const next = recordOverlapLanding(main.landings, {
          sequence: landed.sequence,
          receiptId: identity.receiptId,
          laneId: row.laneId,
          actor: agentActor(row.actor, row.agent),
        });
        if (next !== main.landings) await ctx.db.patch(main._id, { landings: next });
      }
    }
    // Landing evidence rides on the same row patch: Lane status reads it with no extra call.
    const stamp = landed
      ? { receiptId: identity.receiptId, commit: landed.commit, laneHead: row.head, at: landed.at }
      : undefined;
    const stamped = !stamp || row.landed?.receiptId === stamp.receiptId;
    if (!row.open && stamped) continue;
    await patchOverlapRow(ctx, row, { open: false, ...(stamped ? {} : { landed: stamp }) });
    retired++;
  }
  return retired;
}
