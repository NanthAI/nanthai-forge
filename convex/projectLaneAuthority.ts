// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';

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
  if (actor === author) return;
  const project = await ctx.db.get(projectId);
  requireMemberAuthority({ owner: project?.owner ?? '' }, author, actor, record);
}
