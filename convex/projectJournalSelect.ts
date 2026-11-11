// SPDX-License-Identifier: Apache-2.0
import { stream, type QueryStream } from 'convex-helpers/server/stream';
import schema from './schema';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { canonicalPayload, HOSTED_OPERATION_RETENTION_MS } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { coordinationJournalKey } from './projectJournalCoordinationRows';
import { journalGraceMs } from './projectJournalWake';
import {
  type JournalRunInput,
  type JournalRow,
  type Pending,
  type Group,
  type Proof,
} from './projectJournalMaintenance';
const size = (row: object) => new TextEncoder().encode(canonicalPayload(row)).length;
const headFor = (ctx: MutationCtx, row: Doc<'projectHostedRecords'>) =>
  ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', row.projectId).eq('kind', row.kind).eq('key', row.key),
    )
    .unique();
export async function selectJournal(
  ctx: MutationCtx,
  input: JournalRunInput,
  cursor: Pending['cursor'] = [],
) {
  const phase = input.phase ?? 0,
    now = Date.now();
  const future = new Map<string, { input: JournalRunInput; dueAt: number }>();
  const later = (phase: number, dueAt: number, laneId?: string) => {
    const at = Math.ceil(dueAt) + 1,
      key = `${phase}:${laneId ?? 'project'}`;
    if ((future.get(key)?.dueAt ?? Infinity) <= at) return;
    future.set(key, {
      input: {
        projectId: input.projectId,
        operationId: `eligibility:${key}:${at}`,
        phase,
        ...(laneId ? { laneId } : {}),
      },
      dueAt: at,
    });
  };
  const db = stream(ctx.db, schema);
  let source: QueryStream<JournalRow>;
  if (phase === 0 && !input.existing)
    source = db
      .query('projectHostedRecords')
      .withIndex('by_project_and_journal_ready_at', q =>
        q.eq('projectId', input.projectId).gte('journalReadyAt', 0).lte('journalReadyAt', now),
      );
  else if (phase === 0)
    source = db
      .query('projectHostedRecords')
      .withIndex('by_project', q => q.eq('projectId', input.projectId));
  else if (phase === 1 && !input.existing)
    source = db
      .query('projectHostedOperations')
      .withIndex('by_project_and_journal_ready_at', q =>
        q.eq('projectId', input.projectId).gte('journalReadyAt', 0).lte('journalReadyAt', now),
      );
  else if (phase === 1)
    source = db
      .query('projectHostedOperations')
      .withIndex('by_project', q => q.eq('projectId', input.projectId));
  else if (phase === 2 && input.laneId)
    source = db
      .query('projectHostedSavePages')
      .withIndex('by_project_and_journal_lane', q =>
        q.eq('projectId', input.projectId).eq('journalLaneId', input.laneId),
      );
  else if (phase === 2 && !input.existing) return { refs: [], proofs: [], groups: [], cursor, done: true };
  else if (phase === 2)
    source = db
      .query('projectHostedSavePages')
      .withIndex('by_project_and_actor_and_operation_and_index', q => q.eq('projectId', input.projectId));
  else if (phase === 3)
    source = db
      .query('projectHostedRecordBodies')
      .withIndex('by_project_and_revision', q => q.eq('projectId', input.projectId).gt('revision', 0));
  else
    source = db
      .query('projectCoordinationEvents')
      .withIndex('by_project', q => q.eq('projectId', input.projectId));
  if (cursor.length)
    source = source.narrow({
      lowerBound: cursor,
      lowerBoundInclusive: false,
      upperBound: [],
      upperBoundInclusive: true,
    });
  const refs: Pending['refs'] = [],
    proofs: Proof[] = [],
    groups: Group[] = [];
  let scanned = 0,
    bytes = 0,
    selectedBytes = 0,
    next = cursor,
    done = true;
  const add = (table: Pending['refs'][number]['table'], row: JournalRow) => {
    const index = refs.findIndex(ref => ref.id === row._id);
    if (index >= 0) return index;
    refs.push({ table, id: row._id, hash: digest(canonicalPayload(row)) });
    selectedBytes += size(row);
    return refs.length - 1;
  };
  for await (const [candidate, key] of source.iterWithKeys()) {
    if (!candidate) continue;
    const row = candidate;
    // Include related reads in the work budget. One provider document can exceed a page;
    // that single row is framed, never truncated, and no second candidate is read.
    if (scanned >= 100 || bytes >= 400 * 1024 || refs.length >= 98 || selectedBytes >= 48 * 1024) {
      done = false;
      break;
    }
    scanned++;
    bytes += size(row);
    let group: Group | undefined;
    const selected: [Pending['refs'][number]['table'], JournalRow][] = [];
    if (phase === 0) {
      const record = row as Doc<'projectHostedRecords'>;
      if (!record.journalSegment && !record.lifecyclePlanId) {
        const head = await headFor(ctx, record);
        if (head) bytes += size(head);
        if (head && head.recordId !== record._id) {
          const current = await ctx.db.get(head.recordId);
          if (current) bytes += size(current);
          const dueAt = record.journalReadyAt ?? (current?._creationTime ?? now) + journalGraceMs;
          if (dueAt > now) {
            if (!record.journalReadyAt) await ctx.db.patch(record._id, { journalReadyAt: dueAt });
            later(0, dueAt);
          } else {
            const body = await ctx.db.get(record.bodyId);
            if (body) bytes += size(body);
            const owners = await ctx.db
              .query('projectHostedRecords')
              .withIndex('by_project_and_body', q =>
                q.eq('projectId', input.projectId).eq('bodyId', record.bodyId),
              )
              .take(2);
            bytes += owners.reduce((n, item) => n + size(item), 0);
            invariant(
              record.inline !== undefined || body,
              'SOURCE_UNAVAILABLE',
              'Original record bytes are unavailable.',
            );
            selected.push(['projectHostedRecords', record]);
            if (body && !body.operationId && owners.length === 1)
              selected.push(['projectHostedRecordBodies', body]);
            proofs.push({ id: head._id, hash: digest(canonicalPayload(head)) });
            group = {
              category: 'record',
              scope: 'records',
              from: record.version,
              through: record.version,
              refs: [],
            };
          }
        }
      }
    } else if (phase === 1) {
      const operation = row as Doc<'projectHostedOperations'>;
      if (
        !operation.metricMutation &&
        (!operation.journalSegment || operation.journalReadyAt !== undefined)
      ) {
        const { expandOperationReceipt } = await import('../src/compact-operation-receipt');
        const value = expandOperationReceipt(operation);
        const expired = operation._creationTime < now - HOSTED_OPERATION_RETENTION_MS;
        const dueAt =
          operation.journalReadyAt ??
          (value.terminal
            ? Math.max(operation._creationTime, Date.parse(value.terminal.at)) + journalGraceMs
            : Infinity);
        if ((value.terminal && dueAt <= now) || (expired && !operation.journalReadyAt)) {
          selected.push(['projectHostedOperations', operation]);
          group = {
            category: 'operations',
            scope: 'operations',
            from: operation._creationTime,
            through: operation._creationTime,
            refs: [],
          };
        } else if (value.terminal && !operation.journalReadyAt) {
          await ctx.db.patch(operation._id, { journalReadyAt: dueAt });
          later(1, dueAt);
        }
      }
    } else if (phase === 2) {
      const page = row as Doc<'projectHostedSavePages'>;
      const save = await ctx.db
        .query('projectHostedSaves')
        .withIndex('by_project_and_actor_and_operation', q =>
          q.eq('projectId', input.projectId).eq('actor', page.actor).eq('operationId', page.operationId),
        )
        .unique();
      if (save) {
        bytes += size(save);
        const state = JSON.parse(save.value),
          laneId = state.request.laneId;
        if (!page.journalLaneId) await ctx.db.patch(page._id, { journalLaneId: laneId });
        const head = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_key', q =>
            q.eq('projectId', input.projectId).eq('kind', 'lane').eq('key', laneId),
          )
          .unique();
        if (head) bytes += size(head);
        const current = head ? await ctx.db.get(head.recordId) : null;
        if (current) bytes += size(current);
        if (head && current && ['completed', 'abandoned'].includes(head.status)) {
          const dueAt = current._creationTime + journalGraceMs;
          if (dueAt <= now && ['completed', 'stale', 'refused', 'failed'].includes(state.status)) {
            // Re-read after the derived Lane hint patch, so unknown outcomes reconcile exactly.
            selected.push(['projectHostedSavePages', { ...page, journalLaneId: laneId }]);
            proofs.push({ id: head._id, hash: digest(canonicalPayload(head)) });
            group = {
              category: 'save',
              scope: `save:${page.actor}:${page.operationId}`,
              from: page.index,
              through: page.index,
              refs: [],
            };
          } else if (dueAt > now) {
            later(2, dueAt, laneId);
            if (input.laneId) {
              done = true;
              break;
            }
          }
        }
      }
    } else if (phase === 3) {
      const body = row as Doc<'projectHostedRecordBodies'>;
      if (body.command && !body.journalSegment) {
        if (body._creationTime + journalGraceMs > now) {
          later(3, body._creationTime + journalGraceMs);
          done = true;
          break;
        }
        selected.push(['projectHostedRecordBodies', body]);
        group = {
          category: 'events',
          scope: 'events',
          from: body.revision!,
          through: body.revision!,
          refs: [],
        };
      }
    } else {
      const event = row as Doc<'projectCoordinationEvents'>;
      if (['activity', 'change', 'claim', 'release'].includes(event.command.kind)) {
        const dueAt = Math.max(event._creationTime, event.at) + 14 * 86_400_000;
        if (dueAt > now) {
          later(4, dueAt);
          done = true;
          break;
        }
        selected.push(['projectCoordinationEvents', event]);
        const position = coordinationJournalKey(input.projectId, [event._creationTime, event._id]);
        group = {
          category: 'coordination',
          scope: `coordination:${event.laneId ?? ''}:${event.intentId ?? ''}:${event.recipientActor ?? ''}`,
          from: event._creationTime,
          through: event._creationTime,
          startKey: position,
          endKey: position,
          keys: [position],
          refs: [],
          ...(event.laneId ? { laneId: event.laneId } : {}),
          ...(event.intentId ? { intentId: event.intentId } : {}),
          ...(event.recipientActor ? { recipientActor: event.recipientActor } : {}),
        };
      }
    }
    if (
      selected.length &&
      refs.length &&
      (refs.length + selected.length > 100 ||
        selectedBytes + selected.reduce((n, [, value]) => n + size(value), 0) > 48 * 1024)
    ) {
      done = false;
      break;
    }
    if (group) {
      group.refs = selected.map(([table, value]) => add(table, value));
      const previous = groups.at(-1);
      const contiguous = group.category === 'events' || group.category === 'save';
      if (previous?.scope === group.scope && (!contiguous || previous.through + 1 === group.from)) {
        previous.from = Math.min(previous.from, group.from);
        previous.through = Math.max(previous.through, group.through);
        previous.refs.push(...group.refs);
        if (group.keys) {
          previous.keys!.push(...group.keys);
          previous.endKey = group.endKey;
        }
      } else groups.push(group);
    }
    next = key.map(value => (value === undefined ? null : value)) as Pending['cursor'];
  }
  if (done && !input.existing && (phase === 0 || phase === 1)) {
    const [next] =
      phase === 0
        ? await ctx.db
            .query('projectHostedRecords')
            .withIndex('by_project_and_journal_ready_at', q =>
              q.eq('projectId', input.projectId).gt('journalReadyAt', now),
            )
            .take(1)
        : await ctx.db
            .query('projectHostedOperations')
            .withIndex('by_project_and_journal_ready_at', q =>
              q.eq('projectId', input.projectId).gt('journalReadyAt', now),
            )
            .take(1);
    if (next?.journalReadyAt !== undefined) later(phase, next.journalReadyAt);
  }
  return { refs, proofs, groups, cursor: next, done, future: [...future.values()] };
}
