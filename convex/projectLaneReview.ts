// SPDX-License-Identifier: Apache-2.0
// The Lane review screen's one read (Items 52235fbf, 4bc460aa): everything the page needs before any file body, in
// one bounded query, so the screen makes one round trip before its first diff instead of 13 serial calls. No State
// object or file body is read here: the changed paths and their exact blob ids come from the Lane's overlap row, which
// every save already writes, with each file's +/- counts when the saving CLI recorded them; file bodies are fetched by
// the browser per opened file (describe, then R2). The first page includes the same indexed Intent title
// lookup as Lanes, at a fixed cost per view. File continuations skip it.
import { v } from 'convex/values';
import { projectQuery as query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { readHostedIntentLabel, readHostedRecord } from './projectHostedRecords';
import { laneConflicts } from './projectHostedConflicts';
import { isAgentSlug } from '../src/agent-slug';
import { hostedLaneSchema } from '../src/hosted-lane';
import { effectivePolicy, protectedMatches } from '../src/autonomy-policy';
import { lineCounts, type OverlapChange } from '../src/hosted-overlap';
import { invariant } from '../src/errors';
import { report } from './errors';
import { landedTiming } from './projectLaneTiming';
import { saveFailureForViewer } from './projectHostedSaveStore';
import { approvalRow, approvalView } from './projectHostedApprovalStore';
import { deriveApproval } from '../src/approval-state';
import { overlapLaneChanges, overlapLaneEntries } from './projectHostedOverlapChanges';

/** The owner's open decision on a Lane's own request: asked, declined while it still holds the Lane (the owner may
 * approve instead), or granted and not yet landed (shown, nothing to decide). A settings key is never a Lane; a fork run is decided once. The Needs me request shape. */
function ownerRequest(row: Awaited<ReturnType<typeof approvalRow>>, laneId: string) {
  if (!row || row.setting) return null;
  const view = approvalView(row, laneId);
  const state = deriveApproval(view);
  const declined = state.state === 'declined' && view.live && row.pullRequest === undefined;
  // A granted request that has not ended is shown read-only (Item 4f1f7984): Needs me no longer lists it.
  const granted = state.state === 'granted' && state.open && row.pullRequest === undefined;
  if (!state.needsOwner && !declined && !granted) return null;
  return {
    ...view,
    kind: state.kind,
    state: state.state,
    needsOwner: state.needsOwner,
    label: state.label,
    nextStep: state.nextStep,
  };
}

/** Changed paths per reply page. A 128 KB overlap row holds at most about 800, so one page is the usual case. */
export const REVIEW_PAGE = 400;
/** Distinct peer Lanes named per reply (their slim presence rows, about 0.5 KB each). */
const PEERS = 8;
/** Peer Lanes whose changed-path rows are read for line origin (each row is at most 128 KB; conflicts only). */
const ORIGIN_PEERS = 3;

export const read = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string(), offset: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId, offset = 0 }) => {
    try {
      invariant(Number.isSafeInteger(offset) && offset >= 0, 'BAD_ARGUMENT', 'Choose a valid page.');
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read this Lane.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const [record, row] = await Promise.all([
        readHostedRecord(ctx, {
          projectId,
          actor: user.subject,
          kind: 'lane',
          key: laneId,
          withSaveFailure: offset === 0,
        }),
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique(),
      ]);
      invariant(record, 'NOT_FOUND', 'This Lane is not on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(record.value));
      const intentRead =
        offset === 0
          ? readHostedIntentLabel(ctx, { projectId, actor: user.subject, intentId: lane.intentId })
          : null;
      // Item 0a99ab23: this Lane's approval request, for its owner, so the page decides it from this exact row even
      // before the Lane holds a landing. One point read, first page only, owner only.
      const askedRead =
        offset === 0 && project.owner === user.subject ? approvalRow(ctx, projectId, laneId) : null;
      // The row describes this exact pinned pair only when it was written for the Lane's current head and base.
      const current = !!row && row.head === lane.head && row.baseHead === lane.base.head;
      const changes: OverlapChange[] = current ? JSON.parse(await overlapLaneChanges(ctx, row)) : [];
      const page = changes.slice(offset, offset + REVIEW_PAGE);
      const policy = effectivePolicy(project);
      const guarded = new Set(
        protectedMatches(
          policy,
          page.map(change => change.path),
        ),
      );
      const conflicts = row?.conflicted ? await laneConflicts(ctx, projectId, laneId, lane.head) : [];
      // The Lane ahead of an early resolution is the stack parent; earlyResolution.laneId names this Lane itself.
      const ahead = lane.earlyResolution && lane.stack ? lane.stack.laneId : null;
      const crossing = [
        ...new Set([
          ...(ahead ? [ahead] : []),
          ...conflicts.map(conflict => conflict.with).filter(peer => peer !== 'main'),
        ]),
      ];
      const peerIds = crossing.slice(0, PEERS);
      const shown = new Set(page.map(change => change.path));
      const peers = await Promise.all(
        peerIds.map(async (peer, index) => {
          const [presence, peerRow] = await Promise.all([
            ctx.db
              .query('projectHostedPresence')
              .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', peer))
              .unique(),
            index < ORIGIN_PEERS
              ? ctx.db
                  .query('projectHostedOverlapLanes')
                  .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', peer))
                  .unique()
              : null,
          ]);
          // The peer's exact version of each path this page shows, so the browser can say which lines came from it.
          const files = peerRow
            ? (JSON.parse(await overlapLaneEntries(ctx, peerRow, shown)) as OverlapChange[])
            : [];
          return {
            laneId: peer,
            actor: presence?.actor ?? peerRow?.actor ?? null,
            agent: presence?.agent ?? peerRow?.agent ?? null,
            goal: presence?.goal ?? peerRow?.intent ?? null,
            ...(peerRow
              ? {
                  head: peerRow.head,
                  baseHead: peerRow.baseHead,
                  complete: peerRow.complete,
                  landed: peerRow.landed ?? null,
                  files: files.map(({ path, before, after }) => ({ path, before, after })),
                }
              : {}),
          };
        }),
      );
      const timing = row?.landed ? await landedTiming(ctx, projectId, row.landed.receiptId) : null;
      const intent = await intentRead;
      const request = ownerRequest(await askedRead, laneId);
      const run = isAgentSlug(lane.agentRun) ? lane.agentRun : null;
      const savedBy = current ? row.savedBy : undefined;
      // Before the save's author was projected, a holder change or a legacy owner override
      // can separate the Lane's starter from its stamped save. Keep the run and model, but
      // don't pair them with an account the pinned records cannot establish.
      const knowsStarter =
        !lane.authorship ||
        lane.sourceVersion === 0 ||
        (lane.holder
          ? lane.holder.actor === lane.actor && !lane.holder.change
          : lane.actor === project.owner);
      const author = typeof savedBy === 'string' ? savedBy : savedBy || knowsStarter ? lane.actor : null;
      return JSON.stringify({
        lane: {
          laneId,
          intentId: lane.intentId,
          goal: intent?.title ?? null,
          itemId: intent?.itemId ?? row?.planningItemId ?? lane.intentId,
          actor: author,
          agent: lane.authorship ? (run ?? null) : (row?.agent ?? null),
          ...(lane.agentClient ? { agentClient: lane.agentClient } : {}),
          ...(lane.authorship?.kind === 'agent' ? { agentAuthored: true } : {}),
          state: lane.state,
          head: lane.head,
          base: lane.base,
          landed: row?.landed ? { ...row.landed, timing } : null,
          ...(record.saveFailure
            ? {
                saveFailure: await saveFailureForViewer(ctx, record.saveFailure.value, project, user.subject),
              }
            : {}),
          // Parked (Item e1633718): who it waits on and why, from the record already read.
          ...(lane.state === 'active' && lane.park
            ? { park: { ...lane.park, named: Boolean(lane.park.to) } }
            : {}),
          ...(lane.earlyResolution ? { earlyResolution: lane.earlyResolution, ahead } : {}),
          ...(lane.resolution
            ? {
                resolution: {
                  status: lane.resolution.status,
                  origin: lane.resolution.origin?.laneId ?? null,
                },
              }
            : {}),
        },
        ...(request ? { request } : {}),
        // The owner may purge a leaked file's saved bytes from its row (Item 9d3c407d).
        ...(project.owner === user.subject ? { owner: true } : {}),
        supervised: policy.acceptance.mode === 'review',
        protectedRules: policy.acceptance.protectedPaths.length,
        files: {
          current,
          complete: current ? row!.complete : lane.head === lane.base.head,
          total: changes.length,
          offset,
          nextOffset: offset + page.length < changes.length ? offset + page.length : null,
          items: page.map(change => {
            // +/- counts the saving CLI recorded on this same row (c2388099): no extra read; absent on older saves.
            const lines = lineCounts(change);
            return {
              path: change.path,
              status: !change.before ? 'added' : !change.after ? 'deleted' : 'modified',
              before: change.before,
              after: change.after,
              ...(lines ? { lines } : {}),
              ...(guarded.has(change.path) ? { protected: true } : {}),
            };
          }),
        },
        conflicts,
        peers,
      });
    } catch (error) {
      return report(error);
    }
  },
});
