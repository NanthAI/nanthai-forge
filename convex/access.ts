// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertImporter, authorizeGithub } from '../src/github-access';
import { invariant } from '../src/errors';

export function githubConfig() {
  return {
    clerkSecret: process.env.CLERK_SECRET_KEY,
    appClientId: process.env.GITHUB_APP_CLIENT_ID,
    appClientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    publicToken: process.env.GITHUB_PUBLIC_TOKEN,
  };
}
export async function currentAccess(
  ctx: ActionCtx,
  id: Id<'imports'>,
  caller: string | undefined,
  allowTrash = false,
  ownerOnly = false,
) {
  const read = async () => {
    const job: Doc<'imports'> | null = await ctx.runQuery(internal.imports.get, { id });
    invariant(
      job && (!job.removal || (allowTrash && job.removal === 'trash')),
      'GITHUB_UNAVAILABLE',
      'This Codescape is unavailable with the current access.',
    );
    return job;
  };
  const job = await read();
  const shared: boolean = Boolean(
    caller &&
    caller !== job.owner &&
    job.visibility === 'private' &&
    !allowTrash &&
    !ownerOnly &&
    (await ctx.runQuery(internal.sharing.allowed, { id, reader: caller })) === true,
  );
  if (!shared) assertImporter(job.visibility, job.owner, caller);
  const access = await authorizeGithub(job.repository, caller, githubConfig());
  if (shared) {
    await authorizeGithub(job.repository, job.owner, githubConfig());
    // Recheck grants/lifecycle after provider calls; a removal during those reads must stop storage retrieval.
    invariant(
      (await ctx.runQuery(internal.sharing.allowed, { id, reader: caller! })) === true,
      'GITHUB_UNAVAILABLE',
      'This Codescape is unavailable with the current access.',
    );
  } else if (access.repository.private) assertImporter('private', job.owner, caller);
  // Every path rechecks lifecycle and importer after provider calls; removal or transfer during them stops the read.
  // Callers keep the original job pins so they can still detect source changes during their own reads.
  const current = await read();
  if (!shared)
    assertImporter(access.repository.private ? 'private' : current.visibility, current.owner, caller);
  return { job, ...access };
}
