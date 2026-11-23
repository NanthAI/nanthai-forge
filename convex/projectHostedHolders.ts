// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { sourceAuthorship } from '../src/work-actor-types';
import type { z } from 'zod';
import type { SourceAuthority } from '../src/hosted-source-authority';
import { mutation } from './cliServer';
import { activeProject } from './projectAuthority';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { effectivePolicy } from '../src/autonomy-policy';
import { canonicalPayload, hostedPayloadHash, hostedOperationSchema } from '../src/hosted-source-operation';
import { holderRequestSchema, holderOfferSchema } from '../src/lane-holder';
import { hostedLaneSchema, hostedLaneSelectionSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { emitChange } from './coordinationWrite';
import { PRESENCE } from '../src/presence';
import { mayTakeLane, takeoverNeedsReason } from './accessPolicy';
import { invariant } from '../src/errors';
import { report } from './errors';
import { sessionIdentity } from './projectSessionIdentity';
import { acceptedHandoff } from './projectLaneHandoff';
function selection(projectId: string, lane: z.infer<typeof hostedLaneSchema>, authority: SourceAuthority) {
  return hostedLaneSelectionSchema.parse({
    ...sourceAuthorship(lane),
    schema: 2,
    projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    base: lane.base,
    head: lane.head,
    version: lane.version,
    sourceVersion: lane.sourceVersion,
    lifecycleVersion: lane.lifecycleVersion,
    state: lane.state,
    authority,
    ...(lane.holder ? { holder: lane.holder } : {}),
    ...(lane.stack ? { stack: lane.stack } : {}),
  });
}
/** Explicit, retry-safe holder changes share the Lane's immutable record history. Source never moves. */
export const take = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const parsed = holderRequestSchema.safeParse(JSON.parse(input.request));
      // A refused field (such as a reason over HOLDER_REASON_MAX) is the caller's to fix, not a retry.
      const issue = parsed.error?.issues[0];
      invariant(parsed.success, 'BAD_ARGUMENT', `${issue?.path.join('.') || 'request'}: ${issue?.message}.`);
      const request = parsed.data;
      const identity = await ctx.auth.getUserIdentity();
      invariant(identity, 'PROJECT_UNAVAILABLE', 'Sign in to take over a Lane.');
      const actor = identity.subject;
      const project = await activeProject(ctx, input.projectId, actor);
      invariant(
        effectivePolicy(project).accessIdentities?.laneHolders === true,
        'BAD_ARGUMENT',
        'Explicit Lane holders are not enabled for this project.',
      );
      const row = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        kind: 'lane',
        key: request.laneId,
      });
      invariant(row, 'NOT_FOUND', 'Lane not found.');
      const lane = hostedLaneSchema.parse(JSON.parse(row.value));
      invariant(
        mayTakeLane(actor, lane.actor, project.owner),
        'PROJECT_UNAVAILABLE',
        'Only this person’s sessions or the project owner may take this Lane.',
      );
      const prior = await hostedOperationRow(ctx, input.projectId, actor, request.operationId);
      if (prior) {
        const operation = hostedOperationSchema.parse(JSON.parse(prior.value));
        invariant(
          operation.payloadHash === hostedPayloadHash(request, operation.expected),
          'WORK_OPERATION_CHANGED',
          'Retry the original holder change.',
        );
        if (operation.terminal)
          return canonicalPayload({
            ...operation.terminal.outcome,
            observedLane: selection(input.projectId, lane, sourceAuthority(project)),
          });
      }
      const accepted = request.acceptHandoff
        ? await acceptedHandoff(
            ctx,
            input.projectId,
            lane,
            project.owner,
            request.acceptHandoff,
            actor,
            request.sessionId,
          )
        : undefined;
      const reason = request.reason ?? accepted?.reason;
      const pins = request.expected ?? { head: lane.head, version: lane.version };
      const oldHolder = lane.holder;
      invariant(
        !oldHolder?.sessionId ||
          (oldHolder.actor === actor && oldHolder.sessionId === request.sessionId) ||
          request.takeover ||
          request.handoff ||
          accepted,
        'WORK_STALE',
        `This Lane is held by ${oldHolder?.agent ?? 'another session'} since ${oldHolder ? new Date(oldHolder.since).toISOString() : 'its earlier open'}. Open with takeover:true to take over explicitly; all saved work remains.`,
      );
      const expected = {
        authorityEpoch: request.authorityEpoch,
        head: pins.head,
        resourceId: request.laneId,
        resourceVersion: pins.version,
      };
      const auth = { projectId: input.projectId, actor, operationId: request.operationId };
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        payload: request,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
        firstAttempt: {
          projectId: input.projectId,
          operationId: request.operationId,
          id: crypto.randomUUID(),
          parentAttemptId: null,
          at: new Date().toISOString(),
          expected,
          ids: {},
        },
      });
      if (prepared.operation.terminal)
        return canonicalPayload({
          ...prepared.operation.terminal.outcome,
          observedLane: selection(input.projectId, lane, sourceAuthority(project)),
        });
      invariant(
        lane.state === 'active' && lane.head === pins.head && lane.version === pins.version,
        'WORK_STALE',
        'Read this Lane again: its saved head or holder changed. Local work is unchanged.',
      );
      const now = Date.parse(prepared.operation.firstAttempt.at),
        old = lane.holder;
      const same = old?.actor === actor && old.sessionId === request.sessionId;
      if (request.handoff)
        invariant(
          same || actor === project.owner,
          'PROJECT_UNAVAILABLE',
          'The current holder or project owner may hand this Lane over.',
        );
      // Cross-person assignment is not a new grant. Resolve only a known Forge handle here.
      let nextActor = actor;
      if (request.handoff?.person) {
        const handle = request.handoff.person.replace(/^@/, '').toLowerCase();
        const account = await ctx.db
          .query('accountHandles')
          .withIndex('by_handle', q => q.eq('handle', handle))
          .unique();
        invariant(
          account && mayTakeLane(account.owner, lane.actor, project.owner),
          'PROJECT_UNAVAILABLE',
          'Hand this Lane to its person or the project owner.',
        );
        nextActor = account.owner;
      }
      const target = request.handoff ?? request;
      const previous = old
        ? {
            actor: old.actor,
            ...(old.agent ? { agent: old.agent } : {}),
            ...(old.sessionId ? { sessionId: old.sessionId } : {}),
            since: old.since,
            lastSeen: old.lastSeen,
          }
        : null;
      if (request.handoff) {
        const offer = holderOfferSchema.parse({
          laneId: lane.id,
          from: previous,
          to: {
            actor: nextActor,
            sessionId: request.handoff.sessionId,
            ...(request.handoff.agent ? { agent: request.handoff.agent } : {}),
          },
          ...(reason ? { reason } : {}),
          savedHead: lane.head,
          at: now,
        });
        const selected = selection(input.projectId, lane, sourceAuthority(project));
        const result = {
          kind: 'handoff-offered',
          offerId: request.operationId,
          offer,
          holder: old ?? null,
          lane: selected,
          laneId: lane.id,
        };
        const outcome = { status: 'completed' as const, result };
        await emitChange(ctx, {
          ...auth,
          source: 'work',
          // The feed is readable by readers and, on a public project, by any signed-in account: kind only. Who held
          // the Lane, who takes it and why stay in the protected Lane record and offer receipt (SI-04).
          action: `holder handoff offered: v${lane.version}`,
          laneId: lane.id,
          intentId: lane.intentId,
          head: lane.head,
        });
        await finishHostedOperation(ctx, {
          ...auth,
          receipt: {
            attemptId: prepared.operation.firstAttempt.id,
            at: prepared.operation.firstAttempt.at,
            outcome,
          },
        });
        return canonicalPayload({ ...outcome, observedLane: selected });
      }
      invariant(
        same || !takeoverNeedsReason(Boolean(old && now - old.lastSeen <= PRESENCE.workingMs)) || reason,
        'BAD_ARGUMENT',
        'Give a reason for replacing a live holder.',
      );
      const kind =
        same && !accepted
          ? 'resume'
          : accepted
            ? 'handoff'
            : old && now - old.lastSeen > PRESENCE.workingMs
              ? 'take-back'
              : 'takeover';
      const name = kind === 'resume' ? (old!.agent ?? target.agent) : target.agent;
      const holder: NonNullable<z.infer<typeof hostedLaneSchema>['holder']> = {
        actor: kind === 'resume' ? old!.actor : nextActor,
        sessionId: kind === 'resume' ? old!.sessionId! : target.sessionId,
        ...(name ? { agent: name } : {}),
        since: kind === 'resume' ? old!.since : now,
        lastSeen: now,
        change: {
          operationId: request.operationId,
          kind,
          by: actor,
          previous,
          ...(reason ? { reason } : {}),
          savedHead: lane.head,
        },
      };
      const next = { ...lane, version: lane.version + 1, holder, at: prepared.operation.firstAttempt.at };
      await writeHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        authorityEpoch: request.authorityEpoch,
        expectedVersion: lane.version,
        overlap: {
          agent: holder.agent ?? null,
          holderChanged: true,
          session: sessionIdentity(holder.sessionId!, request.session, holder.since, ctx.forgeDevice),
        },
        record: next,
      });
      await emitChange(ctx, {
        ...auth,
        source: 'work',
        action: `holder ${kind}: v${next.version}`, // Kind only, as above (SI-04).
        intentId: lane.intentId,
        laneId: lane.id,
        head: lane.head,
      });
      const selected = selection(input.projectId, next, sourceAuthority(project));
      const result = {
        laneId: lane.id,
        head: lane.head,
        sourceVersion: lane.sourceVersion,
        holder,
        kind,
        lane: selected,
      };
      const outcome = { status: 'completed' as const, result };
      await finishHostedOperation(ctx, {
        ...auth,
        receipt: {
          attemptId: prepared.operation.firstAttempt.id,
          at: prepared.operation.firstAttempt.at,
          outcome,
        },
      });
      return canonicalPayload({ ...outcome, observedLane: selected });
    } catch (error) {
      return report(error);
    }
  },
});
