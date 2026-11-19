// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { capsuleRunArgs } from './projectLandingCapsuleCapture';
import { packLandingCapsule } from './projectLandingCapsuleRun';

/** The same packer for a landing whose captured history exceeds the V8 packer's memory bound. */
export const pack = internalAction({
  args: capsuleRunArgs,
  returns: v.string(),
  handler: (ctx, input) => packLandingCapsule(ctx, input, 'node'),
});
