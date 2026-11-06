// SPDX-License-Identifier: Apache-2.0
import { parseWork } from '../src/work-unified-types';
import { commandPayloadRows, commandPlanningRows, commandValues } from './projectWorkCommandRows';
// Runtime-neutral action helper (no "use node"): the existing reducer stays the semantic owner and only its
// inputs are scoped. Two command shapes need Node-only readers; they come in as `hooks` from the Node action.
// Without hooks (the 64 MiB V8 action) those shapes, and any command whose rows exceed the V8 budget, throw
// NodeCommandRequired before any write, and the caller re-runs the same command in the Node action.
import { commandKeys, commandProjection, commandAliasRows } from './projectWorkProjection';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { type HostedEvent } from '../src/work-types';
import { validateMetadataSource, validateHostedChannel } from '../src/work-metadata';
import { type IndexEntry, type IndexMetadata } from '../src/work-hosted-index';
import type { hostedAcceptance } from './projectAcceptance';
import type { readSourceReview } from './projectSourceReview';
import { validateAnchorView } from '../src/work-source-anchor';
import { invariant } from '../src/errors';
export class NodeCommandRequired extends Error {
  constructor(why: string) {
    super(`This command needs the Node runtime: ${why}`);
    this.name = 'NodeCommandRequired';
  }
}
/** Row text one V8 command may hold. Live commands read under 100 KB; 4 MiB leaves 64 MiB isolates ample
 * headroom for parsing and the reducer copies, and anything larger runs in Node. */
