// SPDX-License-Identifier: Apache-2.0
import { journalRecordPage } from './projectJournalRecordPage';
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { hostedRecordBody, readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedLaneSchema } from '../src/hosted-lane';
import { provenanceHistoryRequest } from '../src/hosted-provenance-schema';
import { invariant } from '../src/errors';
import { report } from './errors';
const PAGE = 20;

/** Source-version history includes syncs, unlike the Save-only index. One metadata query per
 * history page; at most 20 returned versions, O(page) indexed DB reads, no writes/wakes/idle.
 * State manifests and selected file bytes stay in R2. No Work-wide hydration or global revision. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: journalProvenanceRead,
});

/** Attribute only a source operation that actually wrote this Lane version. A reused State's first
 * registration alone never identifies this transition's author. No executor identity is invented. */
async function sourceOperation(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  lane: ReturnType<typeof hostedLaneSchema.parse>,
) {
  const state = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q => q.eq('projectId', projectId).eq('head', lane.head))
    .unique();
  if (!state) return null;
  for (const [table, kind] of [
    ['projectHostedSaves', 'checkpoint'],
    ['projectHostedSyncs', 'sync'],
  ] as const) {
    const row = await ctx.db
      .query(table)
      .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', state.jobId))
      .unique();
    if (!row) continue;
    const request = JSON.parse(row.value).request;
    if (request?.laneId === lane.id && request.expected?.version === lane.version - 1)
      return { kind, actor: row.actor, operationId: row.operationId, message: request.message };
  }
  return null;
}

export async function journalProvenanceRead(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; request: string },
) {
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Candidate provenance.');
    const command = provenanceHistoryRequest.parse(JSON.parse(input.request));
    const auth = { projectId: input.projectId, actor: user.subject };
    const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: command.candidateId });
    invariant(row, 'NOT_FOUND', 'Candidate not found on this project.');
    const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
    invariant(
      candidate.result.status === 'clean',
      'VIEW_CONFLICT',
      'Select a clean Candidate for file provenance.',
    );
    const histories = [];
    let historyBytes = 0;
    let remaining = PAGE,
      index = command.cursor?.index ?? 0;
    let nextCursor: { index: number; cursor: string | null } | null = null;
    invariant(index <= command.lanes.length, 'BAD_ARGUMENT', 'History cursor is beyond the selected inputs.');
    const intents = new Map<string, unknown>();
    for (; index < command.lanes.length && remaining > 0; index++) {
      const selected = command.lanes[index]!;
      const exact = await readHostedRecord(ctx, {
        ...auth,
        kind: 'lane',
        key: selected.laneId,
        version: selected.version,
      });
      invariant(exact, 'SOURCE_UNAVAILABLE', 'The pinned Lane version is unavailable.');
      const lane = hostedLaneSchema.parse(JSON.parse(exact.value));
      invariant(
        lane.head === selected.head && lane.sourceVersion === selected.sourceVersion,
        'WORK_STALE',
        'Continue the original pinned Candidate input.',
      );
      const cursor = index === command.cursor?.index ? command.cursor.cursor : null;
      const page = await journalRecordPage(ctx, {
        projectId: input.projectId,
        kind: 'lane',
        key: lane.id,
        through: lane.version,
        cursor,
        limit: remaining,
      });
      const versions = [];
      for (const version of page.page) {
        // Prepared lifecycle plans are not accepted historical source. Missing source versions are
        // disclosed by the client, never filled from an unrelated or later head.
        if (version.lifecyclePlanId) continue;
        const value = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, version)));
        versions.push({ lane: value, operation: await sourceOperation(ctx, input.projectId, value) });
      }
      let previous = null;
      const first = versions[0]?.lane;
      if (first && first.version > 0) {
        const prior = await readHostedRecord(ctx, {
          ...auth,
          kind: 'lane',
          key: lane.id,
          version: first.version - 1,
        });
        if (prior) previous = hostedLaneSchema.parse(JSON.parse(prior.value));
      }
      if (!intents.has(lane.intentId)) {
        const intent = await readHostedRecord(ctx, { ...auth, kind: 'intent', key: lane.intentId });
        const value = intent ? hostedRecordSchema.options[0].parse(JSON.parse(intent.value)) : null;
        const notes = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent_and_status', q =>
            q
              .eq('projectId', input.projectId)
              .eq('kind', 'comment')
              .eq('parent', lane.intentId)
              .eq('status', 'note'),
          )
          .take(21);
        const items = [];
        for (const note of notes.slice(0, 20)) {
          const record = await ctx.db.get(note.recordId);
          if (!record) continue;
          const body = JSON.parse(await hostedRecordBody(ctx, record));
          if (body.note)
            items.push({ id: note.key, ...body.note, text: String(body.note.text).slice(0, 500) });
        }
        intents.set(lane.intentId, {
          intentId: lane.intentId,
          outcome: value?.outcome ?? null,
          constraints: value?.constraints ?? null,
          notes: items,
          notesMore: notes.length > 20,
          scope: 'Current rationale; source history is pinned separately.',
        });
      }
      histories.push({ selected: lane, previous, versions, complete: cursor === null && page.isDone });
      historyBytes += new TextEncoder().encode(JSON.stringify(histories.at(-1))).length;
      remaining -= page.page.length;
      if (!page.isDone) {
        nextCursor = { index, cursor: page.continueCursor };
        break;
      }
      if (historyBytes >= 128 * 1024) {
        index++;
        if (index < command.lanes.length) nextCursor = { index, cursor: null };
        break;
      }
    }
    if (!nextCursor && index < command.lanes.length) nextCursor = { index, cursor: null };
    return JSON.stringify({ candidate, histories, why: [...intents.values()], nextCursor });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
