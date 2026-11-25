// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off conversion (Item c0af6cfa, F7 and F8). Not part of the product: it lives in the pinned in-between
// release, runs once per deployment and is deleted with its last proof (docs/operations/legacy-item-shapes.md).
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './server';
import { recordHead } from './projectHostedRecords';
import { itemOwnsIntent } from './projectWorkStore';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { postIntentLandingNote } from './projectIntentLandingNotes';
import { invariant } from '../src/errors';
import { maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import type { HostedAcceptance } from '../src/hosted-acceptance';

/** The operator names the deployment it means to convert (dev with its name, prod only with the owner's go).
 * The name is the subdomain of the deployment this code runs on; a mismatch refuses before any read. */
const confirmed = (deployment: string) =>
  invariant(
    new URL(process.env.CONVEX_CLOUD_URL ?? 'https://unset.invalid').hostname.split('.')[0] === deployment,
    'PROJECT_UNAVAILABLE',
    'The deployment argument does not name the deployment this code runs on.',
  );
const PAGE = 48;
/** Point reads the page bytes miss (head and Item lookups): charged at a flat estimate. */
const LOOKUP = 2048;
const MIB = 1024 * 1024;
const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value)).length;
const family = v.union(
  v.literal('intents'),
  v.literal('lanes'),
  v.literal('landings'),
  v.literal('projects'),
);
type Family = 'intents' | 'lanes' | 'landings' | 'projects';
type Counts = Record<string, number>;
const unmarked = (marker: string | undefined) => marker === undefined || marker === '';

/** Live projects, one page at a time, so the driver visits each once. */
export const projects = internalQuery({
  args: { deployment: v.string(), after: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, { deployment, after }) => {
    confirmed(deployment);
    const page = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor: after, numItems: 16, maximumRowsRead: 16, maximumBytesRead: MIB });
    return {
      ids: page.page.filter(project => !project.removal).map(project => project._id),
      readBytes: page.page.reduce((sum, project) => sum + bytes(project), 0),
      next: page.isDone ? null : page.continueCursor,
    };
  },
});

