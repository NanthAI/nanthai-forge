// SPDX-License-Identifier: Apache-2.0
'use node';
// The Code place's source reads (Item 90e5bc9c): one folder, one file page, or what one landing changed, at an exact
// State; a folder read adds the first page of each subfolder (Item a3b55a6e). Each read uses the existing source reader
// and its access checks (including public read accounting), verified State and blob pins, and no
// signed URL or object key in the reply. The browser receives the folders it opened and 16,000-character file pages,
// never the whole State.
import { v, type ObjectType } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internalAction } from './server';
import { internal } from './_generated/api';
import { readSourceReview, renderCheckpointSource } from './projectSourceReview';
import { report } from './errors';
import { invariant } from '../src/errors';
import {
  ancestors,
  changedPaths,
  fileAt,
  folderPage,
  pathKind,
  withChildren,
  CODE_DIR_DEPTH,
  CODE_TOUCHED_PAIRS,
} from '../src/code-tree';
import { safeRelative } from '../src/safe-relative';
import { parseNativeState, type NativeFile } from '../src/state/format';
import { readSubmodulePointers } from '../src/gitlink';
import { reviewTextPage } from '../src/source-review-format';

const state = /^[a-f0-9]{64}$/;
type Listed = {
  available: boolean;
  reason?: string;
  paths?: { path: string; status: string }[];
};

const readArgs = {
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
};
type ReadInput = ObjectType<typeof readArgs>;

/** One Code read at an exact State, as `actor` ('' signed out): the access check is the checkpoint's, then the source
 * reader's around the bytes. */
async function readCode(ctx: ActionCtx, input: ReadInput, actor: string): Promise<string> {
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
  const review = (base: string, head = input.state) =>
    readSourceReview(ctx, { projectId: input.projectId, backupId, base, head }, actor, true);
  if (input.want === 'touched') {
    // One comparison per landing, two at a time: the same two State reads each, and no file bytes.
    const pairs = input.pairs ?? [];
    const touched: (string | null)[] = new Array(pairs.length).fill(null);
    for (let i = 0; i < pairs.length; i += 2)
      await Promise.all(
        pairs.slice(i, i + 2).map(async (pair, j) => {
          const listed = (await review(pair.base, pair.head)) as Listed;
          const found = listed.paths?.find(entry => entry.path === path);
          touched[i + j] = listed.available ? (found?.status ?? 'absent') : null;
        }),
      );
    return JSON.stringify({ state: input.state, path, touched });
  }
  if (input.want === 'changes') {
    const listed = (await review(input.base ?? input.state)) as Listed;
    if (!listed.available)
      return JSON.stringify({ state: input.state, available: false, reason: listed.reason });
    return JSON.stringify({ state: input.state, base: input.base, ...changedPaths(listed.paths ?? []) });
  }
  const base = input.want === 'page' ? input.state : (input.base ?? input.state);
  const result = await renderCheckpointSource(
    ctx,
    { projectId: input.projectId, backupId, base, head: input.state },
    actor,
    true,
    async bytes => {
      const [selected, compared] = await bytes(base === input.state ? [input.state] : [input.state, base]);
      const { files } = parseNativeState(selected!);
      if (compared) parseNativeState(compared);
      // Canonical writers sort by path. Older verified States may be unsorted.
      if (files.some((file, index) => index > 0 && files[index - 1]!.path > file.path))
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { opened: await openCode(input, path, files, bytes) };
    },
  );
  if (result.available) return JSON.stringify({ state: input.state, ...result.opened });
  const unavailable = { available: false, reason: result.reason };
  return JSON.stringify({
    state: input.state,
    ...(input.want === 'page' ? { file: unavailable } : unavailable),
  });
}

async function openCode(
  input: ReadInput,
  path: string,
  files: NativeFile[],
  bytes: (ids: string[]) => Promise<Buffer[]>,
) {
  const page = async () => {
    const entry = fileAt(files, path);
    invariant(entry, 'NOT_FOUND', 'Choose a file from this source comparison.');
    const [content] = await bytes([entry.blob]);
    const submodule =
      entry.mode === 'gitlink' ? (await readSubmodulePointers(files, bytes, entry.path))[0] : undefined;
    return {
      available: true,
      ...entry,
      page: reviewTextPage(content!, input.offset),
      ...(submodule ? { submodule } : {}),
    };
  };
  if (input.want === 'page') return { file: await page() };
  // A folder comes with its subfolders' first pages; `ahead` names the folder whose next level is listed.
  if (input.want === 'more')
    return {
      dirs: withChildren(files, folderPage(files, path, input.cursor)),
      ahead: path,
    };
  const kind = pathKind(files, path);
  if (!kind) return { files: files.length, missing: path };
  const way = ancestors(path, kind === 'dir').map(dir => folderPage(files, dir));
  return {
    files: files.length,
    kind,
    dirs: [...way.slice(0, -1), ...withChildren(files, way.at(-1)!)],
    ahead: way.at(-1)!.path,
    ...(kind === 'file' ? { file: await page() } : {}),
  };
}

export const read = action({
  args: readArgs,
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      return await readCode(ctx, input, (await ctx.auth.getUserIdentity())?.subject ?? '');
    } catch (error) {
      return report(error);
    }
  },
});

/** The same read for a signed-out visitor of a public project (Item 4c164732), run only by the cached public route
 * (publicHttp.ts) on a cache miss. It carries no identity: a private or removed project is refused like a missing one,
 * and the read is charged to the project's signed-out read budget. */
export const visitorRead = internalAction({
  args: readArgs,
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      return await readCode(ctx, input, '');
    } catch (error) {
      // Only a ConvexError keeps its code across runAction: the route maps codes to 404, 429 and 409.
      return report(error);
    }
  },
});
