// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { projectSource } from './projectGithubMirror';
import { r2SegmentStore } from './projectStateTreeStore';
import { convertStateTree } from '../src/state-tree-save';
import { treeFile } from '../src/state-tree';
import { parseNativeState } from '../src/native-state-format';
import type { TreeFile } from '../src/state-tree-format';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import { mapExchange } from '../src/exchange-parallel';

/** Files one conversion reads in this single action; a larger State needs a resumable job. */
export const convertFileLimit = 20_000;
/** One-time conversion of a State with no tree form (default: main's head), for a project with
 * tree writes on. It reads every file once to derive its Git id (the only O(repository bytes)
 * step of the tree form), writes one segment, and records the pointer only after a cold reader
 * rebuilt the exact manifest from what R2 holds. One query per 100 files; safe to run again. */
export const convert = internalAction({
  args: { projectId: v.id('hostedProjects'), state: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, { projectId, state }): Promise<Record<string, unknown>> => {
    const started = Date.now();
    const plan: {
      stateTrees: { write?: boolean };
      state: string | null;
      size: number | null;
      stateTree: unknown;
    } = await ctx.runQuery(internal.projectStateTrees.status, {
      projectId,
      ...(state === undefined ? {} : { state }),
    });
    invariant(plan.stateTrees.write, 'BAD_ARGUMENT', 'Tree writes are off for this project.');
    invariant(plan.state && plan.size, 'SOURCE_UNAVAILABLE', 'The State is absent.');
    if (plan.stateTree) return { status: 'current', state: plan.state, pointer: plan.stateTree };
    let calls = 1;
    const source = projectSource(ctx, ids => {
      calls++;
      return ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId, digests: ids });
    });
    const manifest = new Uint8Array(await (await source.blobs([plan.state]))[0]!.read());
    invariant(digest(manifest) === plan.state, 'SOURCE_HASH_MISMATCH', 'The State changed.');
    const files = parseNativeState(manifest).files,
      key = (file: { blob: string; mode: string }) => `${file.mode === 'gitlink'}:${file.blob}`,
      unique = [...new Map(files.map(file => [key(file), file])).values()],
      known = new Map<string, TreeFile>();
    invariant(
      unique.length <= convertFileLimit,
      'BAD_ARGUMENT',
      `One conversion reads at most ${convertFileLimit} files.`,
    );
    let readBytes = 0;
    for (let at = 0; at < unique.length; at += 100) {
      const window = unique.slice(at, at + 100),
        objects = await source.blobs(window.map(file => file.blob));
      await mapExchange(
        window.map((file, i) => ({ file, object: objects[i]! })),
        16,
        async ({ file, object }) => {
          const bytes = new Uint8Array(await object.read());
          readBytes += bytes.length;
          known.set(key(file), treeFile(file, bytes));
        },
      );
    }
    const segments = r2SegmentStore(ctx, projectId),
      written = await convertStateTree(segments.store, manifest, file => ({
        ...known.get(key(file))!,
        mode: file.mode,
      }));
    if (!written.exact) return { status: 'refused', state: plan.state, code: written.reason };
    const recorded: boolean = await ctx.runMutation(internal.projectStateTrees.recordConversion, {
      projectId,
      state: plan.state,
      pointer: written.pointer,
      segments: segments.written,
    });
    return {
      status: recorded ? 'converted' : 'current',
      state: plan.state,
      pointer: written.pointer,
      files: files.length,
      readBytes,
      segmentBytes: written.bytes,
      records: written.records,
      convexCalls: calls + 1,
      r2: segments.stats,
      ms: Date.now() - started,
    };
  },
});
