// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// `put-planning-item {"batch":[…]}` (Item 65b0e706): the agent side of one backlog batch. Loaded only by that command.
// Each entry is a put (the same fields as a single put, model fields in `fields`) or, with "action":
// "comment-planning-item", a comment. Entries name full Item UUIDs, so a replay writes to the same Items; a creation
// may omit itemId and gets one retained in the journal. One mutation, projectPlanningBatch:apply, runs them all.
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { planningAuditFeature, planningWaitingFeature } from './hosted-contract-features.js';
import type { HostedAgentJournal } from './hosted-agent-journal.js';
import type { PlanningPort } from './hosted-agent-planning.js';
import {
  batchSentence,
  batchUndo,
  planningBatchLimit,
  type BatchResult,
  type BatchWrite,
} from './planning-batch.js';
import type * as PlanningTypes from './work-planning-types.js';

/** The planning schemas, handed in by the caller that already loads them, so this lazy module adds no shared chunk
 * to the eager command graph (tests/perf-harness.test.mjs module ceilings). */
export type BatchSchemas = Pick<
  typeof PlanningTypes,
  'planningCommentCommandSchema' | 'planningPutAgentFields' | 'planningPutSchema'
>;

const keys = ['planningItemId', 'id', 'itemId'] as const;
const full = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const entrySchemas = (schemas: BatchSchemas) => ({
  putEntry: schemas.planningPutSchema
    .omit({
      action: true,
      operationId: true,
      itemId: true,
      agent: true,
      agentClient: true,
      statusPinBy: true,
      statusPinRestore: true,
    })
    .extend({ fields: schemas.planningPutAgentFields.optional() })
    .strict(),
  commentEntry: schemas.planningCommentCommandSchema
    .pick({ text: true, authorLabel: true, replyTo: true })
    .strict(),
});

/** The entries as stored writes: ids checked, `fields` flattened, comments carrying the session's agent slug. */
async function batchWrites(
  port: PlanningPort,
  entries: Record<string, unknown>[],
  journal: HostedAgentJournal,
  schemas: BatchSchemas,
) {
  const { putEntry, commentEntry } = entrySchemas(schemas);
  invariant(
    entries.length >= 1 && entries.length <= planningBatchLimit,
    'BAD_ARGUMENT',
    `batch: 1 to ${planningBatchLimit} entries.`,
  );
  const writes: BatchWrite[] = [];
  for (const [index, raw] of entries.entries()) {
    const { action = 'put-planning-item', ...entry } = raw as { action?: string } & Record<string, unknown>;
    const named = keys.filter(key => entry[key] !== undefined);
    invariant(
      named.every(key => entry[key] === entry[named[0]!]),
      'BAD_ARGUMENT',
      `batch[${index}]: conflicting Item keys.`,
    );
    const given = named.length ? String(entry[named[0]!]).toLowerCase() : undefined;
    for (const key of keys) delete entry[key];
    invariant(
      given === undefined || full.test(given),
      'BAD_ARGUMENT',
      `batch[${index}]: name the Item by its full UUID (planning '{"search":"…"}' lists it).`,
    );
    if (action === 'comment-planning-item') {
      invariant(given, 'BAD_ARGUMENT', `batch[${index}]: a comment names its Item.`);
      const comment = commentEntry.parse(entry);
      writes.push({
        action,
        itemId: given,
        ...comment,
        authorLabel: comment.authorLabel || process.env.FORGE_AGENT_NAME || process.env.FORGE_ACTOR || '',
        ...port.commentAgent?.(),
      } as BatchWrite);
      continue;
    }
    invariant(
      action === 'put-planning-item',
      'BAD_ARGUMENT',
      `batch[${index}]: action is a put or a comment.`,
    );
    if (entry.kind === 'item') entry.kind = 'issue';
    const { fields, ...put } = putEntry.parse(entry);
    invariant(
      (fields?.waitingOn === undefined && put.waitingOn === undefined) ||
        port.serverFeatures?.includes(planningWaitingFeature),
      'HOSTED_ACTION_UNSUPPORTED',
      'This server does not store planning wait reasons yet.',
    );
    invariant(
      put.expectedVersion > 0 || (put.kind && put.title),
      'BAD_ARGUMENT',
      `batch[${index}]: creating an Item (expectedVersion 0) needs kind and title.`,
    );
    invariant(
      given || put.expectedVersion === 0,
      'BAD_ARGUMENT',
      `batch[${index}]: name the Item to change.`,
    );
    writes.push({
      action,
      itemId: given ?? (await journal.id(`batch-item-${index}`)),
      ...put,
      ...fields,
      ...(port.serverFeatures?.includes(planningAuditFeature) ? port.commentAgent?.() : undefined),
    } as BatchWrite);
  }
  return writes;
}

export async function hostedPlanningBatch(
  port: PlanningPort,
  entries: Record<string, unknown>[],
  journal: HostedAgentJournal,
  schemas: BatchSchemas,
) {
  if (!port.serverFeatures?.includes('planning-batch'))
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server does not run planning batches yet. Send each put-planning-item on its own, or again after the server deploys.',
    );
  const writes = await journal.retain('planning-batch-writes', () =>
    batchWrites(port, entries, journal, schemas),
  );
  const reply = await port
    .mutation<string>('projectPlanningBatch:apply', {
      operationId: journal.operationId,
      writes: JSON.stringify(writes),
    })
    .catch(error => {
      throw hostedActionError(error, 'planning batch');
    });
  const { results } = (typeof reply === 'string' ? JSON.parse(reply) : reply) as { results: BatchResult[] };
  const { undo, kept, unknown } = batchUndo(writes, results);
  return {
    results: results.map(({ before: _before, ...result }) => result),
    summary: batchSentence(results),
    // The one Undo is the same command with these entries (src/planning-batch.ts batchUndo).
    ...(undo.length
      ? {
          undo: {
            action: 'put-planning-item',
            input: { batch: undo.map(({ action: _action, ...put }) => put) },
          },
        }
      : {}),
    ...(kept ? { undoKeeps: `${kept} comment(s): comments are never deleted.` } : {}),
    ...(unknown
      ? {
          undoUnknown: `${unknown} write(s) replayed from an earlier call; read their versions to undo them.`,
        }
      : {}),
  };
}
