// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { isDeviceIdentity } from './cliServer';
import { commandScope } from '../src/coordination-paths';
import {
  COORDINATION_LIMITS,
  type CoordinationChange,
  type CoordinationCommand,
  type StoredCoordinationCommand,
} from '../src/coordination-types';

type Ctx = QueryCtx | MutationCtx;
export const session = (ctx: Ctx, projectId: Id<'hostedProjects'>, sessionId: string) =>
  ctx.db
    .query('projectCoordinationSessions')
    .withIndex('by_project_and_session', q => q.eq('projectId', projectId).eq('sessionId', sessionId))
    .unique();
export const eventByOperation = (ctx: Ctx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
export const receipt = (ctx: Ctx, projectId: Id<'hostedProjects'>, messageId: string, actor: string) =>
  ctx.db
    .query('projectCoordinationReceipts')
    .withIndex('by_project_and_message_and_actor', q =>
      q.eq('projectId', projectId).eq('messageId', messageId).eq('actor', actor),
    )
    .unique();
export const claimById = (ctx: Ctx, projectId: Id<'hostedProjects'>, claimId: string) =>
  ctx.db
    .query('projectCoordinationClaims')
    .withIndex('by_project_and_claim', q => q.eq('projectId', projectId).eq('claimId', claimId))
    .unique();

/** A recipient is a session in this project or a current participant (owner or contributor). */
export async function resolveRecipient(ctx: Ctx, project: Doc<'hostedProjects'>, to: string) {
  const target = await session(ctx, project._id, to);
  if (target) return { recipientActor: target.actor, recipientSession: target.sessionId };
  const participant =
    project.owner === to ||
    !!(await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id).eq('contributor', to))
      .unique());
  invariant(participant, 'BAD_ARGUMENT', 'Select a session or participant in this project.');
  return { recipientActor: to, recipientSession: undefined };
}
/** People can answer for their own account sessions; devices must select the exact recipient session. */
export async function canAcknowledge(
  ctx: Ctx,
  message: Doc<'projectCoordinationEvents'>,
  actor: string,
  sessionId?: string,
) {
  if (message.command.kind !== 'message' && message.command.kind !== 'handoff') return false;
  if (message.recipientActor && message.recipientActor !== actor) return false;
  const legacyRecipient =
    message.kind === undefined && message.command.kind === 'message' ? message.command.recipient : undefined;
  const recipient = message.recipientSession ?? legacyRecipient;
  if (!recipient) return true;
  const target = await session(ctx, message.projectId, recipient);
  if (!target) return !message.recipientSession && legacyRecipient === actor;
  if (target.actor !== actor) return false;
  const identity = await ctx.auth.getUserIdentity();
  return Boolean(identity && (!isDeviceIdentity(identity) || target.sessionId === sessionId));
}

