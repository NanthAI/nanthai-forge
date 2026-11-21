// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { JournalIndex } from '../src/journal-segment';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './server';
import { landingCapsulePointer } from './projectLandingCapsuleFields';
import { purgeRows, type ItemPurge } from './projectPlanningPurgeRedact';
import { purgeIntentChain } from './projectPlanningPurgeSelect';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { indexedSweepPage } from './projectPlanningArchiveSweep';
import { archiveSegmentRow } from './projectPlanningArchiveIndex';

export const purgeSegmentIdentity = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
};

const claimed = { ...purgeSegmentIdentity, claim: v.string() };
type Identity = { projectId: Id<'hostedProjects'>; operationId: string };
type Sweep = NonNullable<ItemPurge['segmentSweep']>;

async function sweepEntry(ctx: MutationCtx, input: Identity) {
  const project = await ctx.db.get(input.projectId);
  const purges = project?.itemPurges ?? [];
  const purge = purges.find(entry => entry.operationId === input.operationId);
  invariant(project && !project.removal && purge, 'NOT_FOUND', 'Select a started Item purge.');
  const sweep: Sweep = purge.segmentSweep ?? { after: null, done: false };
  return {
    project,
    purge,
    purges,
    sweep,
    save: (next: Sweep, rewrite?: 'events' | 'record') =>
      ctx.db.patch(input.projectId, {
        itemPurges: purges.map(entry => (entry === purge ? { ...purge, segmentSweep: next } : entry)),
        ...(rewrite ? { journalRevision: (project.journalRevision ?? 0) + 1 } : {}),
        ...(rewrite === 'events'
          ? { journalEventRewriteRevision: (project.journalEventRewriteRevision ?? 0) + 1 }
          : {}),
      }),
  };
}

function requireClaim(sweep: Sweep, claim: string) {
  invariant(sweep.claim?.id === claim, 'WORK_STALE', 'The Item purge segment sweep has another worker.');
}

/** Page the small index, then fetch physical objects one at a time in the Node action. */
export const page = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    after: v.union(v.string(), v.null()),
    indexed: v.optional(v.object({ ids: v.array(v.string()), intentKeys: v.array(v.string()) })),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    if (input.indexed) {
      const result = await indexedSweepPage(ctx, input.projectId, input.indexed, input.after);
      return {
        ...result,
        entries: result.entries.map(row => ({ key: row.key, index: JSON.parse(row.value) as JournalIndex })),
      };
    }
    const selected = ctx.db.query('projectJournalSegments').withIndex('by_project_and_key', q => {
      const project = q.eq('projectId', input.projectId);
      return input.after === null ? project : project.gt('key', input.after);
    });
    const result = await selected.paginate({
      cursor: null,
      numItems: 16,
      maximumRowsRead: 16,
      maximumBytesRead: 256 * 1024,
    });
    return {
      entries: result.page
        .filter(row => row.category === 'record' || row.category === 'events')
        .map(row => ({ key: row.key, index: JSON.parse(row.value) as JournalIndex })),
      after: result.page.at(-1)?.key ?? input.after,
      done: result.isDone,
    };
  },
});

export const claim = internalMutation({
  args: claimed,
  returns: v.any(),
  handler: async (ctx, input) => {
    const { project, purge, sweep, save } = await sweepEntry(ctx, input);
    if (sweep.done || purge.purgedAt !== undefined) return null;
    invariant(
      !sweep.claim || sweep.claim.id === input.claim || sweep.claim.until <= Date.now(),
      'WORK_STALE',
      'The Item purge segment sweep is already running.',
    );
    // Outlast the action's hard deadline so a replacement worker cannot race the original R2 upload.
    await save({ ...sweep, claim: { id: input.claim, until: Date.now() + 11 * 60_000 } });
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const intentKeys =
      purge.intentKeys ??
      (await purgeIntentChain(ctx, input.projectId, purge.itemId, recordPartition(generation)));
    return {
      purge: { ...purge, intentKeys },
      sweep,
      rows: await purgeRows(ctx, input.projectId, input.operationId),
    };
  },
});

export const progress = internalMutation({
  args: {
    ...claimed,
    advance: v.optional(v.object({ after: v.union(v.string(), v.null()), done: v.boolean() })),
    release: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { sweep, save } = await sweepEntry(ctx, input);
    if (sweep.claim?.id !== input.claim && input.release) return null;
    requireClaim(sweep, input.claim);
    if (input.advance) {
      invariant(
        !sweep.pending ||
          (sweep.pending.retire && (sweep.indexed ? sweep.after : sweep.pending.key) === input.advance.after),
        'WORK_STALE',
        'Finish retiring this segment before advancing.',
      );
      await save({
        ...input.advance,
        ...(sweep.indexed ? { indexed: sweep.indexed } : {}),
        ...(input.advance.done ? {} : { claim: sweep.claim }),
      });
    } else if (input.release) {
      const next = { ...sweep };
      delete next.claim;
      await save(next);
    }
    return null;
  },
});

