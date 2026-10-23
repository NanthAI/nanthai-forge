// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { publicationValidation } from './projectPublicationFields';
import { publicationPagePins } from '../src/publication-pin-window';
import { invariant } from '../src/errors';
import { isStored } from './projectObjectFields';
import { report } from './errors';

const identity = { id: v.id('projectPublications'), owner: v.string() };

/** Only the trusted action persists this summary after validating the complete
 * immutable metadata digest and semantics. Existing sessions upgrade lazily. */
export const prepare = internalMutation({
  args: { ...identity, metadataDigest: v.string(), validation: publicationValidation },
  returns: publicationValidation,
  handler: async (ctx, input) => {
    try {
      const session = await ctx.db.get(input.id);
      invariant(session?.owner === input.owner, 'PROJECT_UNAVAILABLE', 'Publication unavailable.');
      const project = await activeOwnedProject(ctx, session.projectId, input.owner);
      invariant(
        project.r2Writes &&
          session.cursor === session.pages &&
          session.metadataDigest === input.metadataDigest,
        'WORK_OPERATION_CHANGED',
        'Validate the complete original publication metadata.',
      );
      if (session.validation) return session.validation;
      await ctx.db.patch(input.id, { validation: input.validation, validated: false });
      return input.validation;
    } catch (error) {
      return report(error);
    }
  },
});

/** One bounded immutable page, committed pin checks and cursor in one transaction.
 * A lost reply replays the saved cursor without reading the verified page again. */
export const advance = internalMutation({
  args: { ...identity, position: v.number(), body: v.optional(v.string()) },
  returns: publicationValidation,
  handler: async (ctx, input) => {
    try {
      const session = await ctx.db.get(input.id);
      invariant(session?.owner === input.owner, 'PROJECT_UNAVAILABLE', 'Publication unavailable.');
      const project = await activeOwnedProject(ctx, session.projectId, input.owner);
      invariant(
        project.r2Writes,
        'PUBLICATION_CAPABILITY_CHANGED',
        'Use the existing publication path after R2 opt-out.',
      );
      const current = session.validation;
      invariant(
        current && input.position <= current.position,
        'WORK_OPERATION_CHANGED',
        'Resume the saved publication cursor.',
      );
      if (session.validated || input.position < current.position) return current;
      // The first action can reuse bytes from its authenticated complete scan.
      // Resumed actions load only the next unverified page. This argument is
      // internal-only, supplied by the same trusted validator as prepare.
      const body =
        input.body ??
        (
          await ctx.db
            .query('projectPublicationPages')
            .withIndex('by_publication_and_position', q =>
              q.eq('publicationId', input.id).eq('position', current.position),
            )
            .unique()
        )?.body;
      invariant(
        body !== undefined && current.position <= current.endPosition,
        'INVALID_WORK_BACKUP',
        'Publication page is missing.',
      );
      const { pins, tail } = publicationPagePins(
        current.tail,
        body.slice(current.offset, current.position === current.endPosition ? current.endOffset : undefined),
      );
      for (const pin of pins) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q =>
            q.eq('projectId', session.projectId).eq('digest', pin.sha256),
          )
          .unique();
        invariant(
          row && isStored(row) && !row.removed && row.size === pin.size,
          'PUBLISH_PIN_MISSING',
          'Publication pin has no committed object row.',
        );
      }
      const validation = {
        ...current,
        position: current.position + 1,
        offset: 0,
        tail,
        verified: current.verified + pins.length,
      };
      const complete = validation.verified === validation.total && tail.length === 0;
      invariant(
        validation.verified <= validation.total && (current.position < current.endPosition || complete),
        'INVALID_WORK_BACKUP',
        'Publication pin cursor differs from its validated metadata.',
      );
      await ctx.db.patch(input.id, { validation, validated: complete });
      return validation;
    } catch (error) {
      return report(error);
    }
  },
});
