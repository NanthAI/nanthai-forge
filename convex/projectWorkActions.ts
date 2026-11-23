// SPDX-License-Identifier: Apache-2.0
'use node';
import type { StoredWorkEvent } from './projectWorkEventStore';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exportPlanning as planningExport } from '../src/work-planning-state';
import { landingNoteExport } from '../src/intent-landing-note';
import { loadArchivedLandingNotes } from './projectIntentLandingNoteArchiveRead';
import type { ArchivedNotePin } from './projectIntentLandingNoteArchive';
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
        ...(snapshot.backup.validatedWorkRecords === 1 && snapshot.data.revision === 0
          ? { workSchema: snapshot.data.schema }
          : {}),
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
  options: { server?: true } = {},
) =>
  runWorkCommand(
    ctx,
    input,
    owner,
    (command, request) => indexedCommand(ctx, input, owner, command, request, nodeCommandHooks),
    options,
  );
/** Compatibility entry for older clients. Metadata delegates to the revision-free mutation;
 * anchored notes and Channel acceptance retain their pinned Node validation. */
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
  args: { ...commandArgs, owner: v.string(), server: v.optional(v.literal(true)) },
  returns: hostedWorkEventDocument,
  handler: async (ctx, { owner, server, ...input }): Promise<StoredWorkEvent> =>
    nodeCommand(ctx, input, owner, server ? { server } : {}),
});
export const exportJournal = action({
  // purgedRows: 2 (contract feature planning-purge-v2): the caller replays purged rows, including an Intent's and
  // its notes, and purges that list their rows. Without it (or with v1's `true`) a journal that has a purge is
  // refused with CLI_UPGRADE_REQUIRED, so an older CLI never meets a row form it cannot read. purgedRows: 3
  // (one comment's purge, Item b6588425 line 2b) also replays one comment's purge; a v2 caller is refused a journal that has one.
  args: {
    projectId: v.id('hostedProjects'),
    purgedRows: v.optional(v.union(v.literal(true), v.literal(2), v.literal(3))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, purgedRows }): Promise<string> => {
    try {
      const snapshot = await load(ctx, projectId, await caller(ctx), exchangeObjectReader(ctx, false, 0), {
        requireCurrent: true,
      });
      const purged = snapshot.events.filter(event => event.command.action === 'purged-planning-row').length;
      // A purge command alone (before its rows are redacted) is also a form an older CLI cannot replay.
      invariant(
        purgedRows === 3 ||
          (purgedRows === 2 &&
            !snapshot.events.some(event => event.command.action === 'purge-planning-comment')) ||
          !snapshot.events.some(
            event =>
              event.command.action === 'purged-planning-row' ||
              event.command.action === 'purge-planning-item' ||
              event.command.action === 'purge-planning-comment',
          ),
        'CLI_UPGRADE_REQUIRED',
        'Run nforge update to restore this project: its Work journal has permanently deleted Items or comments.',
      );
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
              'Hosted authorized project operations over the pinned private source/Work checkpoint. Returned Lane/check/evidence provenance remains local and owner-supplied. Actor identities are server-recorded observations, not offline authenticated authorship. Local restore creates an independent owner and never starts commands.' +
              (purged
                ? ` ${purged} purged row(s) keep their operation envelope and structure; their words are gone.` +
                  (snapshot.envelopeOnly
                    ? ` ${snapshot.envelopeOnly} legacy source return(s) after them are checked by envelope continuity only, not by their pinned Work digest.`
                    : '')
                : ''),
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
      type ExportNote = [string, ReturnType<typeof landingNoteExport>];
      const notes: ExportNote[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: { notes: string; continueCursor: string; isDone: boolean; archived?: string } =
          await ctx.runQuery(internal.projectIntentLandingNotes.exportPage, { projectId, owner, cursor });
        notes.push(...(JSON.parse(page.notes) as ExportNote[]));
        if (page.archived) {
          const archived = await loadArchivedLandingNotes(
            projectId,
            JSON.parse(page.archived) as ArchivedNotePin[],
          );
          notes.push(...archived.map(({ key, row }): ExportNote => [key, landingNoteExport(row)]));
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      // Name people by handle before the digest is taken, so the returned digest covers them.
      notes.sort(([a, x], [b, y]) =>
        x.intentId < y.intentId ? -1 : x.intentId > y.intentId ? 1 : a < b ? -1 : a > b ? 1 : 0,
      );
      const exported = { data: snapshot.data, landingNotes: notes.map(([, note]) => note) };
      const { data, landingNotes } = (await actionPublicPeople(
        ctx,
        { projectId },
        exported,
      )) as typeof exported;
      const result = planningExport(data, {
        key: snapshot.project.key,
        name: snapshot.project.name,
        landingNotes,
      });
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      return JSON.stringify(result);
    } catch (error) {
      return report(error);
    }
  },
});
