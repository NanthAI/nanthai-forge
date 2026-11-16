// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { changeLineMark, lineExit } from './projectLiveLineStore';
import { lineOwner, detachLineOwner, type LineBinding, type LineOwnerValue } from './projectLiveLineOwners';

type LineState = Pick<HostedLandingState, 'id' | 'projectId' | 'phase'> &
  Partial<Pick<HostedLandingState, 'observation'>> & { held?: boolean };
const pageKind = 'projectLiveLineSubmissionPage';
function selection(state: LineState) {
  return {
    stage: (state.phase === 'checking' ? 'checking' : state.phase === 'ready' ? 'ready' : 'saved') as
      | 'checking'
      | 'ready'
      | 'saved',
    held:
      state.held === true ||
      state.phase === 'terminal-failed' ||
      state.observation?.pendingReason === 'waiting-for-review' ||
      state.observation?.pendingReason === 'waiting-for-dependency',
  };
}
/** The normal input-staging transaction already authenticated these exact pins. */
export async function bindLineInputs(
  ctx: MutationCtx,
  state: HostedLandingState,
  inputs: readonly { laneId: string; head?: string }[],
  position: number,
) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  const bindings: Array<LineBinding & { head: string }> = [];
  for (const entry of inputs) {
    const mark = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', entry.laneId))
      .unique();
    if (!mark) continue;
    const owner = await lineOwner(ctx.db, mark.laneId);
    const metadata: LineOwnerValue | null = owner ? JSON.parse(owner.value) : null;
    if (
      !owner ||
      !metadata ||
      !entry.head ||
      metadata.head !== entry.head ||
      (owner.submissionId === state.id && metadata.pageId)
    )
      continue;
    await detachLineOwner(ctx.db, owner);
    await changeLineMark(ctx.db, mark, selection(state));
    bindings.push({ laneId: mark.laneId, markId: mark._id, ownerId: owner._id, head: metadata.head });
  }
  if (bindings.length) {
    const pageId = await ctx.db.insert('projectFinishReadRows', {
      kind: pageKind,
      sourceId: `${state.id}:${position}`,
      projectId,
      submissionId: state.id,
      value: JSON.stringify(bindings.map(({ head: _head, ...entry }) => entry)),
    });
    for (const entry of bindings)
      await ctx.db.patch(entry.ownerId, {
        submissionId: state.id,
        value: JSON.stringify({ markId: entry.markId, head: entry.head, pageId }),
      });
  }
}
/** Bind the existing authenticated selection in pages of 100. Head changes detach
 * their binding, so transitions need no per-Lane ownership or source reads. */
export async function bindLineSubmission(
  ctx: MutationCtx,
  state: HostedLandingState,
  compose: { actor: string; operationId: string },
) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  let cursor: string | null = null;
  let position = 0;
  do {
    const page = await ctx.db
      .query('projectHostedComposeSelections')
      .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
        q
          .eq('projectId', projectId)
          .eq('actor', compose.actor)
          .eq('operationId', compose.operationId)
          .eq('kind', 'inputs'),
      )
      .paginate({ cursor, numItems: 100 });
    await bindLineInputs(
      ctx,
      state,
      page.page.map(entry => ({ laneId: entry.key, ...(entry.head ? { head: entry.head } : {}) })),
      position,
    );
    position++;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
}
/** Transition control reads O(pages), not one row per Lane. Mapping pages are
 * transactionally detached by saves/closes, so these exact ids can be patched
 * without a lookup. No heartbeat, holder, attempt or run identity participates. */
export async function transitionLineSubmission(
  ctx: Pick<MutationCtx, 'db'>,
  before: LineState,
  state: LineState,
) {
  const prior = selection(before),
    next = selection(state);
  if (before.phase === state.phase && prior.stage === next.stage && prior.held === next.held) return;
  const projectId = state.projectId as Id<'hostedProjects'>;
  let cursor: string | null = null;
  let removed = 0;
  let last: string | undefined;
  do {
    const page = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_submission', q =>
        q.eq('kind', pageKind).eq('projectId', projectId).eq('submissionId', state.id),
      )
      .paginate({ cursor, numItems: 1 });
    for (const row of page.page) {
      const bindings = JSON.parse(row.value) as LineBinding[];
      for (const entry of bindings) {
        if (state.phase === 'landed') {
          await ctx.db.delete(entry.markId);
          await ctx.db.delete(entry.ownerId);
          removed++;
          last = entry.laneId;
        } else if (prior.stage !== next.stage || prior.held !== next.held) {
          await ctx.db.patch(entry.markId, {
            ...next,
            ...(prior.stage !== next.stage ? { changedAt: Date.now() } : {}),
          });
        }
      }
      if (state.phase === 'landed') await ctx.db.delete(row._id);
    }
    // Terminal pages are deleted; consuming from the start also works for
    // offset-based test cursors. Other transitions retain the exact page cursor.
    if (page.isDone) break;
    cursor = state.phase === 'landed' ? null : page.continueCursor;
  } while (true);
  if (removed) await lineExit(ctx.db, projectId, { laneId: last!, kind: 'landed', at: Date.now() });
}
