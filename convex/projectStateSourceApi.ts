// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { action } from './cliServer';
import type { ActionCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { SessionInput } from './projectHostedActionsSession';
import { stateSourceGrants } from './projectStateSourceGrants';
import { compactSourceGrants } from '../src/source-grant-wire';
import { directSourceBatch } from '../src/hosted-actions-direct';
import { invariant } from '../src/errors';
import { report } from './errors';
export async function runnerStateSource(
  ctx: ActionCtx,
  input: SessionInput,
  command: {
    state: string;
    version?: 2 | undefined;
    digests: string[];
    all?: boolean | undefined;
    object?: string | undefined;
    runs?: boolean | undefined;
    fallback?: boolean | undefined;
  },
) {
  return compactSourceGrants(
    await stateSourceGrants({
      ...command,
      projectId: input.projectId,
      select: async () =>
        JSON.parse(
          await ctx.runMutation(makeFunctionReference<'mutation'>('projectStateSourceSelection:runner'), {
            ...input,
            state: command.state,
            ...(command.version ? { version: command.version } : {}),
          }),
        ),
      catalog: async digests =>
        JSON.parse(
          await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSource:resolve'), {
            ...input,
            digests,
            batch: true,
            ...(command.version ? { version: command.version } : {}),
            closures: true,
            stateProof: true,
            ...(command.runs ? { runs: true } : {}),
          }),
        ),
      log: message => console.log('FORGE_SOURCE_BINDINGS ' + JSON.stringify({ message })),
    }),
  );
}
/** Public clone reads select one current readable State, then only its members. */
export const read = action({
  args: {
    projectId: v.id('hostedProjects'),
    state: v.string(),
    version: v.optional(v.literal(2)),
    digests: v.array(v.string()),
    all: v.optional(v.boolean()),
    object: v.optional(v.string()),
    runs: v.optional(v.boolean()),
    fallback: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      invariant(
        input.digests.length <= directSourceBatch && input.digests.every(id => /^[a-f0-9]{64}$/.test(id)),
        'BAD_ARGUMENT',
        'Select exact State content identities.',
      );
      let selections = 0;
      const result = await stateSourceGrants({
        ...input,
        projectId: input.projectId as Id<'hostedProjects'>,
        select: async () =>
          JSON.parse(
            await ctx.runMutation(makeFunctionReference<'mutation'>('projectStateSourceSelection:client'), {
              projectId: input.projectId,
              state: input.state,
              ...(input.version ? { version: input.version } : {}),
              ...(selections++ ? { recheck: true } : {}),
            }),
          ),
        catalog: async digests => {
          const rows: unknown[] = [];
          for (let at = 0; at < digests.length; at += 500)
            rows.push(
              ...(await ctx.runMutation(
                makeFunctionReference<'mutation'>('projectStateSourceSelection:catalog'),
                {
                  projectId: input.projectId,
                  digests: digests.slice(at, at + 500),
                  ...(input.runs ? { runs: true } : {}),
                },
              )),
            );
          return rows;
        },
        log: message => console.log('FORGE_SOURCE_BINDINGS ' + JSON.stringify({ message })),
      });
      return JSON.stringify(compactSourceGrants(result));
    } catch (error) {
      return report(error);
    }
  },
});
