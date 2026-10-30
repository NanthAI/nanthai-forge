'use node';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { exportPlanning as planningExport } from '../src/work-planning-state';
import { invariant } from '../src/errors';
import { metadataCommandSchema } from '../src/work-types';
import { metadataRequest, workDigest } from '../src/work-metadata';
import { report } from './errors';
import { indexedCommand } from './projectWorkIndexedCommand';
import { projectDocument, hostedWorkEventDocument } from './schema';

export async function caller(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  return user.subject;
}
export { source, load } from './projectWorkLoad';
import { source, load } from './projectWorkLoad';
import { exchangeObjectReader } from './projectExchangeReader';
export const initialize = action({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups'), operationId: v.string() },
  returns: projectDocument,
  handler: async (ctx, input): Promise<Doc<'hostedProjects'>> => {
    try {
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original Work operation UUID.',
      );
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
      const snapshot = await source(ctx, input.backupId, owner);
      invariant(
        snapshot.project._id === input.projectId,
        'PROJECT_UNAVAILABLE',
        'Select this project’s original backup.',
      );
      return await ctx.runMutation(internal.projectWork.initialize, {
        ...input,
        owner,
        revision: snapshot.data.revision,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const command = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    revision: v.number(),
    command: v.string(),
  },
  returns: hostedWorkEventDocument,
  handler: async (ctx, input): Promise<Doc<'projectWorkEvents'>> => {
    try {
      const owner = await caller(ctx);
      let parsed;
      try {
        parsed = metadataCommandSchema.safeParse(JSON.parse(input.command));
      } catch {
        invariant(false, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
      }
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
      const command = parsed.data,
        request = metadataRequest(command);
      if (command.action === 'put-planning-item' || command.action === 'comment-planning-item') {
        await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
        invariant(
          command.operationId === input.operationId,
          'BAD_ARGUMENT',
          'Use the planning command’s original operation UUID.',
        );
      }
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) &&
          Number.isSafeInteger(input.revision) &&
          input.revision >= 0,
        'BAD_ARGUMENT',
        'Use an original operation UUID and Work revision.',
      );
      const original: Doc<'projectWorkEvents'> | null = await ctx.runQuery(internal.projectWork.find, {
        projectId: input.projectId,
        owner,
        operationId: input.operationId,
      });
      if (original) {
        invariant(
          original.request === request && original.previousRevision === input.revision,
          'WORK_OPERATION_CHANGED',
          'Reconcile this operation’s original command and revision.',
        );
        return original;
      }
      const projection = await indexedCommand(ctx, input, owner, command, request);
      return await ctx.runMutation(internal.projectWork.append, {
        projectId: input.projectId,
        owner,
        operationId: input.operationId,
        request,
        previousRevision: input.revision,
        command: JSON.stringify(command),
        projection,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const exportJournal = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }): Promise<string> => {
    try {
      const snapshot = await load(ctx, projectId, await caller(ctx), exchangeObjectReader(ctx, false, 0), {
        requireCurrent: true,
      });
      return (
        JSON.stringify(
          {
            schema: 1,
            kind: 'forge-hosted-work-journal',
            projectKey: snapshot.project.key,
            name: snapshot.project.name,
            source: {
              transport: snapshot.backup.transport,
              backupId: snapshot.backup._id,
              head: snapshot.manifest.head,
              kind: snapshot.manifest.kind === 'forge-native-work-backup' ? 'native' : 'git',
            },
            base: {
              archiveSha256: snapshot.backup.digest,
              manifestSha256: snapshot.backup.preview.manifestDigest,
              workSha256: snapshot.originalWorkDigest,
            },
            events: snapshot.events,
            ...(snapshot.project.work?.intentMigration
              ? { intentMigration: snapshot.project.work.intentMigration }
              : {}),
            revision: snapshot.data.revision,
            workSha256: workDigest(snapshot.data),
            coverage:
              'Hosted authorized project operations over the pinned private source/Work checkpoint. Returned Lane/check/evidence provenance remains local and owner-supplied. Actor identities are server-recorded observations, not offline authenticated authorship. Local restore creates an independent owner and never starts commands.',
          },
          null,
          2,
        ) + '\n'
      );
    } catch (error) {
      return report(error);
    }
  },
});
export const exportPlanning = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }): Promise<string> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      const snapshot = await load(ctx, projectId, owner),
        result = planningExport(snapshot.data, { key: snapshot.project.key, name: snapshot.project.name });
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      return JSON.stringify(result);
    } catch (error) {
      return report(error);
    }
  },
});
