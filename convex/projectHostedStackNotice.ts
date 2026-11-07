// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { patchOverlapRow } from './projectHostedOverlapPeers';
import { postSystemLaneNote } from './projectBoardSystem';
import {
  STACK_NOTICE_FANOUT,
  stackNoticeId,
  stackNoticeText,
  type StackEvent,
} from '../src/hosted-stack-notice';

/** The Lane whose change the notice reports: its public identity becomes the note's sender. */
export type StackParent = { projectId: Id<'hostedProjects'>; laneId: string; actor: string; agent?: string };

const overlapRow = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/**
 * Keeps one dependents row per open Lane stacked on a parent (Issue dc62b120). Called from every Lane
 * record write; a Lane without `stack` returns before any read. A stacked Lane costs one indexed read
 * per write, plus the parent's overlap row on the write that first stacks it (it gets the `stacked`
 * flag that makes the parent's own events look for dependents). A closed or unstacked
 * (`detached`) Lane drops its row; a restack (new pinned parent head) re-arms its notices.
 */
export async function trackStackDependent(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: { id: string; stack?: { laneId: string; head: string; detached?: boolean } },
  open: boolean,
) {
  const stack = lane.stack;
  if (!stack) return;
  const row = await ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
    .unique();
  if (!open || stack.detached) {
    if (row) await ctx.db.delete(row._id);
    return;
  }
  if (row && row.parentLaneId === stack.laneId && row.parentHead === stack.head) return;
  const value = { projectId, parentLaneId: stack.laneId, laneId: lane.id, parentHead: stack.head };
  if (row) await ctx.db.replace(row._id, value);
  else await ctx.db.insert('projectHostedStackDependents', value);
  const parent = await overlapRow(ctx, projectId, stack.laneId);
  if (parent && !parent.stacked) await patchOverlapRow(ctx, parent, { stacked: true });
}

type Reader = Pick<MutationCtx, 'db'> | Pick<QueryCtx, 'db'>;
const dependentRow = (ctx: Reader, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/** What a stacked Lane's next save does about its parent (Issue f61e9339), from one point read of its
 * dependents row; a Lane without an attached stack reads nothing. `ready`: the parent saved newer work,
 * so the save restacks onto `parentHead` when that applies cleanly. `conflict`: that restack already
 * conflicted, so nothing runs until the parent saves again; the board notice names the sync command.
 * None while the parent is abandoned: its notice says to unstack instead. */
export async function stackRestackHint(
  ctx: Reader,
  projectId: Id<'hostedProjects'>,
  lane: { id: string; state: string; stack?: { laneId: string; head: string; detached?: boolean } },
) {
  if (!lane.stack || lane.stack.detached || lane.state !== 'active') return null;
  const row = await dependentRow(ctx, projectId, lane.id);
  if (!row || row.ended || !row.latestHead || row.latestHead === row.parentHead) return null;
  if (row.parentHead !== lane.stack.head || row.parentLaneId !== lane.stack.laneId) return null;
  return {
    laneId: lane.id,
    parentLaneId: row.parentLaneId,
    parentHead: row.latestHead,
    restack: row.restackConflict === row.latestHead ? ('conflict' as const) : ('ready' as const),
  };
}

/** An automatic (cleanOnly) restack onto `parentHead` conflicted: mark it so later saves skip it. */
export async function markRestackConflict(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  parentHead: string,
) {
  const row = await dependentRow(ctx, projectId, laneId);
  if (row && row.restackConflict !== parentHead) await ctx.db.patch(row._id, { restackConflict: parentHead });
}

/**
 * One board note per dependent for one parent event, delivered like any Lane note (`board.notices`
 * on the next Lane action, early return of a blocked `wait`). Bounded to the parent's direct
 * dependents (at most STACK_NOTICE_FANOUT); a deeper chain is told level by level, as each parent
 * restacks and saves. The caller has already seen `stacked` on the parent's overlap row, or is on the
 * landing-failure path, which reads this index range itself.
 *
 * Each event is announced once per dependent: the dependents row marks it, and the note id is derived
 * from the event, so a replayed transaction writes nothing new.
 *  - saved: skipped when the child is already on that head, and while an earlier "saved" note is
 *    unanswered by a restack (the restack command always takes the newest head).
 *  - abandoned: once until the parent is saved again.
 *  - landing: once until the parent is saved or the child restacks; skipped after an abandonment
 *    (the abandon cancels the landing, and that note already said what to do).
 */
export async function notifyStackDependents(ctx: MutationCtx, parent: StackParent, event: StackEvent) {
  return announce(ctx, parent, await dependentsOf(ctx, parent.projectId, parent.laneId), event);
}

const dependentsOf = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, parentLaneId: string) =>
  ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_parent', q => q.eq('projectId', projectId).eq('parentLaneId', parentLaneId))
    .take(STACK_NOTICE_FANOUT);

