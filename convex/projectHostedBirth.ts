// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { requireHostedOwnerDrained } from './projectSourceAuthorityDrain';
import { nextSourceAuthority, requireSourceAuthority, sourceAuthority } from '../src/hosted-source-authority';
import { hostedMainV2Schema } from '../src/hosted-main';
import { CUTOVER_CLI_VERSION } from '../src/cutover-version';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

type Birth = {
  operationId: string;
  head: string;
  backupId: Id<'projectBackups'>;
  generationId: Id<'projectWorkGenerations'>;
  origin: 'new-project' | 'github-import' | 'make-editable';
};
/** A project with no native owner starts under server authority. One
 * transaction selects hosted main at the published head and keeps the same
 * receipt a cutover writes, so agents can start Lanes with no Mac. A project
 * with a native owner journal keeps the drained-owner cutover instead. */
export async function selectBornMain(ctx: MutationCtx, project: Doc<'hostedProjects'>, input: Birth) {
  const previous = requireSourceAuthority(project);
  invariant(!project.sourceCutover, 'CHANNEL_CHANGED', 'This project already changed source authority.');
  invariant(!(await channelRow(ctx, project._id)), 'CHANNEL_CHANGED', 'Hosted main is already selected.');
  const journal = await ctx.db
    .query('projectWorkHeads')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .unique();
  invariant(
    !journal,
    'SOURCE_AUTHORITY_DRAIN_REQUIRED',
    'A native owner journal exists for this project. Switch it with nforge host ROOT --cutover-file.',
  );
  const authority = nextSourceAuthority(previous, previous, 'server'),
    at = new Date().toISOString();
  const main = hostedMainV2Schema.parse({
    schema: 2,
    projectId: project._id,
    snapshotId: input.operationId,
    sourceRevision: 0,
    authority,
    channel: 'main',
    head: input.head,
    receipt: { id: `bootstrap:${input.head}`, kind: 'native', previousHead: null, previousReceiptId: null },
    seed: { backupId: input.backupId, generationId: input.generationId },
  });
  await ctx.db.insert('projectHostedChannels', {
    projectId: project._id,
    operationId: input.operationId,
    name: 'main',
    selection: canonicalPayload(main),
  });
  await ctx.db.patch(project._id, {
    sourceAuthority: authority,
    sourceCutover: { minimumCliVersion: CUTOVER_CLI_VERSION, at },
  });
  const receipt = canonicalPayload({
    operationId: input.operationId,
    projectId: project._id,
    origin: input.origin,
    previous: { authority: previous },
    authority,
    main,
    minimumCliVersion: CUTOVER_CLI_VERSION,
    changes: ['project source authority and epoch', 'hosted main selected at the published head'],
    undo: 'Recover a native owner from this project, then cut over to native-owner at the next epoch with a new operationId.',
    at,
  });
  await ctx.db.insert('projectSourceCutovers', {
    projectId: project._id,
    operationId: input.operationId,
    request: canonicalPayload({ operationId: input.operationId, mode: 'server', origin: input.origin }),
    receipt,
  });
  return receipt;
}

/** Existing imported projects published a Work backup but stayed native-owner.
 * The owner converts that exact, unchanged import into hosted main; the bytes
 * are already stored, so nothing is uploaded and no Mac is involved. */
export const makeEditable = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to make your project editable.');
      invariant(z.uuid().safeParse(input.operationId).success, 'BAD_ARGUMENT', 'Use an operation UUID.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const done = await ctx.db
        .query('projectSourceCutovers')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (done) return done.receipt;
      invariant(
        sourceAuthority(project).mode === 'native-owner' && !project.sourceCutover,
        'CHANNEL_CHANGED',
        'This project is already editable by agents.',
      );
      const jobs = await ctx.db
        .query('projectGithubImports')
        .withIndex('by_project', q => q.eq('projectId', input.projectId))
        .take(2);
      const job = jobs[0];
      invariant(
        jobs.length === 1 && job!.phase === 'ready' && job!.publication && project.work,
        'SOURCE_UNAVAILABLE',
        'Only a completed GitHub import can be made editable here.',
      );
      const publication = job!.publication!;
      invariant(
        project.currentBackup === publication.backupId &&
          project.work!.backupId === publication.backupId &&
          project.work!.generationId === publication.generationId &&
          project.revision === 1,
        'CHANNEL_CHANGED',
        'Source changed after the import. Switch through its native owner with nforge host ROOT --cutover-file.',
      );
      const backup = (await ctx.db.get(publication.backupId))!;
      invariant(
        backup.status === 'stored' &&
          backup.validatedClosure === 1 &&
          backup.preview.channels?.find(c => c.name === 'main')?.head === publication.head,
        'INVALID_WORK_BACKUP',
        'The imported source is not a validated closure.',
      );
      await requireHostedOwnerDrained(ctx, project, {
        revision: backup.preview.revision,
        fingerprint: input.operationId,
      });
      return await selectBornMain(ctx, project, {
        operationId: input.operationId,
        head: publication.head,
        backupId: publication.backupId,
        generationId: publication.generationId,
        origin: 'make-editable',
      });
    } catch (error) {
      return report(error);
    }
  },
});
