// SPDX-License-Identifier: Apache-2.0
import { findWorkEvent } from './projectWorkEventStore';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { parseWork } from '../src/work-unified-types';
import { commandPayloadRows, commandPlanningRows, commandValues } from './projectWorkCommandRows';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { hostedWorkEventDocument } from './schema';
import { metadataCommandSchema } from '../src/work-intent-types';
import { planningPurgeSchema } from '../src/work-planning-types';
import { hostedRecordSchema } from '../src/hosted-records';
import { metadataRequest, validateMetadataSource } from '../src/work-metadata';
import { invariant } from '../src/errors';
import { serverCommentWriter } from './planningCommentWriter';
import { report } from './errors';
import { activeProject } from './projectAuthority';
import { intentAuthority } from './projectContributors';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { generationHead } from './projectWorkHead';
import { commandKeys, commandProjection, commandAliasRows } from './projectWorkProjection';
import { appendWork } from './projectWork';
import { commutativeCommand } from './projectWorkCommandRun';
import { internalMutation } from './server';
import { isItemRetentionOperation, itemRetentionOperation } from './projectItemRetentionStore';

/** Commands this revision-free mutation runs. A planning put (flip 5 S5) checks only its item version
 * (ITEM_CHANGED); the project revision is read in the same transaction, so an unrelated write never
 * refuses it. Anchored notes and Channel acceptance need Node-only readers and stay in the action. */
