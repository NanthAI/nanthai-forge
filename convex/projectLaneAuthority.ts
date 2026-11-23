// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { mayTakeLane } from './accessPolicy';

/**
 * Per-member authority on Lanes and landings (GitHub norm, owner 2026-11-07, Issue 8809fba5):
 * a contributor changes only their own Lanes, landings and overlap answers; the project owner
 * may act on anyone's, and that action stays recorded under the owner's own actor. Readers
 * change nothing (project authority already refuses them). Every public mutation that changes
 * a Lane or a landing picked by the client calls one of these helpers
 * (tests/hosted-member-authority.test.mjs keeps that true).
 */
export const mayActFor = (actor: string, author: string, owner: string | undefined) =>
  actor === author || actor === owner;

export type MemberRecord = 'Lane' | 'landing' | 'Candidate';

export function requireMemberAuthority(
  project: { owner: string },
  author: string,
  actor: string,
  record: MemberRecord,
) {
  invariant(
    mayActFor(actor, author, project.owner),
    'PROJECT_UNAVAILABLE',
    `Only the ${record} author or the project owner can act on this ${record}.`,
  );
}

/** Same rule when the project row is not in hand: the author's own call compares only;
 * the project is read only on the override path. */
export async function requireMemberAuthorityById(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  author: string,
  actor: string,
  record: MemberRecord,
) {
  // Keep the normal author's zero-read path, while every Lane uses the same named policy.
  if (actor === author) return;
  const project = await ctx.db.get(projectId);
  requireMemberAuthority({ owner: project?.owner ?? '' }, author, actor, record);
}

/** Taking over source never grants administrative ownership of the original person's Lane. */
export function requireLaneSourceAuthority(
  project: { owner: string },
  lane: { actor: string; holder?: unknown },
  actor: string,
) {
  if (!lane.holder) return requireMemberAuthority(project, lane.actor, actor, 'Lane');
  invariant(
    mayTakeLane(actor, lane.actor, project.owner),
    'PROJECT_UNAVAILABLE',
    'The current takeover policy does not allow this person to write this Lane.',
  );
}
export async function requireLaneSourceAuthorityById(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: { actor: string; holder?: unknown },
  actor: string,
) {
  if (lane.holder ? mayTakeLane(actor, lane.actor, '') : actor === lane.actor) return;
  const project = await ctx.db.get(projectId);
  requireLaneSourceAuthority({ owner: project?.owner ?? '' }, lane, actor);
}
