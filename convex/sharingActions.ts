// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { currentAccess } from './access';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';

export async function checkForgeUser(value: string) {
  const reader = value.trim();
  invariant(reader, 'BAD_ARGUMENT', 'Enter an existing Forge user ID.');
  invariant(process.env.CLERK_SECRET_KEY, 'GITHUB_SETUP_REQUIRED', 'Forge identity is not configured.');
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(reader)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  invariant(response.status !== 404, 'BAD_ARGUMENT', 'This Forge user ID does not exist.');
  invariant(response.ok, 'GITHUB_UNAVAILABLE', 'Forge could not check this user. Try again.');
  invariant(
    ((await response.json()) as { id?: string }).id === reader,
    'GITHUB_RESPONSE',
    'The identity provider returned another user.',
  );
  return reader;
}

export const add = action({
  args: { id: v.id('imports'), reader: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, reader }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const job: Doc<'imports'> | null = await ctx.runQuery(internal.imports.get, { id });
      invariant(
        user && job?.owner === user.subject && job.visibility === 'private' && job.removal !== 'deleting',
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      reader = await checkForgeUser(reader);
      return await ctx.runMutation(internal.sharing.add, { id, owner: user.subject, reader });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({ id: v.id('imports'), repository: v.string(), ref: v.string(), phase: v.string() }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    { paginationOpts },
  ): Promise<{
    page: { id: Id<'imports'>; repository: string; ref: string; phase: string }[];
    isDone: boolean;
    continueCursor: string;
  }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      if (!user) return { page: [], isDone: true, continueCursor: '' };
      const candidates: { page: Id<'imports'>[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.sharing.candidates, { reader: user.subject, paginationOpts });
      const page = [];
      // ponytail: current provider checks per page; batch only if measured shared-list latency warrants it.
      for (const id of candidates.page) {
        try {
          const { job } = await currentAccess(ctx, id, user.subject);
          page.push({ id, repository: job.repository, ref: job.ref, phase: job.phase });
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
        }
      }
      return { ...candidates, page };
    } catch (error) {
      return report(error);
    }
  },
});