export const stage = internalMutation({
  args: {
    ...claimed,
    key: v.string(),
    expected: v.string(),
    planned: v.array(v.string()),
    discarded: v.optional(v.array(v.string())),
  },
  returns: v.array(v.string()),
  handler: async (ctx, input) => {
    const { sweep, purges, save } = await sweepEntry(ctx, input);
    requireClaim(sweep, input.claim);
    const row = await archiveSegmentRow(ctx, input.projectId, input.key);
    const current = row && (JSON.parse(row.value) as JournalIndex);
    invariant(current?.pointer.sha256 === input.expected, 'WORK_STALE', 'Journal segment changed.');
    invariant(
      (!sweep.pending || (sweep.pending.key === input.key && !sweep.pending.retire)) &&
        !purges.some(
          entry => entry.operationId !== input.operationId && entry.segmentSweep?.pending?.key === input.key,
        ),
      'WORK_STALE',
      'Another Item purge is rewriting this journal segment.',
    );
    const previous = sweep.pending?.planned;
    if (canonicalPayload(previous ?? []) === canonicalPayload(input.planned)) return [];
    if (previous) {
      // A resumed action may run after a codec upgrade. Delete the superseded staged pins before
      // replacing them, so an unpublished replacement cannot retain another Item's words.
      const obsolete = previous.filter(key => !input.planned.includes(key));
      if (obsolete.length && input.discarded === undefined) return obsolete;
      invariant(
        canonicalPayload(obsolete) === canonicalPayload(input.discarded ?? []),
        'WORK_STALE',
        'Staged replacement pins changed.',
      );
    }
    await save({ ...sweep, pending: { key: input.key, planned: input.planned } });
    return [];
  },
});

/** Keep the index key and page receipt stable. Only the verified physical pin changes. */
export const publish = internalMutation({
  args: {
    ...claimed,
    key: v.string(),
    expected: v.string(),
    rewritten: v.string(),
    pointers: v.array(landingCapsulePointer),
    events: v.array(v.object({ id: v.id('projectHostedRecordBodies'), facts: v.string() })),
  },
  returns: v.array(v.string()),
  handler: async (ctx, input) => {
    const { sweep, save } = await sweepEntry(ctx, input);
    requireClaim(sweep, input.claim);
    invariant(sweep.pending?.key === input.key, 'WORK_STALE', 'Journal rewrite was not staged.');
    if (sweep.pending.retire) return sweep.pending.retire;
    const row = await archiveSegmentRow(ctx, input.projectId, input.key);
    const current = row && (JSON.parse(row.value) as JournalIndex);
    const [pointer, ...parts] = input.pointers;
    invariant(
      canonicalPayload(input.pointers.map(pin => pin.sha256)) ===
        canonicalPayload(sweep.pending.planned ?? []),
      'EVIDENCE_CHANGED',
      'Uploaded replacement differs from its staged bytes.',
    );
    invariant(
      current?.pointer.sha256 === input.expected && pointer,
      'WORK_STALE',
      'Journal segment changed.',
    );
    const next: JournalIndex = { ...current, pointer, rewritten: input.rewritten };
    if (parts.length) next.parts = parts;
    else delete next.parts;
    await ctx.db.patch(row!._id, { value: canonicalPayload(next) });
    for (const part of current.parts ?? []) {
      const old = await archiveSegmentRow(ctx, input.projectId, part.sha256);
      if (old?.category === 'fragment') await ctx.db.delete(old._id);
    }
    for (const event of input.events) {
      const live = await ctx.db.get(event.id);
      invariant(
        live?.projectId === input.projectId && live.journalSegment,
        'WORK_STALE',
        'Archived event changed.',
      );
      await ctx.db.patch(event.id, {
        command: undefined,
        journalCommand: event.facts,
        purged: input.operationId,
        value: '',
      });
    }
    const active = new Set(input.pointers.map(pin => pin.sha256));
    const retire = [current.pointer, ...(current.parts ?? [])]
      .map(pin => pin.sha256)
      .filter(key => !active.has(key));
    await save(
      { ...sweep, pending: { key: input.key, retire } },
      row!.category === 'events' ? 'events' : 'record',
    );
    return retire;
  },
});
