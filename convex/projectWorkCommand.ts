// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { findWorkEvent } from './projectWorkEventStore';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { parseWork } from '../src/work-unified-types';
import { commandPayloadRows, commandPlanningRows, commandValues } from './projectWorkCommandRows';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { hostedWorkEventDocument } from './schema';
import { metadataCommandSchema } from '../src/work-intent-types';
import {
  planningCommentPurgeSchema,
  planningPurgeSchema,
  isShelved,
  type PlanningItem,
} from '../src/work-planning-types';
import { hostedRecordSchema } from '../src/hosted-records';
import { metadataRequest, validateMetadataSource } from '../src/work-metadata';
import { invariant } from '../src/errors';
import { serverCommentWriter, serverPutWriter } from './planningCommentWriter';
import { report } from './errors';
import { activeProject } from './projectAuthority';
import { clearAuditVersions } from './projectPlanningAuditWindow';
import { planningTarget } from '../src/work-planning-unified';
import { wakePlanWrite } from './projectPlanRollupWake';
import { publicActorLabel } from './publicPeople';
import { memberCreationUndo, memberPlanningTarget, memberPlanningWrite } from './projectPlanningWriteAccess';
import { intentAuthority } from './projectContributors';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { generationHead } from './projectWorkHead';
import type { PlanningWriteContext } from './projectWorkCommandContext';
import { commandKeys, commandProjection, commandAliasRows } from './projectWorkProjection';
import { appendWork } from './projectWork';
import { commutativeCommand } from './projectWorkCommandRun';
import { internalMutation } from './server';
import { isItemRetentionOperation, itemRetentionOperation } from './projectItemRetentionStore';
import { decisionActor, decisionOperationId } from '../src/work-planning-put';
import { planningParent, restoredTopLevelNotice } from './projectPlanningParent';
import { workRecordTable } from './projectWorkRecordTables';
import { digest } from '../src/state/hash';
import { logIoAttribution } from './ioAttribution';

const legacyStatusMessage =
  'The server now follows Work status. Update Forge; planning reads no longer move Items.';
