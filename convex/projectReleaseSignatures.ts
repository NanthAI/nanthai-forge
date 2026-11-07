// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import {
  CLI_RELEASE_SIGNATURES_PER_STATE,
  cliReleaseSignatureSchema,
  cliReleaseStateSchema,
} from '../src/cli-release-signature';

const state = (head: string) => {
  const parsed = cliReleaseStateSchema.safeParse(head);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Name a full Forge State hash.');
  return parsed.data;
};

/** Signatures over released source States (docs/operations/cli-update.md, "Signed releases").
 * This is storage only: the CLI updater verifies each signature with the public keys of the build
 * it already runs, so a row here can make a signature present, never valid. The owner writes
 * (insert-only, a few rows per State); anyone who may read the project reads one State's rows. */
export const forState = query({
  args: { projectId: v.id('hostedProjects'), head: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read release signatures.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const head = state(input.head);
      const rows = await ctx.db
        .query('projectReleaseSignatures')
        .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', head))
        .take(CLI_RELEASE_SIGNATURES_PER_STATE);
      return JSON.stringify({
        head,
        signatures: rows.map(row => ({
          keyId: row.keyId,
          signature: row.signature,
          ...(row.release === undefined ? {} : { release: row.release }),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** One write per signing. Repeating an identical signature is a no-op; a different signature for
 * the same State and key, or more than the per-State limit, is refused. A release number must be
 * above every other State's (one more indexed read) and equal to any number this State already
 * has: this catches signer mistakes. The updater's own floor, not this check, stops downgrades. */
export const put = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    head: v.string(),
    keyId: v.string(),
    signature: v.string(),
    release: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to sign a release.');
      await activeOwnedProject(ctx, input.projectId, user.subject);
      const head = state(input.head);
      const parsed = cliReleaseSignatureSchema.safeParse({
        keyId: input.keyId,
        signature: input.signature,
        ...(input.release === undefined ? {} : { release: input.release }),
      });
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Send a 16-hex key id, a base64 Ed25519 signature and a whole release number.',
      );
      const signed = parsed.data;
      const rows = await ctx.db
        .query('projectReleaseSignatures')
        .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', head))
        .take(CLI_RELEASE_SIGNATURES_PER_STATE);
      const same = rows.find(row => row.keyId === signed.keyId);
      if (same) {
        invariant(
          same.signature === signed.signature,
          'RELEASE_SIGNATURE_EXISTS',
          'This State already has a different signature from this key.',
        );
        return JSON.stringify({ head, keyId: signed.keyId, stored: false });
      }
      if (signed.release !== undefined) {
        const numbered = rows.find(row => row.release !== undefined);
        invariant(
          !numbered || numbered.release === signed.release,
          'RELEASE_NUMBER_MISMATCH',
          `This State is release ${numbered?.release}; sign it with that number.`,
        );
        const latest = numbered
          ? null
          : await ctx.db
              .query('projectReleaseSignatures')
              .withIndex('by_project_and_release', q => q.eq('projectId', input.projectId))
              .order('desc')
              .first();
        invariant(
          latest?.release === undefined || latest.release < signed.release,
          'RELEASE_NUMBER_NOT_NEWER',
          `Release ${signed.release} is not above the latest signed release ${latest?.release}.`,
        );
      }
      invariant(
        rows.length < CLI_RELEASE_SIGNATURES_PER_STATE,
        'RELEASE_SIGNATURE_LIMIT',
        `A State keeps at most ${CLI_RELEASE_SIGNATURES_PER_STATE} release signatures.`,
      );
      await ctx.db.insert('projectReleaseSignatures', {
        projectId: input.projectId,
        head,
        keyId: signed.keyId,
        signature: signed.signature,
        ...(signed.release === undefined ? {} : { release: signed.release }),
        actor: user.subject,
        at: Date.now(),
      });
      return JSON.stringify({
        head,
        keyId: signed.keyId,
        ...(signed.release === undefined ? {} : { release: signed.release }),
        stored: true,
      });
    } catch (error) {
      return report(error);
    }
  },
});
