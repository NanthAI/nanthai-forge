// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { acceptancePage } from './projectHostedAcceptanceStore';
import { postSystemLaneNote } from './projectBoardSystem';
import { publicActorLabel } from './publicPeople';
import { fitNote } from './projectHostedApprovalStore';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { digest } from '../src/portable-hash';
import { landingAcceptedBySchema, type LandingAcceptedBy } from '../src/landing-accepted-by';

export function acceptedByNoteId(receiptId: string) {
  const hex = digest(JSON.stringify(['accepted-by', receiptId])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Issue fe5bea80: a landing a person accepted tells its Lane on the board, so the builder sees the
 * person's acceptance on its next action (6b6f17e7's builder read an owner-accepted landing as
 * unreviewed). Scheduled once from the landed transition, only for person acceptances, so the publish
 * transaction reads no input page. It reads the first input page (1 read) plus the note's own reads,
 * once per receipt (replay returns the first note). Auto-accepts post nothing. */
export async function noteAcceptedBy(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; receiptId: string; by: LandingAcceptedBy },
) {
  if (input.by.kind !== 'person' || !input.by.actor) return 'skipped' as const;
  const page = await acceptancePage(ctx, { ...input, kind: 'inputs', index: 0 });
  const lane = composeLaneSchema.safeParse(
    page ? validateComposePage(JSON.parse(page.value)).entries[0] : null,
  );
  if (!lane.success) return 'skipped' as const;
  const laneId = lane.data.laneId;
  const paths = input.by.paths?.length
    ? input.by.paths.join(', ') + (input.by.pathsMore ? ` +${input.by.pathsMore}` : '')
    : '';
  return postSystemLaneNote(ctx, {
    projectId: input.projectId,
    id: acceptedByNoteId(input.receiptId),
    toLaneId: laneId,
    fromLaneId: laneId,
    author: input.by.actor,
    text: fitNote(
      `@${await publicActorLabel(ctx, input.by.actor)} (a person) accepted this landing at ${input.by.at.slice(11, 16)}Z, receipt ${input.receiptId.slice(0, 8)}${paths ? '; protected paths ' : ''}`,
      paths,
      '. Reviewed, not an auto-accept.',
    ),
  });
}

export const accepted = internalMutation({
  args: { projectId: v.id('hostedProjects'), receiptId: v.string(), by: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await noteAcceptedBy(ctx, {
      projectId: input.projectId,
      receiptId: input.receiptId,
      by: landingAcceptedBySchema.parse(JSON.parse(input.by)),
    });
    return null;
  },
});