export async function executeCommand(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; command: string },
  actor?: string,
  options: { purge?: true } = {},
) {
  // Only trusted internal actions supply actor (scheduled budget Issues have no user session).
  const user = actor ? { subject: actor } : await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  const project = await activeProject(ctx, input.projectId, user.subject);
  let parsed;
  try {
    // The server's purge step sends only a purge; every other caller only client commands, never a purge.
    parsed = (options.purge ? planningPurgeSchema : metadataCommandSchema).safeParse(
      JSON.parse(input.command),
    );
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  }
  invariant(parsed.success, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  const command = parsed.data;
  invariant(commutativeCommand(command), 'BAD_ARGUMENT', 'Use the pinned action for this Work command.');
  invariant(
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
    'BAD_ARGUMENT',
    'Use an original Work operation UUID.',
  );
  if (
    command.action === 'comment-planning-item' ||
    command.action === 'put-planning-item' ||
    command.action === 'purge-planning-item'
  ) {
    invariant(
      project.owner === user.subject,
      'PROJECT_UNAVAILABLE',
      'Project planning is available to its current owner.',
    );
    invariant(
      command.operationId === input.operationId,
      'BAD_ARGUMENT',
      'Use the planning command’s original operation UUID.',
    );
    // The writer, its agent marker and a decision's body line come from the sign-in, never from client text.
    if (command.action === 'comment-planning-item') await serverCommentWriter(ctx, command);
  } else if (project.owner !== user.subject && command.action !== 'intent' && 'intentId' in command) {
    await intentAuthority(ctx, input.projectId, user.subject, command.intentId);
  }
  if (command.action === 'purge-planning-item' && isItemRetentionOperation(command.operationId))
    invariant(
      command.operationId ===
        itemRetentionOperation(input.projectId, command.itemId, command.expectedVersion),
      'ITEM_CHANGED',
      'The Deleted Item changed after this purge was selected.',
    );
  const request = metadataRequest(command);
  const original = await findWorkEvent(ctx, input.projectId, input.operationId, {
    command: JSON.stringify(command),
  });
  if (original) {
    invariant(
      original.actor === user.subject && original.request === request,
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command.',
    );
    return original;
  }
  // Recovery notices belong to canonical hosted Intents, while this endpoint also updates Work.
  // Keep both writes in this mutation, after the original-operation replay guard above.
  if (
    command.action === 'intent-status' &&
    command.status === 'abandoned' &&
    project.needsFix?.[command.intentId] &&
    project.sourceAuthority &&
    project.sourceAuthority.mode !== 'native-owner'
  ) {
    const row = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: user.subject,
      kind: 'intent',
      key: command.intentId,
    });
    invariant(row, 'NOT_FOUND', 'The recovery Intent is unavailable.');
    const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor: user.subject,
      authorityEpoch: project.sourceAuthority.epoch,
      expectedVersion: intent.version,
      record: { ...intent, version: intent.version + 1, status: command.status },
    });
  }
  const selected = await selectedGeneration(ctx, project);
  invariant(selected, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before writing.');
  const generation = await generationHead(ctx, selected);
  const backup = await ctx.db.get(generation.backupId);
  invariant(
    backup?.projectId === project._id && backup.status === 'stored',
    'PROJECT_UNAVAILABLE',
    'Select this project’s stored source.',
  );
  const rows = await Promise.all(
    commandKeys(command, input).map(key => record(ctx, recordPartition(generation), key.collection, key.key)),
  );
  await commandAliasRows(rows, (collection, key) =>
    record(ctx, recordPartition(generation), collection, key),
  );
  if ([16, 18, 20, 22, 24].includes(JSON.parse(generation.metadata).schema)) {
    const lookup = (keys: { collection: string; key: string }[]) =>
      Promise.all(keys.map(key => record(ctx, recordPartition(generation), key.collection, key.key)));
    await commandPayloadRows(rows, lookup);
    await commandPlanningRows(rows, command, lookup);
  }
  if (
    command.action === 'put-planning-item' &&
    command.imported &&
    process.env.FORGE_PLANNING_IMPORTS !== '1'
  ) {
    await commandPayloadRows(rows, keys =>
      Promise.all(keys.map(key => record(ctx, recordPartition(generation), key.collection, key.key))),
    );
    const imported = commandValues(rows, 'planningItems').find(item => item.id === command.itemId)?.imported;
    invariant(
      imported &&
        Object.keys(imported).length === Object.keys(command.imported).length &&
        Object.entries(command.imported).every(([key, value]) => imported[key] === value),
      'HOSTED_ACTION_UNSUPPORTED',
      'Backlog imports are not enabled on this deployment yet.',
    );
  }
  // Imported Channel names can live in retained payload chunks. Creation uses
  // exact values, matching the existing action's source-pin validation.
  for (const row of rows)
    if (row && ['channelMoves', 'hostedChannels'].includes(row.collection)) {
      const header = JSON.parse(row.value);
      if (header.payload) {
        const chunks: string[] = [];
        for (let part = 0; part < header.payloadParts; part++) {
          const chunk = await record(
            ctx,
            recordPartition(generation),
            `${row.collection}:payload`,
            `${header.payloadKey}:${part}`,
          );
          invariant(chunk, 'WORK_STALE', 'This Work record changed while reading it.');
          chunks.push(chunk.value);
        }
        row.value = chunks.join('');
      }
    }
  // Creation validates the same retained pins as the pinned action. Other commands need only their target header.
  const metadata = JSON.parse(generation.metadata);
  const data = parseWork(
    {
      schema: metadata.schema,
      ...(metadata.intentMergeReceipt ? { intentMergeReceipt: metadata.intentMergeReceipt } : {}),
      revision: generation.revision,
      intents: [],
      lanes: [],
      views: [],
    },
    true,
  );
  data.channelMoves = rows.filter(r => r?.collection === 'channelMoves').map(r => JSON.parse(r!.value));
  data.hostedChannelMoves = rows
    .filter(r => r?.collection === 'hostedChannels')
    .map(r => JSON.parse(r!.value));
  const pins = rows.filter(r => r?.collection === 'sourcePins').map(r => JSON.parse(r!.value));
  validateMetadataSource(
    data,
    command,
    metadata.sourceKind === 'native'
      ? { head: metadata.sourceHead, states: pins.map(pin => pin.head) }
      : {
          head: metadata.sourceHead,
          refs: pins.map(pin => ({
            head: pin.head,
            ref: pin.key === pin.head ? '' : pin.key.slice(0, -(pin.head.length + 1)),
          })),
        },
  );
  const revision = generation.revision;
  const projection = commandProjection(
    project,
    generation,
    backup,
    { ...input, revision },
    user.subject,
    command,
    request,
    rows,
  );
  return appendWork(ctx, {
    ...input,
    owner: user.subject,
    request,
    previousRevision: revision,
    command: JSON.stringify(command),
    projection,
  });
}
export const command = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), command: v.string() },
  returns: hostedWorkEventDocument,
  handler: async (ctx, input) => {
    try {
      return await executeCommand(ctx, input);
    } catch (error) {
      return report(error);
    }
  },
});

/** The server's purge step (Item 4c9e961e): appends a purge-planning-item and the Item's id-only tombstone in one
 * mutation, as the project owner. Internal only: no client entry accepts a purge. */
export const purgeFromServer = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    command: v.string(),
    owner: v.string(),
  },
  returns: hostedWorkEventDocument,
  handler: async (ctx, { owner, ...input }) => {
    try {
      return await executeCommand(ctx, input, owner, { purge: true });
    } catch (error) {
      return report(error);
    }
  },
});

/** Older action clients and scheduled commands share the same atomic reducer. The action has
 * already resolved its actor; access is checked again here before original-operation reconciliation. */
export const commandFromAction = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    command: v.string(),
    owner: v.string(),
  },
  returns: hostedWorkEventDocument,
  handler: async (ctx, { owner, ...input }) => {
    try {
      return await executeCommand(ctx, input, owner);
    } catch (error) {
      return report(error);
    }
  },
});
