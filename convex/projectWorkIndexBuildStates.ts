// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { indexReadContext } from './projectWorkIndexRetry';
import { indexEntry } from './projectWorkIndexFields';
import { sourceTreeEntries } from '../src/source-tree-index';
import type { IndexEntry } from '../src/work-hosted-index';
import { parseNativeState } from '../src/state/format';
import type { Pin } from './projectDiffstatProjection';
const pin = v.object({ sha256: v.string(), size: v.number() });
export const treeRef = makeFunctionReference<
  'action',
  {
    projectId: Doc<'projectBackups'>['projectId'];
    actor: string;
    pin: Pin;
  },
  IndexEntry[]
>('projectWorkIndexBuildStates:tree');
export const tree = internalAction({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), pin },
  returns: v.array(indexEntry),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    const [bytes] = await exchangeObjectReader(ctx, false, 0).read(input.projectId, input.actor, [input.pin]);
    return sourceTreeEntries(input.pin.sha256, parseNativeState(bytes!).files);
  },
});
