// SPDX-License-Identifier: Apache-2.0
// Pure: the reducer half of permanent deletion (Item 4c9e961e, purge Lane 1). Also runs in the Convex runtime.
import { invariant, itemChanged } from './errors.js';
import { refusePurged } from './work-planning-put.js';
import {
  PURGED_ITEM_TITLE,
  planningModelPutKeys,
  type PlanningItem,
  type PlanningPurge,
} from './work-planning-types.js';
import type { HostedEvent, WorkData } from './work-types.js';
import { purgeableCommandSchema, purgedFactsDigest, redactPlanningWrite } from './work-intent-types.js';
import { isUnifiedWork } from './work-unified-types.js';
import { planningTarget, type UnifiedPlanningData } from './work-planning-unified.js';

/**
 * Append the id-only tombstone for a purge. The Item must exist, be Deleted and be at `expectedVersion`, on the
 * first run and on every replay: a replay (index rebuild, export, local recovery) runs the Item's purged rows as
 * their redacted commands, so its versions, links and Intent are all there and only the words are gone. An Intent
 * copy of the Item is left alone here (purge Lane 3).
 */
export function applyPlanningPurge(
  data: WorkData,
  command: PlanningPurge,
  event: { id: string; at: string; actor: string; request: string },
) {
  const unified = isUnifiedWork(data) ? (data as unknown as UnifiedPlanningData) : undefined;
  const target = unified ? planningTarget(unified, command.itemId) : undefined;
  const historyId = target?.historyId ?? command.itemId;
  const current = data.planningItems.filter(item => item.id === historyId).at(-1);
  refusePurged(current);
  invariant(current, 'NOT_FOUND', 'Select an existing Item.');
  if (current.version !== command.expectedVersion)
    throw itemChanged({
      kind: command.kind,
      id: command.itemId,
      expectedVersion: command.expectedVersion,
      currentVersion: current.version,
    });
  invariant(
    current.status === 'deleted' && current.kind === command.kind,
    'BAD_ARGUMENT',
    'Only a Deleted Item can be deleted permanently. Delete it first; its text stays until then.',
  );
  const tombstone: PlanningItem = {
    id: historyId,
    operationId: event.id,
    request: event.request,
    version: command.expectedVersion + 1,
    previousVersion: command.expectedVersion,
    kind: command.kind,
    title: PURGED_ITEM_TITLE,
    body: '',
    status: 'deleted',
    intentIds: [],
    at: event.at,
    provenance: 'user-declared-local',
    purged: { operationId: event.id, deletedAt: command.deletedAt, by: event.actor },
  };
  scrubItemWords(data, historyId);
  data.planningItems.push(tombstone);
  const initiative = target?.initiative;
  if (initiative) {
    // Same in-place update a put makes, so selected-record callers see the tombstone and no stale field survives.
    for (const key of planningModelPutKeys) delete (initiative as Partial<PlanningItem>)[key];
    for (const key of ['was', 'reason', 'initiativeId', 'author'] as const)
      delete (initiative as Partial<PlanningItem>)[key];
    Object.assign(initiative, tombstone, { kind: 'initiative' });
  }
  return tombstone;
}

/** Replace the words of every retained version and comment of the Item in this Work, whatever wrote them (the base
 * checkpoint, a whole row of an unfinished purge, a purged row). This reaches a full replay (load, export, recovery);
 * the hosted projection and index rebuild hold only the rows a command loads, so their earlier versions are the purge
 * executor's to redact. Intent copy and notes are left to their own rows (and purge Lane 3). */
function scrubItemWords(data: WorkData, historyId: string) {
  for (const item of data.planningItems) {
    if (item.id !== historyId) continue;
    item.title = PURGED_ITEM_TITLE;
    item.body = '';
    for (const key of ['reason', 'type', 'owner', 'imported'] as const) delete item[key];
  }
  for (const comment of data.planningComments)
    if (comment.itemId === historyId) Object.assign(comment, { text: 'Deleted comment', authorLabel: '' });
}

/** The journal half of the one reader rule, for a whole journal in memory (export, local recovery). A purge lists
 * every row of its Item with the digest of its redacted facts, recorded while the rows were whole
 * (planning-purge-v2): each listed row comes earlier, and its facts, purged or still whole, redact to that digest.
 * Every purged row is listed by a later purge. The server's page readers check each purged row against its purge. */
export function checkPurgedJournal(events: readonly HostedEvent[]) {
  const purges = new Map<string, { at: number; rows: Map<string, string> }>();
  const listed = new Map<string, { at: number; digest: string }>();
  events.forEach((event, at) => {
    if (event.command.action !== 'purge-planning-item') return;
    const rows = new Map(event.command.rows);
    purges.set(event.id, { at, rows });
    for (const [row, digest] of rows) listed.set(row, { at, digest });
  });
  events.forEach((event, at) => {
    const command = event.command;
    let entry: { at: number; digest: string | undefined } | undefined, facts;
    if (command.action === 'purged-planning-row') {
      const purge = purges.get(command.purgeOperationId);
      entry = purge && { at: purge.at, digest: purge.rows.get(event.id) };
      facts = command.command;
    } else {
      entry = listed.get(event.id);
      if (!entry) return;
      facts = purgeableCommandSchema.safeParse(command).data;
    }
    invariant(
      entry &&
        entry.at > at &&
        facts !== undefined &&
        purgedFactsDigest(redactPlanningWrite(facts)) === entry.digest &&
        (!('operationId' in facts) || facts.operationId === event.id),
      'INVALID_WORK_JOURNAL',
      'A purged Work row names no later purge of its Item.',
    );
  });
}