/** One page of one family in one project. `apply:false` only counts. */
export const page = internalMutation({
  args: {
    deployment: v.string(),
    projectId: v.id('hostedProjects'),
    family,
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, { deployment, projectId, family, cursor, apply }) => {
    confirmed(deployment);
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'This project is unavailable.');
    const counts: Counts = {};
    const count = (key: string, by = 1) => (counts[key] = (counts[key] ?? 0) + by);
    let readBytes = bytes(project);
    const blocked: string[] = [];
    const heads = (kind: 'intent' | 'lane') =>
      ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q => q.eq('projectId', projectId).eq('kind', kind))
        .paginate({ cursor, numItems: PAGE, maximumRowsRead: PAGE, maximumBytesRead: MIB });
    const stamp = async (head: Doc<'projectHostedRecordHeads'>, itemId: string, key: string) => {
      count(key);
      if (apply) await ctx.db.patch(head._id, { planningItemId: itemId });
    };

    if (family === 'intents') {
      const result = await heads('intent');
      for (const head of result.page) {
        readBytes += bytes(head);
        count('intents');
        // A root: the Item's own id. Bind it, then follow its successors, as the membership repair did.
        let itemId: string | null = null;
        if (head.planningItemId === head.key) itemId = head.key;
        else if (unmarked(head.planningItemId)) {
          readBytes += LOOKUP;
          if (await itemOwnsIntent(ctx, projectId, head.key)) {
            await stamp(head, head.key, 'rootsBound');
            itemId = head.key;
          }
        }
        if (!itemId) continue;
        let key = head.key;
        for (let hop = 0; hop < maxIntentChain; hop++) {
          key = successorIntentId(key);
          const next = await recordHead(ctx, projectId, 'intent', key);
          if (!next) break;
          readBytes += bytes(next);
          if (next.planningItemId === itemId) continue;
          // Never take another Item's binding, nor an Intent an Item of that id owns.
          readBytes += LOOKUP;
          if (next.planningItemId !== undefined || (await itemOwnsIntent(ctx, projectId, key))) break;
          await stamp(next, itemId, 'successorsBound');
        }
      }
      return { counts, readBytes, blocked, next: result.isDone ? null : result.continueCursor };
    }

    if (family === 'lanes') {
      const result = await heads('lane');
      const parents = new Map<string, string | null>();
      for (const head of result.page) {
        readBytes += bytes(head);
        count('lanes');
        if (!unmarked(head.planningItemId)) continue;
        count('lanesUnmarked');
        let itemId = parents.get(head.parent);
        if (itemId === undefined) {
          const parent = await recordHead(ctx, projectId, 'intent', head.parent);
          if (parent) readBytes += bytes(parent);
          itemId = parent?.planningItemId || null;
          parents.set(head.parent, itemId);
        }
        if (itemId) await stamp(head, itemId, 'lanesBound');
      }
      return { counts, readBytes, blocked, next: result.isDone ? null : result.continueCursor };
    }

    if (family === 'landings') {
      const result = await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId))
        .paginate({ cursor, numItems: PAGE, maximumRowsRead: PAGE, maximumBytesRead: MIB });
      for (const row of result.page) {
        readBytes += bytes(row);
        count('overlapRows');
        const landed = row.landed;
        if (!landed) continue;
        count('stamps');
        // History is read through the Intent's Item: a stamp matters only on an Item-bound Intent.
        const intent = await recordHead(ctx, projectId, 'intent', row.intentId);
        readBytes += LOOKUP;
        if (!intent?.planningItemId) continue;
        count('itemStamps');
        const kinds = [
          { kind: 'landed' as const, receiptId: landed.receiptId, at: landed.at },
          ...(landed.revertedBy
            ? [
                {
                  kind: 'reverted' as const,
                  receiptId: landed.revertedBy.receiptId,
                  at: landed.revertedBy.at,
                },
              ]
            : []),
        ];
        for (const { kind, receiptId, at } of kinds) {
          // A note covers this Lane only when it names it: one receipt can land several Lanes of an Intent.
          const covers = (note: Doc<'projectIntentLandingNotes'> | null) =>
            note !== null &&
            (kind === 'reverted' || note.laneIds.includes(row.laneId) || note.viaLaneId === row.laneId);
          const find = () =>
            ctx.db
              .query('projectIntentLandingNotes')
              .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
                q
                  .eq('projectId', projectId)
                  .eq('receiptId', receiptId)
                  .eq('intentId', row.intentId)
                  .eq('kind', kind),
              )
              .unique();
          const existing = await find();
          readBytes += existing ? bytes(existing) : 0;
          if (!covers(existing)) {
            count(`${kind}NotesMissing`);
            // A revert note carries the revert's own receipt: its commit and main revision, not the landing's.
            const receipt = await acceptanceRow(ctx, { projectId, receiptId });
            if (!receipt || (existing && 'capsule' in existing)) {
              blocked.push(row.laneId);
              count('blocked');
              continue;
            }
            readBytes += bytes(receipt);
            if (!apply) continue;
            const evidence = JSON.parse(receipt.value) as HostedAcceptance;
            await postIntentLandingNote(ctx, projectId, {
              intentId: row.intentId,
              receiptId,
              kind,
              at,
              laneIds: [row.laneId],
              commit: kind === 'landed' ? landed.commit : evidence.candidate.head,
              sequence: evidence.snapshot.revision,
              actor: row.actor,
              ...(kind === 'reverted' ? { revertOf: landed.receiptId } : {}),
            });
            count(`${kind}NotesWritten`);
          }
          // The proof the reader needs: the note names this Lane, with the stamp's commit and time.
          const note = apply ? await find() : existing;
          // An archived note reads its commit and time from the receipt itself, so only its Lane is compared.
          const equal =
            covers(note) &&
            (kind === 'reverted' ||
              (note !== null &&
                (!('commit' in note) || (note.commit === landed.commit && note.at === landed.at))));
          count(equal ? 'stampsProved' : 'stampsUnproved');
        }
      }
      return { counts, readBytes, blocked, next: result.isDone ? null : result.continueCursor };
    }

    // projects: the retired Item membership marker, whatever frontier it carried.
    if (project.itemLaneMembership !== undefined) {
      count('markerFound');
      if (apply) await ctx.db.patch(projectId, { itemLaneMembership: undefined });
    }
    return { counts, readBytes, blocked, next: null };
  },
});

