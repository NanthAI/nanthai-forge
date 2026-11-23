// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { capsuleHistory, capsuleHistoryArgs } from './projectLandingCapsuleRead';

/** Only the public V8 history action calls this, for a capsule over the V8 memory bound. Nested
 * queries run with the caller's identity, so authorization is the same public query's rule. */
export const history = internalAction({
  args: capsuleHistoryArgs,
  returns: v.union(v.string(), v.null()),
  handler: (ctx, input) => capsuleHistory(ctx, input, 'node'),
});
