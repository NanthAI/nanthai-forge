// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { isDeviceIdentity } from './cliServer';
import { mayTakeLane } from './accessPolicy';
import { hasWriteRole } from './projectRole';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { requireLaneHolder } from './projectLaneHolder';
import { planLaneItem } from './projectPlanLaneMarks';
import { hostedLaneSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import type { CoordinationCommand } from '../src/coordination-types';
import { invariant } from '../src/errors';

async function person(ctx: MutationCtx, project: Doc<'hostedProjects'>, target: string) {
  const handle = target.replace(/^@/, '').toLowerCase();
  const account = await ctx.db
    .query('accountHandles')
    .withIndex('by_handle', q => q.eq('handle', handle))
    .unique();
  const recipientActor = account?.owner ?? target;
  invariant(
    await hasWriteRole(ctx, project, recipientActor),
    'BAD_ARGUMENT',
    'Choose a person who contributes to this project.',
  );
  return recipientActor;
}

async function laneInProject(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  laneId: string,
) {
  const row = await readHostedRecord(ctx, { projectId: project._id, actor, kind: 'lane', key: laneId });
  invariant(row, 'NOT_FOUND', 'Lane not found in this project.');
  return hostedLaneSchema.parse(JSON.parse(row.value));
}

export async function ask(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  message: Extract<CoordinationCommand, { kind: 'message' }>,
) {
  const laneId = message.context.laneId;
  const planningItemId = message.question?.planningItemId;
  invariant(
    Boolean(laneId) !== Boolean(planningItemId) &&
      message.recipient &&
      message.choices &&
      message.text.trim() &&
      Object.keys(message.context).every(key => key === 'laneId'),
    'BAD_ARGUMENT',
    'Choose a Lane or Item, a person, and two or three distinct answers.',
  );
  const recipientActor = await person(ctx, project, message.recipient);
  if (laneId) {
    const lane = await laneInProject(ctx, project, actor, laneId);
    return { laneId: lane.id, intentId: lane.intentId, recipientActor, conversation: true as const };
  }
  invariant(
    await planLaneItem(ctx, project, planningItemId!),
    'NOT_FOUND',
    'Item not found in this project.',
  );
  return { planningItemId, recipientActor, conversation: true as const };
}

export async function handBack(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  message: Extract<CoordinationCommand, { kind: 'handoff' }>,
  sessionId?: string,
) {
  invariant(message.laneId && message.handBack, 'BAD_ARGUMENT', 'Select a Lane to hand back.');
  const lane = await laneInProject(ctx, project, actor, message.laneId);
  invariant(
    mayTakeLane(actor, lane.actor, project.owner),
    'PROJECT_UNAVAILABLE',
    'Only this Lane’s person or the project owner may hand it back.',
  );
  const identity = await ctx.auth.getUserIdentity();
  if (actor !== project.owner || lane.holder?.actor === actor || (identity && isDeviceIdentity(identity)))
    requireLaneHolder(lane, actor, sessionId);
  const recipientActor = await person(ctx, project, message.to);
  invariant(
    mayTakeLane(recipientActor, lane.actor, project.owner),
    'PROJECT_UNAVAILABLE',
    'This Lane can go to its person or the project owner.',
  );
  invariant(
    lane.state === 'active' && lane.head === message.head,
    'WORK_STALE',
    'Read the Lane again. Its state or saved head changed.',
  );
  const { holder, ...unheld } = lane;
  if (holder) {
    await writeHostedRecord(ctx, {
      projectId: project._id,
      actor,
      authorityEpoch: sourceAuthority(project).epoch,
      expectedVersion: lane.version,
      // The holder event has its own timestamp. Save and undo use lane.at to date the saved head.
      record: { ...unheld, version: lane.version + 1 },
      overlap: { holderChanged: true, agent: null },
    });
  }
  return { laneId: lane.id, intentId: lane.intentId, recipientActor, conversation: true as const };
}
