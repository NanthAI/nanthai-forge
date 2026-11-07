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
        signatures: rows.map(row => ({ keyId: row.keyId, signature: row.signature })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** One write per signing. Repeating an identical signature is a no-op; a different signature for
 * the same State and key, or more than the per-State limit, is refused. */
export const put = mutation({
  args: { projectId: v.id('hostedProjects'), head: v.string(), keyId: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to sign a release.');
      await activeOwnedProject(ctx, input.projectId, user.subject);
      const head = state(input.head);
      const parsed = cliReleaseSignatureSchema.safeParse({ keyId: input.keyId, signature: input.signature });
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send a 16-hex key id and a base64 Ed25519 signature.');
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
        actor: user.subject,
        at: Date.now(),
      });
      return JSON.stringify({ head, keyId: signed.keyId, stored: true });
    } catch (error) {
      return report(error);
    }
  },
});
