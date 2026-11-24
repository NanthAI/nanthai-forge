// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { recordHead } from './projectHostedRecords';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

/** A finished Intent whose Issue continued reports the latest Intent's state. No bodies or sibling lanes. */
export async function currentPlanningIntentHead(ctx: QueryCtx, projectId: Id<'hostedProjects'>, id: string) {
  let head = await recordHead(ctx, projectId, 'intent', id);
  let at = id;
  for (
    let hop = 0;
    head && intentFinished(head.status.replace(/^journal:/, '')) && hop < maxIntentChain;
    hop++
  ) {
    const nextId = successorIntentId(at);
    const next = await recordHead(ctx, projectId, 'intent', nextId);
    if (!next) break;
    head = next;
    at = nextId;
  }
  return head;
}
