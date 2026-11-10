// SPDX-License-Identifier: Apache-2.0
import { saveDurationMs } from '../src/hosted-save';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { commitObjects } from './projectObjectCommit';
import { runConvexSourceStep } from './projectConvexSource';
import { runResolveChain } from './projectHostedResolveChain';
import { sourceResultInlineBytes } from './projectConvexSourceTransport';
import type { InlinePublication } from './projectSourcePublishInline';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { digest } from '../src/portable-hash';

const savePinOfText = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { sha256: digest(bytes), size: bytes.length };
};

/** Checked pack members that are exact UTF-8 text (delta pages are JSON), as preloaded entries. */
function heldText(held: Map<string, Uint8Array>) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return [...held].flatMap(([sha256, bytes]) => {
    try {
      return [{ sha256, size: bytes.length, text: decoder.decode(bytes) }];
    } catch {
      return [];
    }
  });
}
/** One call per save, sync or compose job (contract feature source-submit-run): commit the caller's
 * deferred uploads, submit with the dispatch in the same transaction, and run the first step here
 * instead of waiting for the scheduler. The step keeps its own budgets: a job it does not finish
 * continues on scheduled steps as before. The submit records a delayed fallback for that step, so a
 * lost action still completes; its commit cancels the fallback. Returns the submit receipt, or, when
 * the step finished the job and its commit published the result (feature source-run-publish), the
 * progress shape `{terminal, state}`; a save that names its resolve adds that resolve as `chain`,
 * run here from the save's own publication. */
export const submit = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    kind: v.union(v.literal('save'), v.literal('sync'), v.literal('compose')),
    /** Raw uploads to commit first (at most 100), as `projectObjectCommit:commitBatch` takes them. */
    objects: v.optional(v.array(v.object({ id: v.id('projectObjects') }))),
    /** A save's last delta page (save-submit-page). */
    clientMs: v.optional(v.number()),
    index: v.optional(v.number()),
    page: v.optional(v.string()),
    /** The job input text the caller uploaded (at most 64 KiB): the step checks it against the
     * job's input pin and reads it from memory instead of downloading it back. */
    input: v.optional(v.string()),
    /** Feature source-run-publish: when the step published the result, reply in the progress shape
     * (`{terminal, state, chain?}`). Without it the reply is the bare terminal receipt, as an older
     * CLI reads it. */
    progress: v.optional(v.boolean()),
    /** Feature save-settle-background (fea47345 C): a save returns `submitted` once its uploads are
     * committed and it is submitted (overlap paths recorded in that transaction); its step runs on
     * the scheduler, and the caller's next command reads the outcome. */
    settle: v.optional(v.literal('background')),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const receivedAt = Date.now();
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to submit hosted source.');
      invariant(
        input.input === undefined || new TextEncoder().encode(input.input).length <= sourceResultInlineBytes,
        'BAD_ARGUMENT',
        'Send only a small job input inline.',
      );
      invariant(
        input.settle === undefined || input.kind === 'save',
        'BAD_ARGUMENT',
        'Only a save settles in the background.',
      );
      const { objects, input: text, progress: shaped, settle, clientMs, ...submit } = input;
      // Upload-pack members the commit read and checked; the step reads small ones from memory.
      const held = new Map<string, Uint8Array>();
      const verified = objects?.length ? await commitObjects(ctx, user.subject, objects, held) : [];
      const measuredMs = saveDurationMs(clientMs, Math.max(0, Date.now() - receivedAt));
      const submitted: { payload: string; run: string | null } = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectSourceRunStore:submit'), {
          ...submit,
          ...(measuredMs === undefined ? {} : { clientMs: measuredMs }),
          actor: user.subject,
          ...(settle ? { background: true } : {}),
        }),
      );
      if (!submitted.run) return submitted.payload;
      let published: string | null = null;
      try {
        published = await runConvexSourceStep(
          ctx,
          { projectId: input.projectId, jobId: submitted.run, step: 0 },
          {
            inline: true,
            chain: input.kind === 'save',
            verified,
            // Keyed by its own digest: only the text whose pin the job names is ever served.
            preloaded: [...(text !== undefined ? [{ ...savePinOfText(text), text }] : []), ...heldText(held)],
          },
        );
      } catch {
        // The step recorded its failure; the scheduled fallback retries it and observation reports it.
      }
      if (!published) return submitted.payload;
      const { chainRun } = JSON.parse(published) as InlinePublication;
      const chained = chainRun ? await runResolveChain(ctx, chainRun) : null;
      return publishedReply(JSON.parse(published) as InlinePublication, chained, shaped === true);
    } catch (error) {
      return report(error);
    }
  },
});
/** The submit's reply once its step published: the bare receipt for an older CLI, else
 * `{terminal, state}` plus, for a save that names its resolve, that chain's progress (its receipt
 * when the chained step finished it, else `submitted`). The chain's identity stays server-side. */
export function publishedReply(published: InlinePublication, chained: string | null, shaped: boolean) {
  const { chainRun, ...progress } = published;
  if (!shaped) return canonicalPayload(progress.terminal);
  if (!chainRun) return canonicalPayload(progress);
  const chain = chained ? (JSON.parse(chained) as InlinePublication) : null;
  return canonicalPayload({
    ...progress,
    chain: chain
      ? {
          status: (chain.terminal as { outcome?: { status?: string } }).outcome?.status ?? 'submitted',
          terminal: chain.terminal,
          state: chain.state,
        }
      : { status: 'submitted' },
  });
}