export const V8_COMMAND_ROW_BYTES = 4 * 1024 * 1024;
type Command = Exclude<HostedEvent['command'], { action: 'source-return' }>;
export type IndexedCommandHooks = {
  acceptance: typeof hostedAcceptance;
  sourceReview: typeof readSourceReview;
};
export async function indexedCommand(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; revision: number },
  owner: string,
  command: Command,
  request: string,
  hooks?: IndexedCommandHooks,
) {
  if (!hooks && command.action === 'accept-hosted-channel') throw new NodeCommandRequired('acceptance');
  if (!hooks && command.action === 'note' && command.anchor) throw new NodeCommandRequired('source review');
  let spent = 0;
  const spend = (text: string) => {
    spent += text.length;
    if (!hooks && spent > V8_COMMAND_ROW_BYTES) throw new NodeCommandRequired('row budget');
  };
  const counted = (found: (IndexEntry | null)[]) => {
    for (const row of found) if (row) spend(row.value);
    return found;
  };
  const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    { projectId: input.projectId, owner },
  );
  invariant(
    generation,
    'PROJECT_WORK_INDEX_MISSING',
    'The Work index is unavailable. Run hosted-work with action rebuild-index explicitly.',
  );
  const generationId = generation._id;
  spend(generation.metadata);
  invariant(
    generation.revision === input.revision,
    'WORK_STALE',
    'Hosted Work changed. Your request remains available.',
  );
  const project: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.get, {
    projectId: input.projectId,
    owner,
  });
  const metadata = JSON.parse(generation.metadata) as IndexMetadata;
  const backup: { backup: Doc<'projectBackups'> } = await ctx.runQuery(internal.projectBackups.get, {
    id: generation.backupId,
    owner,
  });
  const keys = commandKeys(command, input);
  const rows: (IndexEntry | null)[] = [];
  for (let offset = 0; offset < keys.length; offset += 100)
    rows.push(
      ...counted(
        await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: input.projectId,
          owner,
          generationId,
          keys: keys.slice(offset, offset + 100),
        }),
      ),
    );
  await commandAliasRows(rows, async (collection, key) => {
    const result: (IndexEntry | null)[] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
      projectId: input.projectId,
      owner,
      generationId,
      keys: [{ collection, key }],
    });
    return counted(result)[0] ?? null;
  });
  if ([16, 18, 20, 22, 24].includes(metadata.schema)) {
    const lookup = async (keys: { collection: string; key: string }[]): Promise<(IndexEntry | null)[]> =>
      counted(
        await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: input.projectId,
          owner,
          generationId,
          keys,
        }),
      );
    await commandPayloadRows(rows, lookup);
    await commandPlanningRows(rows, command, lookup);
  }
  // Channels hydrate imported names. Unified commands hydrate selected attributes;
  // retained note/lifecycle rows remain independently paged.
  for (const row of rows)
    if (row && ['channelMoves', 'hostedChannels'].includes(row.collection)) {
      const header = JSON.parse(row.value);
      if (header.payload) {
        const chunks: string[] = [];
        let cursor: string | null = null;
        do {
          const page: { values: string[]; cursor: string | null } = await ctx.runQuery(
            internal.projectWorkIndexStore.payload,
            {
              projectId: input.projectId,
              owner,
              generationId,
              collection: row.collection,
              parent: header.payloadKey,
              cursor,
            },
          );
          for (const value of page.values) spend(value);
          chunks.push(...page.values);
          cursor = page.cursor;
        } while (cursor !== null);
        invariant(
          chunks.length === header.payloadParts,
          'WORK_STALE',
          'This Work record changed while reading it.',
        );
        row.value = chunks.join('');
      }
    }
  const unique = [
    ...new Map(
      rows.filter((row): row is IndexEntry => !!row).map(row => [`${row.collection}:${row.key}`, row]),
    ).values(),
  ];
  const values = (collection: string) => commandValues(unique, collection);
  const data = parseWork(
    {
      schema: metadata.schema,
      ...(metadata.intentMergeReceipt ? { intentMergeReceipt: metadata.intentMergeReceipt } : {}),
      revision: input.revision,
      ...(metadata.sourceKind === 'native' ? { nativeHead: metadata.sourceHead } : {}),
      intents: [],
      lanes: [],
      views: [],
    },
    true,
  );
  // Reducer inputs include selected headers and required attributes; retained histories stay separate.
  data.intents = values('intents');
  Object.assign(data, { intentAliases: values('intentAliases'), initiatives: values('initiatives') });
  data.views = values('views');
  data.channelMoves = values('channelMoves');
  data.hostedChannelMoves = values('hostedChannels');
  data.hostedEvents = values('events');
  data.planningItems = [...values('planningVersions'), ...values('planningItems')];
  data.planningComments = values('planningComments');
  const pins = values('sourcePins'),
    source =
      metadata.sourceKind === 'native'
        ? { head: metadata.sourceHead, states: pins.map(pin => pin.head as string) }
        : {
            head: metadata.sourceHead,
            refs: pins.map(pin => ({
              head: pin.head as string,
              ref: pin.key === pin.head ? '' : (pin.key as string).slice(0, -(pin.head.length + 1)),
            })),
          };
  const acceptance =
    command.action === 'accept-hosted-channel'
      ? await hooks!.acceptance(ctx, input.projectId, project, command)
      : undefined;
  if (command.action === 'accept-hosted-channel') {
    invariant(command.archiveSha256 === backup.backup.digest, 'WORK_STALE', 'Hosted source changed.');
    validateHostedChannel(data, command, source);
  } else validateMetadataSource(data, command, source);
  if (command.action === 'note' && command.anchor) {
    validateAnchorView(
      data.views.find(view => view.id === command.anchor!.viewId),
      values('intentAliases').find(alias => alias.aliasId === command.intentId)?.intentId ?? command.intentId,
      command.anchor,
    );
    await hooks!.sourceReview(
      ctx,
      {
        projectId: input.projectId,
        backupId: generation.backupId,
        ...command.anchor,
        anchor: command.anchor,
      },
      owner,
    );
  }
  return commandProjection(
    project,
    generation,
    backup.backup,
    input,
    owner,
    command,
    request,
    rows,
    acceptance,
  );
}
