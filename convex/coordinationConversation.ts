// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { isDeviceIdentity } from './cliServer';
import { mayTakeLane } from './accessPolicy';
import { hasWriteRole } from './projectRole';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { requireLaneHolder } from './projectLaneHolder';
import { planLaneItem } from './projectPlanLaneMarks';
import { openLaneForCoordination, session } from './coordinationWrite';
import { syncLaneSession } from './coordinationLaneSession';
import { hostedLaneSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { isAgentSlug } from '../src/agent-slug';
import type { CoordinationCommand } from '../src/coordination-types';
import { invariant } from '../src/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_LOOKUP_LIMIT = 50;
const PRESENCE_FALLBACK_LIMIT = 25;

async function resolveAccount(ctx: MutationCtx, target: string) {
  const handle = target.replace(/^@/, '').toLowerCase();
  const account = await ctx.db
    .query('accountHandles')
    .withIndex('by_handle', q => q.eq('handle', handle))
    .unique();
  return account?.owner ?? target;
}

async function person(ctx: MutationCtx, project: Doc<'hostedProjects'>, target: string) {
  const recipientActor = await resolveAccount(ctx, target);
  invariant(
    await hasWriteRole(ctx, project, recipientActor),
    'BAD_ARGUMENT',
    'Choose a person who contributes to this project.',
  );
  return recipientActor;
}

type AskScope = { laneId?: string; intentId?: string };

async function ensureLaneSession(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  presence: Doc<'projectHostedPresence'>,
) {
  await syncLaneSession(ctx, projectId, presence.laneId, {
    actor: presence.actor,
    ...(presence.agent ? { agent: presence.agent } : {}),
    ...(presence.session?.app ? { app: presence.session.app } : {}),
    goal: presence.goal,
    intentId: presence.intentId,
    at: presence.at,
  });
  const enrolled = await session(ctx, projectId, presence.laneId);
  if (enrolled && !enrolled.hasDirectedQuestions)
    await ctx.db.patch(enrolled._id, { hasDirectedQuestions: true });
  return presence.laneId;
}

async function markDirectedQuestion(
  ctx: MutationCtx,
  target: Pick<Doc<'projectCoordinationSessions'>, '_id' | 'hasDirectedQuestions'>,
) {
  if (!target.hasDirectedQuestions) await ctx.db.patch(target._id, { hasDirectedQuestions: true });
}

async function isSessionLive(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: Doc<'projectCoordinationSessions'>,
) {
  if (row.status === 'completed') return false;
  if (row.context.laneId && !(await openLaneForCoordination(ctx, projectId, row.context.laneId)))
    return false;
  return true;
}

async function findAgentSession(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  recipientActor: string,
  slug: string,
  scope: AskScope,
) {
  const rows = await ctx.db
    .query('projectCoordinationSessions')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', recipientActor))
    .order('desc')
    .take(SESSION_LOOKUP_LIMIT);
  const matching = rows.filter(
    row => row.kind !== 'person' && row.status !== 'completed' && row.name === slug,
  );
  if (matching.length) {
    matching.sort((a, b) => {
      const aOther = scope.laneId && a.sessionId === scope.laneId ? 1 : 0;
      const bOther = scope.laneId && b.sessionId === scope.laneId ? 1 : 0;
      if (aOther !== bOther) return aOther - bOther;
      const aSameIntent = scope.intentId && a.context.intentId === scope.intentId ? 0 : 1;
      const bSameIntent = scope.intentId && b.context.intentId === scope.intentId ? 0 : 1;
      if (aSameIntent !== bSameIntent) return aSameIntent - bSameIntent;
      return (b.lastActivity ?? b.lastSeen) - (a.lastActivity ?? a.lastSeen);
    });
    for (const candidate of matching)
      if (await isSessionLive(ctx, projectId, candidate)) {
        await markDirectedQuestion(ctx, candidate);
        return candidate.sessionId;
      }
  }
  // Miss fallback: an open Lane on the same Intent that predates automatic session enrolment.
  if (scope.intentId) {
    const peers = await ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_intent_and_at', q =>
        q.eq('projectId', projectId).eq('intentId', scope.intentId!),
      )
      .order('desc')
      .take(PRESENCE_FALLBACK_LIMIT);
    const presence = peers.find(row => row.actor === recipientActor && row.agent === slug);
    if (presence) return ensureLaneSession(ctx, projectId, presence);
  }
  return undefined;
}

