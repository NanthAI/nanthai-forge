'use node';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { installationToken } from './githubAppToken';
import { githubRequest, GithubMirrorApiError } from '../src/hosted-github-api';
import { prepareMirror, stepMirror, type MirrorPlan, type MirrorIO } from '../src/hosted-github-mirror';
import { MemorySourceReader, MemoryMergeSource } from '../src/hosted-source-memory';
import { parseNativeState } from '../src/native-state-format';
import type { WorkerObject, WorkerPin } from '../src/hosted-source-worker-format';
import { ForgeError, invariant } from '../src/errors';
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
/** Same recipe-aware verified reader as the fixed source worker, with one
 * logical-file cache. Descriptors and storage grants are per 100-object window. */
export function mirrorSource(ctx: ActionCtx, input: { jobId: Id<'projectGithubMirrorJobs'>; step: number }) {
  type Location = { descriptor: WorkerObject; storageId: Id<'_storage'> | null; url: string | null };
  const locations = new Map<string, Location>();
  const source = new MemoryMergeSource({});
  const describe = async (ids: string[]) => {
    const rows: Location[] = JSON.parse(
      await ctx.runQuery(makeFunctionReference<'query'>('projectGithubMirrorObjects:resolve'), {
        ...input,
        digests: ids,
      }),
    );
    for (const row of rows) locations.set(row.descriptor.object.sha256, row);
    return rows.map(row => row.descriptor);
  };
  const reader = new MemorySourceReader(source, {
    describeBatch: describe,
    prepareRead: async pins => {
      const missing = pins.filter(pin => !locations.has(pin.sha256));
      for (let i = 0; i < missing.length; i += 100)
        await describe(missing.slice(i, i + 100).map(pin => pin.sha256));
    },
    read: async (pin: WorkerPin) => {
      if (!locations.has(pin.sha256)) await describe([pin.sha256]);
      const row = locations.get(pin.sha256)!;
      invariant(
        row.descriptor.object.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Mirror source size changed.',
      );
      const blob = row.storageId ? await ctx.storage.get(row.storageId) : null;
      if (blob) return blob.stream() as unknown as AsyncIterable<Uint8Array>;
      invariant(row.url, 'SOURCE_UNAVAILABLE', 'Mirror source bytes are unavailable.');
      const response = await fetch(row.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Mirror source download failed.');
      return response.body as unknown as AsyncIterable<Uint8Array>;
    },
    upload: async () => {
      throw new ForgeError('GITHUB_SYNC_READ_ONLY', 'Mirror reads existing source only.');
    },
  });
  const blobs: MirrorIO['blobs'] = async ids => {
    locations.clear();
    const refs = await describe(ids);
    return refs.map(ref => ({
      size: ref.object.size,
      read: async () => {
        source.objects.clear();
        return reader.bytes(ref);
      },
    }));
  };
  return {
    blobs,
    states: async (ids: string[]) => {
      const refs = await blobs(ids);
      const result = [];
      for (const ref of refs) result.push(parseNativeState(await ref.read()));
      return result;
    },
  };
}
export const step = internalAction({
  args: { jobId: v.id('projectGithubMirrorJobs'), step: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    let plan: MirrorPlan | undefined;
    let started: { phase: MirrorPlan['phase']; index: number } | undefined;
    try {
      const raw: string | null = await ctx.runMutation(mutation('projectGithubMirrorStore:begin'), input);
      if (!raw) return null;
      const loaded = JSON.parse(raw);
      const token = await installationToken(ctx, loaded.projectId, loaded.repository);
      const io: MirrorIO = { ...mirrorSource(ctx, input), api: githubRequest(token) };
      if (loaded.cursor) {
        const blob = await ctx.storage.get(loaded.cursor);
        invariant(blob, 'SOURCE_UNAVAILABLE', 'Durable mirror continuation is absent.');
        plan = JSON.parse(await blob.text());
      } else plan = await prepareMirror(loaded.seed, io);
      invariant(plan, 'SOURCE_UNAVAILABLE', 'Mirror continuation is unavailable.');
      started = { phase: plan.phase, index: plan.index };
      plan = await stepMirror(plan, io);
      const cursor =
        plan.phase === 'done'
          ? null
          : await ctx.storage.store(new Blob([JSON.stringify(plan)], { type: 'application/json' }));
      await ctx.runMutation(mutation('projectGithubMirrorStore:commit'), {
        ...input,
        cursor,
        mapping: plan.entry ? JSON.stringify(plan.entry) : null,
      });
    } catch (error) {
      // A failed request must not discard earlier verified blob replies in this
      // window. Persist that progress, but replay the failed call unchanged.
      const progress =
        error instanceof GithubMirrorApiError &&
        plan &&
        started &&
        (plan.phase !== started.phase || plan.index !== started.index);
      let cursor: Id<'_storage'> | undefined;
      let progressUnavailable = false;
      if (progress) {
        try {
          cursor = await ctx.storage.store(new Blob([JSON.stringify(plan)], { type: 'application/json' }));
        } catch {
          progressUnavailable = true;
        }
      }
      await ctx.runMutation(mutation('projectGithubMirrorStore:failed'), {
        ...input,
        code: error instanceof ForgeError ? error.code : 'GITHUB_SYNC_FAILED',
        ...(cursor ? { cursor } : {}),
        ...(error instanceof GithubMirrorApiError
          ? { httpStatus: error.status, apiOperation: error.operation, requestBytes: error.requestBytes }
          : {}),
        detail:
          (error instanceof ForgeError
            ? error.message
            : 'Mirror action failed. Resume the retained step to reconcile its outcome.') +
          (progressUnavailable
            ? ' Partial progress could not be checkpointed; retry uses the previous retained cursor.'
            : ''),
      });
    }
    return null;
  },
});
