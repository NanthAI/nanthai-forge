// SPDX-License-Identifier: Apache-2.0
'use node';
// The Code place's source reads (Item 90e5bc9c): one folder, one file page, or what one landing changed, at an exact
// State; a folder read adds the first page of each subfolder (Item a3b55a6e). Each read is the existing source reader
// (projectSourceReview, render path): the same access check before and after the bytes (public projects included, signed-out reads charged), the same verified State and blob pins, and no
// signed URL or object key in the reply. The browser receives the folders it opened and 16,000-character file pages,
// never the whole State.
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { readSourceReview } from './projectSourceReview';
import { report } from './errors';
import { invariant } from '../src/errors';
import {
  ancestors,
  changedPaths,
  folderPage,
  pathKind,
  withChildren,
  CODE_DIR_DEPTH,
  CODE_TOUCHED_PAIRS,
} from '../src/code-tree';
import { safeRelative } from '../src/safe-relative';

const state = /^[a-f0-9]{64}$/;
type Listed = {
  available: boolean;
  reason?: string;
  paths?: { path: string; status: string; after: { mode: string } | null }[];
};

export const read = action({
  args: {
    projectId: v.id('hostedProjects'),
    /** The exact State to read (main's head, a landing's, a Lane's or a Candidate's). */
    state: v.string(),
    /** open: a folder and its ancestors, or a file with its folders and first page; more: the next page of one
     * folder; page: the next page of one file; changes: what changed from `base` to `state`; touched: which of up to
     * eight landings (their base and head States) changed `path`. */
    want: v.union(
      v.literal('open'),
      v.literal('more'),
      v.literal('page'),
      v.literal('changes'),
      v.literal('touched'),
    ),
    path: v.optional(v.string()),
    base: v.optional(v.string()),
    cursor: v.optional(v.number()),
    offset: v.optional(v.number()),
    pairs: v.optional(v.array(v.object({ base: v.string(), head: v.string() }))),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const path = input.path ?? '';
      invariant(
        state.test(input.state) &&
          (input.base === undefined || state.test(input.base)) &&
          (path === '' || (safeRelative(path) && path.split('/').length <= CODE_DIR_DEPTH + 1)) &&
          (input.cursor === undefined || (Number.isSafeInteger(input.cursor) && input.cursor >= 0)) &&
          (input.offset === undefined || (Number.isSafeInteger(input.offset) && input.offset >= 0)) &&
          (input.pairs ?? []).length <= CODE_TOUCHED_PAIRS &&
          (input.pairs ?? []).every(pair => state.test(pair.base) && state.test(pair.head)),
        'BAD_ARGUMENT',
        'Select an exact State and a path inside it.',
      );
      const backupId = await ctx.runQuery(internal.projectCode.checkpoint, { projectId: input.projectId });
      invariant(backupId, 'SOURCE_UNAVAILABLE', 'This project has no stored source yet.');
      const actor = (await ctx.auth.getUserIdentity())?.subject ?? '';
      const review = (base: string, extra: Record<string, unknown> = {}, head = input.state) =>
        readSourceReview(
          ctx,
          { projectId: input.projectId, backupId, base, head, ...extra },
          actor,
          true,
        ) as Promise<Record<string, unknown>>;
      const page = async (file: string, offset?: number) => {
        const value = await review(input.state, { file, afterOffset: offset });
        if (!value.available) return { available: false, reason: value.reason };
        const {
          file: entry,
          after,
          submodule,
        } = value as {
          file: { path: string; after: { blob: string; mode: string } | null };
          after: unknown;
          submodule?: unknown;
        };
        return {
          available: true,
          path: entry.path,
          blob: entry.after?.blob ?? null,
          mode: entry.after?.mode ?? null,
          page: after,
          ...(submodule ? { submodule } : {}),
        };
      };
      if (input.want === 'touched') {
        // One comparison per landing, two at a time: the same two State reads each, and no file bytes.
        const pairs = input.pairs ?? [];
        const touched: (string | null)[] = new Array(pairs.length).fill(null);
        for (let i = 0; i < pairs.length; i += 2)
          await Promise.all(
            pairs.slice(i, i + 2).map(async (pair, j) => {
              const listed = (await review(pair.base, {}, pair.head)) as Listed;
              const found = listed.paths?.find(entry => entry.path === path);
              touched[i + j] = listed.available ? (found?.status ?? 'absent') : null;
            }),
          );
        return JSON.stringify({ state: input.state, path, touched });
      }
      if (input.want === 'page')
        return JSON.stringify({ state: input.state, file: await page(path, input.offset) });
      const listed = (await review(input.base ?? input.state)) as Listed;
      if (!listed.available)
        return JSON.stringify({ state: input.state, available: false, reason: listed.reason });
      if (input.want === 'changes')
        return JSON.stringify({ state: input.state, base: input.base, ...changedPaths(listed.paths ?? []) });
      // The State's own files (a comparison also lists deleted paths; a folder read never does).
      const files = (listed.paths ?? []).flatMap(entry =>
        entry.after ? [{ path: entry.path, mode: entry.after.mode }] : [],
      );
      // A folder comes with its subfolders' first pages; `ahead` names the folder whose next level is listed.
      if (input.want === 'more')
        return JSON.stringify({
          state: input.state,
          dirs: withChildren(files, folderPage(files, path, input.cursor)),
          ahead: path,
        });
      const kind = pathKind(files, path);
      if (!kind) return JSON.stringify({ state: input.state, files: files.length, missing: path });
      const way = ancestors(path, kind === 'dir').map(dir => folderPage(files, dir));
      return JSON.stringify({
        state: input.state,
        files: files.length,
        kind,
        dirs: [...way.slice(0, -1), ...withChildren(files, way.at(-1)!)],
        ahead: way.at(-1)!.path,
        ...(kind === 'file' ? { file: await page(path, input.offset) } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