/** Stable key-ordered JSON so replay comparison survives backend key reordering and new limits. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Validates the kind-specific rules and applies claim/receipt state. Returns denormalized event fields. */
export async function applyCommand(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  operationId: string,
  parsed: Exclude<CoordinationCommand, { kind: 'activity' }>,
  at: number,
) {
  const projectId = project._id;
  if (parsed.kind === 'message' && parsed.recipient) return resolveRecipient(ctx, project, parsed.recipient);
  if (parsed.kind === 'handoff') return resolveRecipient(ctx, project, parsed.to);
  if (parsed.kind === 'ack') {
    const message = await eventByOperation(ctx, projectId, parsed.messageId);
    invariant(
      message?.command.kind === 'message' || message?.command.kind === 'handoff',
      'BAD_ARGUMENT',
      'Acknowledge a message or handoff operation in this project.',
    );
    invariant(
      await canAcknowledge(ctx, message, actor, parsed.sessionId),
      'BAD_ARGUMENT',
      'A directed message must be acknowledged by its recipient session.',
    );
    invariant(
      parsed.choice === undefined ||
        (message.command.kind === 'message' && message.command.choices?.includes(parsed.choice)),
      'BAD_ARGUMENT',
      'Answer with one of this message’s exact choices.',
    );
    const previous = await receipt(ctx, projectId, parsed.messageId, actor);
    invariant(
      parsed.choice === undefined || !previous?.choice || previous.choice === parsed.choice,
      'WORK_OPERATION_CHANGED',
      'This message already has your chosen answer.',
    );
    if (!previous)
      await ctx.db.insert('projectCoordinationReceipts', {
        projectId,
        messageId: parsed.messageId,
        actor,
        ackId: operationId,
        ...(parsed.choice !== undefined ? { choice: parsed.choice } : {}),
        at,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      });
    else if (parsed.choice !== undefined && !previous.choice)
      await ctx.db.patch(previous._id, { choice: parsed.choice, ackId: operationId, at });
    const scope = commandScope(message.command);
    const context = {
      ...(message.intentId || scope.intentId ? { intentId: message.intentId ?? scope.intentId } : {}),
      ...(message.laneId || scope.laneId ? { laneId: message.laneId ?? scope.laneId } : {}),
    };
    if (parsed.choice === undefined) return context;
    return {
      recipientActor: message.actor,
      ...('sessionId' in message.command && message.command.sessionId
        ? { recipientSession: message.command.sessionId }
        : {}),
      ...context,
    };
  }
  if (parsed.kind === 'claim') {
    const expiresAt = at + parsed.ttlSeconds * 1000,
      value = {
        paths: parsed.paths,
        intentId: parsed.intentId,
        laneId: parsed.laneId,
        note: parsed.note,
        sessionId: parsed.sessionId,
        at,
        expiresAt,
      };
    if (parsed.claimId) {
      const old = await claimById(ctx, projectId, parsed.claimId);
      invariant(
        old && old.actor === actor && !old.releasedAt,
        'BAD_ARGUMENT',
        'Renew one of your own unreleased claims, or omit claimId for a new claim.',
      );
      await ctx.db.patch(old._id, value);
    } else
      await ctx.db.insert('projectCoordinationClaims', { projectId, claimId: operationId, actor, ...value });
    return {};
  }
  if (parsed.kind === 'release') {
    const old = await claimById(ctx, projectId, parsed.claimId);
    invariant(old && old.actor === actor, 'BAD_ARGUMENT', 'Release one of your own claims in this project.');
    if (!old.releasedAt) await ctx.db.patch(old._id, { releasedAt: at });
    return {};
  }
  return {};
}
export function denormalized(command: StoredCoordinationCommand) {
  const scope = commandScope(command);
  return {
    kind: command.kind,
    ...(scope.intentId ? { intentId: scope.intentId } : {}),
    ...(scope.laneId ? { laneId: scope.laneId } : {}),
  };
}
/** Insert-only related-change observation inside the caller's transaction. Advisory; never moves source. */
export async function emitChange(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; operationId: string } & Omit<
    CoordinationChange,
    'kind'
  >,
) {
  const { projectId, actor, operationId, paths, pathCount, ...rest } = input;
  const command: CoordinationChange = {
    kind: 'change',
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(paths
      ? {
          paths: paths.slice(0, COORDINATION_LIMITS.changePaths),
          pathCount: Math.max(pathCount ?? 0, paths.length),
        }
      : {}),
  } as CoordinationChange;
  await ctx.db.insert('projectCoordinationEvents', {
    projectId,
    operationId,
    actor,
    at: Date.now(),
    command,
    ...denormalized(command),
  });
}
/** Best-effort fields of a hosted Work command for its change event. */
export function workChange(command: string) {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(command) as Record<string, unknown>;
  } catch {
    // Malformed commands never reach here; an unknown shape only loses detail.
  }
  const text = (key: string) =>
    typeof value[key] === 'string' && (value[key] as string).length <= COORDINATION_LIMITS.id
      ? (value[key] as string)
      : undefined;
  return { action: text('action'), intentId: text('intentId'), laneId: text('laneId'), head: text('head') };
}
