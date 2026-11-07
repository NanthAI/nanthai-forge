// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { projectExecution } from './projectExecution';
import { hostedStartMain } from './projectHostedChannels';
import { requireListedKeySigned } from './projectReleaseSignatureVerify';
import { report } from './errors';
import { invariant } from '../src/errors';
import { sourceAuthority } from '../src/hosted-source-authority';
import { CLI_RELEASE_KEYS, type CliReleaseKey } from '../src/cli-release-keys';
import {
  CLI_RELEASE_READ_PROOF_SECONDS,
  CLI_RELEASE_SIGNATURES_PER_STATE,
  cliReleaseReadStatement,
  cliReleaseSignatureSchema,
  cliReleaseStateSchema,
  cliReleaseStatement,
} from '../src/cli-release-signature';

const state = (head: string) => {
  const parsed = cliReleaseStateSchema.safeParse(head);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Name a full Forge State hash.');
  return parsed.data;
};
const stateRows = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, head: string) =>
  ctx.db
    .query('projectReleaseSignatures')
    .withIndex('by_project_and_head', q => q.eq('projectId', projectId).eq('head', head))
    .take(CLI_RELEASE_SIGNATURES_PER_STATE);
/** A signed-out caller reaches the project only after its signature verified. */
async function liveProject(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable.');
  projectExecution(ctx, projectId, project.name, project.key);
  return project;
}

/** Signatures over released source States (docs/operations/cli-update.md, "Signed releases").
 * This is storage only: the CLI updater verifies each signature with the public keys of the build
 * it already runs, so a row here can make a signature present, never valid. The owner writes
 * (insert-only, a few rows per State); so does a signed-out caller whose signature verifies
 * against the listed keys (the automated signer). Anyone who may read the project reads one
 * State's rows. */
export const forState = query({
  args: { projectId: v.id('hostedProjects'), head: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read release signatures.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const head = state(input.head);
      const rows = await stateRows(ctx, input.projectId, head);
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

type PutInput = {
  projectId: Id<'hostedProjects'>;
  head: string;
  keyId: string;
  signature: string;
  release?: number | undefined;
};

/** One write per signing. Signed in, the project owner may store any well-formed signature (the
 * CLI verifies it). Signed out, only a v2 signature that verifies against `keys` (the CLI's
 * CLI_RELEASE_KEYS) for exactly this project, State and release number is stored; anything else
 * is refused before any database read. Repeating an identical signature is a no-op; a different
 * signature for the same State and key, or more than the per-State limit, is refused. A release
 * number must be above every other State's (one more indexed read) and equal to any number this
 * State already has: this catches signer mistakes. The updater's own floor stops downgrades. */
export async function putReleaseSignature(
  ctx: MutationCtx,
  input: PutInput,
  keys: readonly CliReleaseKey[] = CLI_RELEASE_KEYS,
) {
  const user = await ctx.auth.getUserIdentity();
  if (user) await activeOwnedProject(ctx, input.projectId, user.subject);
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
  if (!user) {
    invariant(
      signed.release !== undefined,
      'RELEASE_SIGNATURE_INVALID',
      'A signature stored without a sign-in must carry a release number (forge-cli-release/v2).',
    );
    requireListedKeySigned(
      signed.keyId,
      signed.signature,
      cliReleaseStatement(input.projectId, head, signed.release),
      keys,
    );
    await liveProject(ctx, input.projectId);
  }
  const rows = await stateRows(ctx, input.projectId, head);
  const same = rows.find(row => row.keyId === signed.keyId);
  if (same) {
    invariant(
      same.signature === signed.signature,
      'RELEASE_SIGNATURE_EXISTS',
      'This State already has a different signature from this key.',
    );
    return { head, keyId: signed.keyId, stored: false };
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
    actor: user ? user.subject : `release-key:${signed.keyId}`,
    at: Date.now(),
  });
  return {
    head,
    keyId: signed.keyId,
    ...(signed.release === undefined ? {} : { release: signed.release }),
    stored: true,
  };
}

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
      return JSON.stringify(await putReleaseSignature(ctx, input));
    } catch (error) {
      return report(error);
    }
  },
});

type SignerInput = {
  projectId: Id<'hostedProjects'>;
  head: string;
  keyId: string;
  at: number;
  proof: string;
};

/** The automated signer's one read, without a sign-in: main's head and release number (its source
 * revision), and whether `head` already has a numbered signature from `keyId`. The caller proves it
 * holds a listed release key by signing `forge-cli-release-read/v1` for this project, State and a
 * time within CLI_RELEASE_READ_PROOF_SECONDS; a wrong or stale proof is refused before any database
 * read. At most three reads: the project, main, and (only when `head` is main) its signatures. */
export async function signerMainRead(
  ctx: QueryCtx,
  input: SignerInput,
  keys: readonly CliReleaseKey[] = CLI_RELEASE_KEYS,
  now = Date.now(),
) {
  const head = state(input.head);
  invariant(
    Number.isSafeInteger(input.at) && Math.abs(now / 1000 - input.at) <= CLI_RELEASE_READ_PROOF_SECONDS,
    'RELEASE_SIGNATURE_INVALID',
    `The signer read proof must be made within ${CLI_RELEASE_READ_PROOF_SECONDS} s of the server clock.`,
  );
  requireListedKeySigned(
    input.keyId,
    input.proof,
    cliReleaseReadStatement(input.projectId, head, input.at),
    keys,
  );
  const project = await liveProject(ctx, input.projectId);
  const main = await hostedStartMain(ctx, input.projectId),
    authority = sourceAuthority(project);
  invariant(
    authority.mode !== 'native-owner' &&
      authority.mode === main.authority.mode &&
      authority.epoch === main.authority.epoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted main and project authority differ.',
  );
  const newest = main.head === head;
  const rows = newest ? await stateRows(ctx, input.projectId, head) : [];
  return {
    main: main.head,
    release: main.sourceRevision,
    newest,
    signed: rows.some(row => row.keyId === input.keyId && row.release !== undefined),
  };
}

export const signerMain = query({
  args: {
    projectId: v.id('hostedProjects'),
    head: v.string(),
    keyId: v.string(),
    at: v.number(),
    proof: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return JSON.stringify(await signerMainRead(ctx, input));
    } catch (error) {
      return report(error);
    }
  },
});