async function announce(
  ctx: MutationCtx,
  parent: StackParent,
  rows: Doc<'projectHostedStackDependents'>[],
  event: StackEvent,
) {
  let sent = 0;
  for (const row of rows) {
    const child = await overlapRow(ctx, parent.projectId, row.laneId);
    if (!child?.open) {
      // A Lane closed by an Intent cascade keeps its row until now; nobody is left to tell.
      await ctx.db.delete(row._id);
      continue;
    }
    let mark: Partial<Doc<'projectHostedStackDependents'>>;
    let key: string;
    if (event.kind === 'saved') {
      key = `saved:${event.head}`;
      if (row.parentHead === event.head) continue;
      // Any parent save re-arms a later landing notice; only the first unanswered save is announced.
      // The newest head is always kept: the child's next save restacks onto it (Issue f61e9339).
      if (row.savedNoticed && !row.ended) {
        await ctx.db.patch(row._id, { latestHead: event.head, landingNoticed: undefined });
        continue;
      }
      mark = { savedNoticed: true, ended: undefined, landingNoticed: undefined, latestHead: event.head };
    } else if (event.kind === 'abandoned') {
      key = `abandoned:${event.key}`;
      if (row.ended) continue;
      mark = { ended: 'abandoned' };
    } else {
      key = `landing:${event.operationId}`;
      if (row.ended || row.landingNoticed) continue;
      mark = { landingNoticed: true };
    }
    await ctx.db.patch(row._id, mark);
    const result = await postSystemLaneNote(ctx, {
      projectId: parent.projectId,
      id: stackNoticeId(row.laneId, parent.laneId, key),
      toLaneId: row.laneId,
      fromLaneId: parent.laneId,
      author: parent.actor,
      ...(parent.agent ? { agent: parent.agent } : {}),
      text: stackNoticeText(event, parent.laneId, row.laneId),
    });
    if (result === 'posted') sent++;
  }
  return sent;
}

/**
 * A landing ended failed or cancelled: tell the Lanes stacked on the Lanes it carried. Landing state
 * names no Lane, so the Lanes come from the compose selection of the landing's own composition. That
 * table is kept out of landing transitions on purpose (tests/hosted-landing-fixture.mjs), so a project
 * with no stacked Lane at all stops after one empty index range on the dependents table: no document
 * is read. Only a project that has stacks resolves the selection (one range, one row for a single Lane)
 * and then one dependents range per Lane. This runs once per failed or cancelled landing, never on save,
 * status, wait or idle, and nothing runs when the landing has no composition id (older requests).
 */
export async function notifyStackedLandingEnded(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    composeOperationId: string | undefined;
    operationId: string;
    code?: string;
  },
) {
  if (!input.composeOperationId) return 0;
  const anyStack = await ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_parent', q => q.eq('projectId', input.projectId))
    .take(1);
  if (!anyStack.length) return 0;
  const selections = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
      q
        .eq('projectId', input.projectId)
        .eq('actor', input.actor)
        .eq('operationId', input.composeOperationId!)
        .eq('kind', 'inputs'),
    )
    .take(STACK_NOTICE_FANOUT);
  let sent = 0;
  for (const selection of selections) {
    const dependents = await dependentsOf(ctx, input.projectId, selection.key);
    if (!dependents.length) continue;
    const lane = await overlapRow(ctx, input.projectId, selection.key);
    if (!lane) continue;
    sent += await announce(
      ctx,
      {
        projectId: input.projectId,
        laneId: lane.laneId,
        actor: lane.actor,
        ...(lane.agent ? { agent: lane.agent } : {}),
      },
      dependents,
      {
        kind: 'landing',
        outcome: input.code === 'LANDING_CANCELLED' ? 'cancelled' : 'failed',
        operationId: input.operationId,
        ...(input.code ? { code: input.code } : {}),
      },
    );
  }
  return sent;
}
