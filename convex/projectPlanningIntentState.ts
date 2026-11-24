// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { recordHead } from './projectHostedRecords';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

/** The latest Intent owns completion evidence. Earlier links can still own an explicitly reopened Lane. */
export async function planningIntentHeads(ctx: QueryCtx, projectId: Id<'hostedProjects'>, id: string) {
  let head = await recordHead(ctx, projectId, 'intent', id);
  const heads = head ? [head] : [];
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
    heads.push(next);
    at = nextId;
  }
  return heads;
}