async function askRecipient(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  target: string,
  scope: AskScope,
): Promise<{ recipientActor: string; recipientSession?: string }> {
  const cleaned = target.replace(/^@/, '');
  const notMember = `Recipient ${target} is not a write member of this project. Choose a write member handle, an active agent handle (handle/slug), or an open Lane UUID from lanes.`;
  if (UUID_RE.test(cleaned)) {
    const id = cleaned.toLowerCase();
    const existing = await session(ctx, project._id, id);
    if (existing && (await isSessionLive(ctx, project._id, existing))) {
      invariant(await hasWriteRole(ctx, project, existing.actor), 'BAD_ARGUMENT', notMember);
      await markDirectedQuestion(ctx, existing);
      return { recipientActor: existing.actor, recipientSession: existing.sessionId };
    }
    const presence = await ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_lane', q => q.eq('projectId', project._id).eq('laneId', id))
      .unique();
    if (presence) {
      invariant(await hasWriteRole(ctx, project, presence.actor), 'BAD_ARGUMENT', notMember);
      return {
        recipientActor: presence.actor,
        recipientSession: await ensureLaneSession(ctx, project._id, presence),
      };
    }
    invariant(
      false,
      'NOT_FOUND',
      `No open Lane or active session ${cleaned} in this project (it may have closed). List open Lanes or ask a project member handle.`,
    );
  }
  const slash = cleaned.lastIndexOf('/');
  if (slash > 0) {
    const ownerPart = cleaned.slice(0, slash);
    const slugPart = cleaned.slice(slash + 1).toLowerCase();
    invariant(
      isAgentSlug(slugPart),
      'BAD_ARGUMENT',
      `Recipient ${target} is not a valid agent handle (expected handle/word-word from lanes). List open Lanes or ask a project member handle.`,
    );
    const recipientActor = await resolveAccount(ctx, ownerPart);
    invariant(await hasWriteRole(ctx, project, recipientActor), 'BAD_ARGUMENT', notMember);
    const recipientSession = await findAgentSession(ctx, project._id, recipientActor, slugPart, scope);
    invariant(
      recipientSession,
      'NOT_FOUND',
      `Agent ${target} has no open Lane or active session in this project (it may have closed or not started yet). List open Lanes or ask @${ownerPart} directly.`,
    );
    return { recipientActor, recipientSession };
  }
  const recipientActor = await resolveAccount(ctx, cleaned);
  if (await hasWriteRole(ctx, project, recipientActor)) return { recipientActor };
  if (isAgentSlug(cleaned.toLowerCase())) {
    const slug = cleaned.toLowerCase();
    const recipientSession = await findAgentSession(ctx, project._id, actor, slug, scope);
    invariant(
      recipientSession,
      'NOT_FOUND',
      `Agent ${target} has no open Lane or active session for your account in this project. Pass handle/slug or a Lane UUID from lanes.`,
    );
    return { recipientActor: actor, recipientSession };
  }
  invariant(false, 'BAD_ARGUMENT', notMember);
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
    !(laneId && planningItemId),
    'BAD_ARGUMENT',
    `Pass either laneId (${laneId}) or planningItemId (${planningItemId}), not both.`,
  );
  invariant(
    Boolean(laneId) !== Boolean(planningItemId) &&
      message.recipient &&
      message.choices &&
      message.text.trim() &&
      Object.keys(message.context).every(key => key === 'laneId'),
    'BAD_ARGUMENT',
    'Choose a Lane (laneId) or an Item (planningItemId), a recipient, and two or three distinct answers.',
  );
  if (laneId) {
    const lane = await laneInProject(ctx, project, actor, laneId);
    const { recipientActor, recipientSession } = await askRecipient(ctx, project, actor, message.recipient, {
      laneId: lane.id,
      intentId: lane.intentId,
    });
    return {
      laneId: lane.id,
      intentId: lane.intentId,
      recipientActor,
      ...(recipientSession ? { recipientSession } : {}),
      conversation: true as const,
    };
  }
  invariant(
    await planLaneItem(ctx, project, planningItemId!),
    'NOT_FOUND',
    'Item not found in this project.',
  );
  const { recipientActor, recipientSession } = await askRecipient(ctx, project, actor, message.recipient, {
    intentId: planningItemId,
  });
  return {
    planningItemId,
    recipientActor,
    ...(recipientSession ? { recipientSession } : {}),
    conversation: true as const,
  };
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