/** The removed projects keep the marker too; unset it so the schema can drop it. */
export const removedProjects = internalMutation({
  args: { deployment: v.string(), after: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.any(),
  handler: async (ctx, { deployment, after, apply }) => {
    confirmed(deployment);
    const result = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor: after, numItems: 32, maximumRowsRead: 32, maximumBytesRead: MIB });
    let changed = 0;
    for (const project of result.page)
      if (project.removal && project.itemLaneMembership !== undefined) {
        changed++;
        if (apply) await ctx.db.patch(project._id as Id<'hostedProjects'>, { itemLaneMembership: undefined });
      }
    return {
      changed,
      readBytes: result.page.reduce((sum, project) => sum + bytes(project), 0),
      next: result.isDone ? null : result.continueCursor,
    };
  },
});

/** Drive every family over every live project within one stated read budget. A replay of an applied run
 * prints zero in every `*Bound`, `*NotesMissing` and marker count with `stopped: null`. */
export const run = internalAction({
  args: {
    deployment: v.string(),
    apply: v.boolean(),
    budgetBytes: v.number(),
    families: v.optional(v.array(family)),
  },
  returns: v.any(),
  handler: async (ctx, { deployment, apply, budgetBytes, families }) => {
    confirmed(deployment);
    const order: Family[] = families ?? ['intents', 'lanes', 'landings', 'projects'];
    const totals: Counts = {};
    const blocked: string[] = [];
    let readBytes = 0;
    let stopped: string | null = null;
    const add = (counts: Counts) => {
      for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + value;
    };
    // Reserve a transaction's worth: no page starts when it could cross the budget.
    const room = () => readBytes + 4 * MIB <= budgetBytes;
    const ids: string[] = [];
    let census: string | null = null;
    do {
      if (!room()) {
        stopped = 'budget at the project census';
        break;
      }
      const projects: { ids: string[]; readBytes: number; next: string | null } = await ctx.runQuery(
        internal.legacyItemShapes.projects,
        { deployment, after: census },
      );
      ids.push(...projects.ids);
      readBytes += projects.readBytes;
      census = projects.next;
    } while (census !== null);
    for (const name of order) {
      for (const projectId of ids) {
        let cursor: string | null = null;
        do {
          if (!room()) {
            stopped = `budget at ${name} ${projectId}`;
            break;
          }
          const result: { counts: Counts; readBytes: number; blocked: string[]; next: string | null } =
            await ctx.runMutation(internal.legacyItemShapes.page, {
              deployment,
              projectId: projectId as Id<'hostedProjects'>,
              family: name,
              cursor,
              apply,
            });
          add(result.counts);
          blocked.push(...result.blocked);
          readBytes += result.readBytes;
          cursor = result.next;
        } while (cursor !== null);
        if (stopped) break;
      }
      if (stopped) break;
    }
    let removed: string | null = null;
    while (!stopped && order.includes('projects')) {
      if (!room()) {
        stopped = 'budget at removed projects';
        break;
      }
      const result: { changed: number; readBytes: number; next: string | null } = await ctx.runMutation(
        internal.legacyItemShapes.removedProjects,
        { deployment, after: removed, apply },
      );
      totals.removedMarker = (totals.removedMarker ?? 0) + result.changed;
      readBytes += result.readBytes;
      removed = result.next;
      if (removed === null) break;
    }
    return { apply, projects: ids.length, readBytes, budgetBytes, counts: totals, blocked, stopped };
  },
});
