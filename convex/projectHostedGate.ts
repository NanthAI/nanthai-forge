// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/** Behaviour-neutral S0 placeholder; the owning slice supplies the implementation. */
export const noop = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async () => null,
});