const legacyStatusOperation = (itemId: string, version: number, suffix: string) => {
  const h = digest(`${itemId}:${version}:${suffix}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Commands this revision-free mutation runs. A planning put (flip 5 S5) checks only its item version
 * (ITEM_CHANGED); the project revision is read in the same transaction, so an unrelated write never
 * refuses it. Anchored notes and Channel acceptance need Node-only readers and stay in the action. */
export async function executeCommand(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; command: string },
  actor?: string,
  options: {
    purge?: true;
    planning?: PlanningWriteContext | undefined;
    ownerBatch?: (project: Doc<'hostedProjects'>) => Promise<PlanningWriteContext>;
    /** A start has already checked that this generation is ready, in the same transaction. */
    startGeneration?: NonNullable<Awaited<ReturnType<typeof selectedGeneration>>>;
    planningClose?: string | undefined;
    planningRestore?: string | undefined;
    /** The reviewed import endpoint replays source hierarchy, even before a later page creates its parent. */
    planningImport?: true;
    planningTick?: true;
    /** Trusted parent-move notes have fixed server text and the project as their author. */
    planningMoveNote?: true;
    /** The worker itself owns the continuation after this Version. */
    fromRollup?: true;
    /** Only the retained close receipt selects a version other than the immediate predecessor. */
    undoClosePins?: true;
    onPlanningBatchState?: (
      state: ({ replayed: true } | { before: PlanningItem | null }) & { notice?: string },
    ) => void;
    /** A server job writing as the owner, or a close cascade's derived child write: exempt from the account limiter (convex/accountLimits.ts). */
    server?: true;
  } = {},
) {
  // Only trusted internal actions supply actor (scheduled budget Issues have no user session).
  const user = actor ? { subject: actor } : await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  const project = options.planning?.project ?? (await activeProject(ctx, input.projectId, user.subject));
  let parsed;
  let assertsRestore = false;
  let assertsSource = false;
  try {
    // The server's purge steps send only a purge (an Item's or one comment's); every other caller only client
    // commands, never a purge.
    const raw = JSON.parse(input.command);
    assertsRestore = raw?.action === 'put-planning-item' && raw.restoredTopLevel !== undefined;
    assertsSource = raw?.action === 'put-planning-item' && raw.statusSource !== undefined;
    parsed = (
      !options.purge
        ? metadataCommandSchema
        : raw?.action === 'purge-planning-comment'
          ? planningCommentPurgeSchema
          : planningPurgeSchema
    ).safeParse(raw);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  }
  invariant(parsed.success, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  invariant(!assertsRestore, 'BAD_ARGUMENT', 'Only Forge marks a restore top level.');
  invariant(!assertsSource, 'BAD_ARGUMENT', 'Only Forge attributes an automatic status.');
  const command: typeof parsed.data & { restoredTopLevel?: true; statusSource?: 'work' } = parsed.data;
  invariant(commutativeCommand(command), 'BAD_ARGUMENT', 'Use the pinned action for this Work command.');
  invariant(
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
    'BAD_ARGUMENT',
    'Use an original Work operation UUID.',
  );
  const member = project.owner !== user.subject;
  let rawPutRequest: string | undefined;
  let rawPutCommand: string | undefined;
  if (
    command.action === 'comment-planning-item' ||
    command.action === 'put-planning-item' ||
    command.action === 'purge-planning-item' ||
    command.action === 'purge-planning-comment'
  ) {
    invariant(
      !member ||
        (!options.planning &&
          (command.action === 'put-planning-item' || command.action === 'comment-planning-item') &&
          memberPlanningWrite(command, Boolean(options.planningTick))),
      'PROJECT_UNAVAILABLE',
      'This planning change is available only to the project owner.',
    );
    invariant(
      command.operationId === input.operationId,
      'BAD_ARGUMENT',
      'Use the planning command’s original operation UUID.',
    );
    // The writer, its agent marker and a decision's body line come from the sign-in, never from client text.
    if (command.action === 'comment-planning-item') {
      invariant(
        !command.line || options.planningTick,
        'BAD_ARGUMENT',
        'Post line evidence with its Done-when tick.',
      );
      if (!options.planningMoveNote) await serverCommentWriter(ctx, command, project);
    }
    if (command.action === 'put-planning-item') {
      invariant(
        command.statusPinBy === undefined && command.statusPinRestore === undefined,
        'BAD_ARGUMENT',
        'Pin attribution comes from the signed-in writer.',
      );
      invariant(
        !command.statusPinUndo || (options.onPlanningBatchState && command.statusPin === undefined),
        'BAD_ARGUMENT',
        'Restore a previous pin through a versioned batch Undo.',
      );
      invariant(
        command.statusPin !== null || command.expectedVersion > 0,
        'BAD_ARGUMENT',
        'Select the current version of an existing planning Item to clear its pin.',
      );
      if (command.agent === undefined && command.agentClient === undefined) {
        rawPutCommand = JSON.stringify(command);
        rawPutRequest = metadataRequest(command);
      }
      await serverPutWriter(ctx, command);
    }
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
  let original;
  try {
    original = await findWorkEvent(ctx, input.projectId, input.operationId, {
      command: JSON.stringify(command),
    });
  } catch (error) {
    if (
      rawPutCommand === undefined ||
      rawPutRequest === request ||
      !(error instanceof Error) ||
      ((error as { data?: { code?: string }; code?: string }).data?.code !== 'WORK_OPERATION_CHANGED' &&
        (error as { code?: string }).code !== 'WORK_OPERATION_CHANGED')
    )
      throw error;
    original = await findWorkEvent(ctx, input.projectId, input.operationId, {
      command: rawPutCommand,
    });
  }
  if (original) {
    invariant(
      original.actor === user.subject &&
        (original.request === request || (rawPutRequest !== undefined && original.request === rawPutRequest)),
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command.',
    );
    const restored = command.action === 'put-planning-item' && JSON.parse(original.command).restoredTopLevel;
    options.onPlanningBatchState?.({
      replayed: true,
      ...(restored ? { notice: restoredTopLevelNotice } : {}),
    });
    return original;
  }
  // Older CLI/MCP reads and final ticks issued deterministic status/hold writes. Do not bypass
  // current children, pin or linked Work facts. Historical retries returned above.
  if (command.action === 'put-planning-item') {
    invariant(
      !(
        (command.status === 'closed' || command.status === 'abandoned') &&
        command.operationId === legacyStatusOperation(command.itemId, command.expectedVersion, command.status)
      ) && command.operationId !== legacyStatusOperation(command.itemId, command.expectedVersion, 'held'),
      'HOSTED_ACTION_UNSUPPORTED',
      legacyStatusMessage,
    );
    if (options.fromRollup) command.statusSource = 'work';
  } else if (
    command.action === 'comment-planning-item' &&
    /^Intent completed; \d+ Done-when line\(s\) still open, so this Issue stays open\. Open: /.test(
      command.text,
    ) &&
    command.text.endsWith(
      `Tick each line with its evidence: nforge agent . tick-planning-item '{"planningItemId":"${command.itemId}","line":1,"evidence":"…"}' (line: the checkbox's position or a unique text prefix); the last tick closes the Issue.`,
    )
  ) {
    // These old comments carry no expectedVersion; even a stale one has the same generated text envelope.
    invariant(false, 'HOSTED_ACTION_UNSUPPORTED', legacyStatusMessage);
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
  const planning = options.planning ?? (member ? undefined : await options.ownerBatch?.(project));
  const selected = planning?.selected ?? options.startGeneration ?? (await selectedGeneration(ctx, project));
  invariant(selected, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before writing.');
  const generation = planning?.generation ?? (await generationHead(ctx, selected));
  const backup = planning?.backup ?? (await ctx.db.get(generation.backupId));
  invariant(
    backup?.projectId === project._id && backup.status === 'stored',
    'PROJECT_UNAVAILABLE',
    'Select this project’s stored source.',
  );
  const load = (collection: string, key: string) =>
    planning?.record(collection, key) ?? record(ctx, recordPartition(generation), collection, key);
  const lookup = (keys: { collection: string; key: string }[]) =>
    Promise.all(keys.map(key => load(key.collection, key.key)));
  const rows = await lookup(commandKeys(command, input));
  if (member && command.action === 'put-planning-item' && command.expectedVersion === 0) {
    // commandKeys already read all four identities the reducer can resolve this Item ID through.
    invariant(
      !rows.some(
        row =>
          row?.key === command.itemId &&
          ['intents', 'intentAliases', 'initiatives', 'planningItems'].includes(row.collection),
      ),
      'PROJECT_UNAVAILABLE',
      'Capture requires a new Item ID.',
    );
  }
  await commandAliasRows(rows, load);
  const unified = [16, 18, 20, 22, 24].includes(JSON.parse(generation.metadata).schema);
  if (unified) {
    await commandPayloadRows(rows, lookup);
    await commandPlanningRows(rows, command, lookup);
  }
  if (
    member &&
    (command.action === 'comment-planning-item' ||
      (command.action === 'put-planning-item' && command.expectedVersion > 0))
  ) {
    const target = unified
      ? planningTarget(
          {
            intents: commandValues(rows, 'intents'),
            initiatives: commandValues(rows, 'initiatives'),
            intentAliases: commandValues(rows, 'intentAliases'),
          },
          command.itemId,
        )
      : undefined;
    const current = commandValues(rows, 'planningItems').find(item => item.id === command.itemId);
    invariant(
      (!target || (target.intent && target.historyId === command.itemId)) &&
        memberPlanningTarget(current) &&
        (command.action !== 'put-planning-item' ||
          !memberCreationUndo(command) ||
          (current?.parentId && current.author === user.subject && !target?.intent?.base)),
      'PROJECT_UNAVAILABLE',
      'Select an existing Item that is not archived or deleted.',
    );
  }
  let batchBefore: PlanningItem | null = null;
  if (options.onPlanningBatchState && command.action === 'put-planning-item' && command.expectedVersion > 0) {
    // Undo captures the exact previous Item the versioned command already loaded.
    const previous = rows.filter(
      row =>
        row?.key === command.itemId && ['planningItems', 'planningItems:attributes'].includes(row.collection),
    );
    if (!unified) await commandPayloadRows(previous, lookup);
    batchBefore = commandValues(previous, 'planningItems')[0] ?? null;
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
  const planBefore =
    command.action === 'put-planning-item'
      ? commandValues(rows, 'planningItems').find(item => item.id === command.itemId)
      : undefined;
  if (command.action === 'put-planning-item' && command.statusPinUndo) {
    invariant(
      planBefore && planBefore.version === command.expectedVersion,
      'ITEM_CHANGED',
      'The Item changed after the batch. Nothing was undone.',
    );
    const priorRow = await load('planningVersions', command.statusPinUndo);
    const priorRows = [priorRow];
    await commandPayloadRows(priorRows, lookup);
    const previous = commandValues(priorRows, 'planningVersions')[0] as PlanningItem | undefined;
    invariant(
      previous &&
        previous.id === planBefore.id &&
        previous.status === (command.status ?? planBefore.status) &&
        (options.undoClosePins
          ? previous.version < planBefore.version
          : previous.version === planBefore.version - 1),
      'BAD_ARGUMENT',
      'Undo can restore only the selected Item’s previous status and pin.',
    );
    command.statusPinRestore = previous.statusPin ?? null;
  }
  if (
    command.action === 'put-planning-item' &&
    command.status &&
    command.statusPinUndo === undefined &&
    !isShelved(command.status) &&
    command.statusPin !== null &&
    (!options.server || options.planningClose)
  ) {
    if (
      planBefore &&
      !isShelved(planBefore.status) &&
      planBefore.status !== command.status &&
      planBefore.version === command.expectedVersion
    )
      command.statusPinBy =
        decisionActor(await publicActorLabel(ctx, user.subject, command.agent, true)) || 'member';
  }
  const revision = generation.revision;
  const projectCommand = () =>
    commandProjection(
      project,
      generation,
      backup,
      { ...input, revision },
      user.subject,
      command,
      request,
      rows,
    );
  let projection = projectCommand();
  let notice: string | undefined;
  const put = command.action === 'put-planning-item' ? command : null;
  const target =
    put && (put.parentId !== undefined || put.status !== undefined)
      ? projection.entries.find(entry => entry.collection === 'planningItems')
      : undefined;
  const before = target
    ? commandValues(rows, 'planningItems').find(item => item.id === target.key)
    : undefined;
  // Trusted import and close Undo preserve retained hierarchy. They do not take a new parent from an Item edit.
  const imported = options.planningImport && put?.expectedVersion === 0 && put.imported;
  if (put && target && !options.planningRestore && !imported) {
    const after = JSON.parse(target.value) as PlanningItem;
    notice = await planningParent(
      ctx,
      recordPartition(generation),
      before,
      after,
      load,
      member && Boolean(put.parentId),
    );
    if (notice) {
      // Journal the derived fact so a rebuild makes the same choice without changing the request identity.
      put.restoredTopLevel = true;
      projection = projectCommand();
    }
  }
  if (put && options.onPlanningBatchState)
    options.onPlanningBatchState({ before: batchBefore, ...(notice ? { notice } : {}) });
  if (command.action === 'put-planning-item' && command.status !== undefined) {
    // The reducer can redirect an alias to its current Item. Check the row it
    // actually plans to publish, using the header this command already read.
    const locked = rows.find(
      row =>
        row?.collection === 'planningItems' &&
        row.key === target?.key &&
        'planningClose' in row &&
        row.planningClose !== undefined &&
        row.planningClose !== options.planningClose,
    );
    invariant(
      !locked,
      'HOSTED_CONFLICT',
      'The parent close or Undo is still applying. Retry this change after it finishes.',
    );
  }
  const current = member ? before : undefined;
  const shift =
    member &&
    command.action === 'put-planning-item' &&
    command.expectedVersion > 0 &&
    command.parentId !== undefined &&
    command.initiativeId !== undefined
      ? command.initiativeId !== (current?.initiativeId ?? null)
      : false;
  if (shift && command.action === 'put-planning-item' && !command.parentId) {
    // A clear cannot move an Item between Initiatives. Its one exception is a versioned
    // Undo of the preceding parent change, restoring the exact former membership.
    const partition = recordPartition(generation);
    const recent = await ctx.db
      .query(await workRecordTable(ctx, partition, 'planningVersions'))
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q.eq('generationId', partition).eq('collection', 'planningVersions').eq('parent', command.itemId),
      )
      .order('desc')
      .take(2);
    const previous = recent[1]
      ? (JSON.parse(recent[1].value) as PlanningItem & { payloadKey?: string })
      : undefined;
    invariant(
      current?.parentId &&
        previous &&
        previous.version === current.version - 1 &&
        !previous.parentId &&
        (previous.initiativeId ?? null) === command.initiativeId,
      'BAD_ARGUMENT',
      'Clearing a parent keeps the Item in its current Initiative.',
    );
  }
  const event = await appendWork(ctx, {
    ...input,
    owner: user.subject,
    request,
    previousRevision: revision,
    command: JSON.stringify(command),
    projection,
    planning,
    planningRestore: options.planningRestore,
    ...(member && (command.action === 'put-planning-item' || command.action === 'comment-planning-item')
      ? { memberPlanning: options.planningTick ? ('tick' as const) : ('item' as const) }
      : {}),
    ...(options.server ? { server: true as const } : {}),
  });
  const planned =
    !options.fromRollup &&
    !options.planningImport &&
    command.action === 'put-planning-item' &&
    projection.entries.find(entry => entry.collection === 'planningItems');
  if (planned && planned.value)
    await wakePlanWrite(
      ctx,
      {
        projectId: input.projectId,
        partition: recordPartition(generation),
        cause: input.operationId,
      },
      planBefore,
      JSON.parse(planned.value),
    );
  if (command.action === 'purge-planning-item') {
    const itemId = projection.entries.find(entry => entry.collection === 'planningVersions')?.parent;
    // Keep the tombstone and erasure of all derived excerpts in the same mutation.
    if (itemId) await clearAuditVersions(ctx, input.projectId, itemId);
  }
  if (shift && current && command.action === 'put-planning-item') {
    // A writer can move an Item to its parent's Initiative but cannot post arbitrary Initiative comments.
    const initiatives = commandValues(rows, 'initiatives') as PlanningItem[];
    const from = initiatives.find(item => item.id === current.initiativeId);
    const to = initiatives.find(item => item.id === command.initiativeId);
    const title = `${current.title.slice(0, 400)} (${current.id.slice(0, 8)})`;
    const note = async (item: PlanningItem, text: string, seed: string) => {
      const operationId = decisionOperationId(seed);
      try {
        await executeCommand(
          ctx,
          {
            projectId: input.projectId,
            operationId,
            command: JSON.stringify({
              action: 'comment-planning-item',
              itemId: item.id,
              operationId,
              text,
              authorLabel: 'Forge',
            }),
          },
          project.owner,
          { server: true, planningMoveNote: true },
        );
      } catch {
        // Never leave a move committed without its notices, including inside a partial-write batch.
        invariant(
          false,
          'WORK_CONFLICT',
          'The move and its Initiative notes could not be saved. Nothing moved.',
        );
      }
    };
    if (from && !from.purged)
      await note(
        from,
        `Moved out to ${to?.title.slice(0, 400) ?? 'No Initiative'}: ${title}.`,
        `${input.operationId}:out`,
      );
    if (to && !to.purged) await note(to, `Moved in: ${title}.`, `${input.operationId}:in`);
  }
  return event;
}
export const command = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), command: v.string() },
  returns: hostedWorkEventDocument,
  handler: async (ctx, input) => {
    try {
      const result = await executeCommand(ctx, input);
      // The reducer has already validated the action. A telemetry parse must not affect the write.
      let mode = 'unknown';
      try {
        const action: unknown = JSON.parse(input.command)?.action;
        if (typeof action === 'string') mode = action;
      } catch {
        // Keep the successful write even if the telemetry payload cannot be read.
      }
      await logIoAttribution(ctx, `work-command/${mode}`);
      return result;
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
    /** Set only by server jobs writing as the owner (projectOwnerPlanning). */
    server: v.optional(v.literal(true)),
  },
  returns: hostedWorkEventDocument,
  handler: async (ctx, { owner, server, ...input }) => {
    try {
      return await executeCommand(ctx, input, owner, server ? { server } : {});
    } catch (error) {
      return report(error);
    }
  },
});
