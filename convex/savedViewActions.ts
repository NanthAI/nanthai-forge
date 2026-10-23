// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { savedLink } from './schema';
import { invariant } from '../src/errors';
import { report } from './errors';
import { readSource } from './hosted';

export const save = action({
  args: savedLink,
  returns: v.id('savedViews'),
  handler: async (ctx, args): Promise<Id<'savedViews'>> => {
    try {
      invariant(await ctx.auth.getUserIdentity(), 'GITHUB_UNAVAILABLE', 'Sign in to save a personal view.');
      invariant(
        args.name.trim() &&
          args.operationId.trim() &&
          /^[a-f0-9]{64}$/.test(args.route.state) &&
          Number.isSafeInteger(args.route.line) &&
          args.route.line > 0,
        'BAD_ARGUMENT',
        'Send a named view with its source state and positive line number.',
      );
      const receipt = await ctx.runQuery(internal.savedViews.receipt, { operationId: args.operationId });
      if (receipt) {
        invariant(
          receipt.importId === args.importId &&
            Object.keys({ ...receipt.route, ...args.route }).every(
              key =>
                receipt.route[key as keyof typeof args.route] === args.route[key as keyof typeof args.route],
            ),
          'BAD_ARGUMENT',
          'This save operation already names another view.',
        );
        return receipt.id;
      }
      // Reuse the source owner: current access and the actual artifact's source identity, without copying source bytes.
      const status = JSON.parse(await readSource(ctx, { id: args.importId, endpoint: 'status' })) as {
        sourceId: string;
      };
      invariant(
        status.sourceId === args.route.state,
        'STATE_MISMATCH',
        'This link names a different source state. Load the current state explicitly.',
      );
      return await ctx.runMutation(internal.savedViews.put, args);
    } catch (error) {
      return report(error);
    }
  },
});
