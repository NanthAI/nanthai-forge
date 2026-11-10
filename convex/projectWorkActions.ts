// SPDX-License-Identifier: Apache-2.0
'use node';
import type { StoredWorkEvent } from './projectWorkEventStore';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exportPlanning as planningExport } from '../src/work-planning-state';
import { invariant } from '../src/errors';
import { workDigest } from '../src/work-metadata';
import { report } from './errors';
import { actionPublicPeople } from './publicPeople';
import { indexedCommand } from './projectWorkIndexedCommand';
import { nodeCommandHooks } from './projectWorkIndexedNode';
import { caller, runWorkCommand } from './projectWorkCommandRun';
import { projectDocument, hostedWorkEventDocument } from './schema';

export { caller };
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
const commandArgs = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  revision: v.number(),
  command: v.string(),
};
const nodeCommand = (
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; revision: number; command: string },
  owner: string,
) =>
  runWorkCommand(ctx, input, owner, (command, request) =>
    indexedCommand(ctx, input, owner, command, request, nodeCommandHooks),
  );
/** Full Node implementation. Current clients call `projectWorkActionsV8:command`, which runs the
 * commands that fit the 64 MiB V8 runtime and hands the rest to `commandNode`; this public name stays
 * for older clients and keeps the exact same behaviour. */
export const command = action({
  args: commandArgs,
  returns: hostedWorkEventDocument,
  handler: async (ctx, input): Promise<StoredWorkEvent> => {
    try {
      return await nodeCommand(ctx, input, await caller(ctx));
    } catch (error) {
      return report(error);
    }
  },
});
/** Node fallback of the V8 action: the owner was resolved there, from the same caller. */
export const commandNode = internalAction({
  args: { ...commandArgs, owner: v.string() },
  returns: hostedWorkEventDocument,
  handler: async (ctx, { owner, ...input }): Promise<StoredWorkEvent> => nodeCommand(ctx, input, owner),
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
      const snapshot = await load(ctx, projectId, owner);
      // Name people by handle before the digest is taken, so the returned digest covers them.
      const data = (await actionPublicPeople(ctx, { projectId }, snapshot.data)) as typeof snapshot.data,
        result = planningExport(data, { key: snapshot.project.key, name: snapshot.project.name });
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      return JSON.stringify(result);
    } catch (error) {
      return report(error);
    }
  },
});
