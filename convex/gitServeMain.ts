// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { storeSourceBytes } from './projectSourceBytes';
import { r2Config, r2Key } from './r2';
import { deleteR2Object } from './r2Operations';
import { workerConfig, workerServes } from './gitServeWorker';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import { published } from '../src/hosted-github-mirror';
import { gitHash, gitMode } from '../src/hosted-github-git';
import { mirrorMessage } from '../src/landing-message';
import { commitBytes, joinPacks, writePack, type PackObject } from '../src/git-lane-objects';
import {
  PackTrees,
  commitTree,
  listTree,
  objectSetBytes,
  readObjectSet,
  type TreeListing,
} from '../src/git-pack-trees';
import {
  TreeWork,
  readR2,
  scanPacks,
  storePack,
  treeBudget,
  type Chunk,
  type TreeStep,
} from './gitServeTrees';

/** Forge-built main commits (Issue 3bd4a8e9): one commit per landing after the imported history
 * on a project without a GitHub mirror, built on the first Git request after the landings. The
 * tree of each is its State published as the mirror would; unchanged entries keep the previous
 * commit's ids, so a build reads only the files the landings changed. Its pack holds the new
 * commits, trees and blobs and never an object stored history already has. */
type Landing = {
  sequence: number;
  receiptId: string;
  state: string;
  viewId: string;
  at: string;
  message?: string;
  cohortMessages?: string[];
  author: { name: string; email: string };
};
type Plan = {
  status: 'build';
  parent: { commit: string; state: string; tree: string | null; listing: Chunk | null };
  landings: Landing[];
  room: number;
  packs: { id: Id<'projectHistoryPacks'>; tip: string; chunks: Chunk[]; objectSet: Chunk | null }[];
  forge: { id: Id<'projectHistoryPacks'>; tip: string; bytes: number; chunks: Chunk[] }[];
};
const json = (bytes: Buffer | null) => (bytes ? JSON.parse(bytes.toString('utf8')) : null);
async function store(ctx: ActionCtx, projectId: Id<'hostedProjects'>, bytes: Buffer) {
  const pin = { sha256: digest(bytes), size: bytes.length };
  await storeSourceBytes(ctx, projectId, bytes, pin);
  return pin;
}
async function readChunks(projectId: string, chunks: Chunk[]) {
  const parts = [];
  for (const chunk of chunks) {
    const bytes = await readR2(projectId, chunk.sha256);
    invariant(bytes, 'GIT_PACK_UNAVAILABLE', 'Stored history could not be read.');
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

export async function buildMain(ctx: ActionCtx, projectId: Id<'hostedProjects'>, plan: Plan) {
  const started = Date.now();
  const work = new TreeWork(ctx, projectId);
  const metric = { landings: plan.landings.length, scanned: 0, setsRead: 0, merged: plan.forge.length };
  // Every object stored history holds: object sets kept on pack rows, else a scan of that pack
  // (the first build), which also finds the import commit's tree.
  const known = new Set<string>();
  const sets = new Map<string, Set<string>>();
  const newSets: { id: Id<'projectHistoryPacks'>; objectSet: Chunk }[] = [];
  let listing: TreeListing | null = null;
  const wanted = plan.parent.tree ? null : plan.parent.commit;
  let root = plan.parent.tree;
  for (const pack of plan.packs) {
    const stored = pack.objectSet ? await readR2(projectId, pack.objectSet.sha256) : null;
    if (stored) {
      metric.setsRead++;
      sets.set(pack.tip, readObjectSet(stored));
      continue;
    }
    const one = new PackTrees(treeBudget, { objects: true, ...(wanted ? { commit: wanted } : {}) });
    invariant(
      await scanPacks(projectId, [pack.chunks], one),
      'GIT_MAIN_TREE',
      'Forge could not read stored Git history to build main commits.',
    );
    metric.scanned += one.scanned;
    sets.set(pack.tip, one.objects!);
    newSets.push({ id: pack.id, objectSet: await store(ctx, projectId, objectSetBytes(one.objects!)) });
    if (wanted && one.commit) root = commitTree(one.commit);
    if (root && !listing) listing = listTree(one, root);
  }
  for (const set of sets.values()) for (const id of set) known.add(id);
  if (plan.parent.listing) {
    const stored = json(await readR2(projectId, plan.parent.listing.sha256)) as Record<
      string,
      [string, string]
    >;
    invariant(stored, 'GIT_MAIN_TREE', "The last Forge commit's tree listing is unavailable.");
    listing = new Map(Object.entries(stored).map(([path, [mode, sha]]) => [path, { mode, sha }]));
  }
  if (!listing && root) {
    // Object sets were stored but the parent's trees were not read: list them from the packs.
    const scan = new PackTrees(treeBudget);
    await scanPacks(
      projectId,
      plan.packs.map(pack => pack.chunks),
      scan,
      () => !!(listing = listTree(scan, root!)),
    );
    metric.scanned += scan.scanned;
  }
  invariant(
    root && listing,
    'GIT_MAIN_TREE',
    `Forge could not find the tree of Git commit ${plan.parent.commit.slice(0, 12)} in stored history.`,
  );

  // Commits, oldest landing first. A landing whose State equals the previous one adds none.
  const [parentState] = await work.states([plan.parent.state]);
  let step: TreeStep = await work.base(parentState!.files.filter(published('tracked')), root, {
    listing,
    code: 'GIT_MAIN_TREE',
    message: `Forge's tree for main State ${plan.parent.state.slice(0, 12)} differs from Git commit ${plan.parent.commit.slice(0, 12)}; landings are not published as Git commits.`,
  });
  let commit = plan.parent.commit,
    state = plan.parent.state;
  const objects: PackObject[] = [];
  const built: { state: string; commit: string; tree: string; sequence: number }[] = [];
  for (let at = 0; at < plan.landings.length; at += 10) {
    const page = plan.landings.slice(at, at + 10);
    const pageStates = [...new Set(page.map(landing => landing.state))];
    const values = await work.states(pageStates);
    const byId = new Map(pageStates.map((id, i) => [id, values[i]!]));
    for (const landing of page) {
      if (landing.state === state) continue;
      step = await work.next(step, byId.get(landing.state)!.files.filter(published('tracked')));
      const bytes = commitBytes({
        tree: step.tree.root,
        parent: commit,
        author: landing.author,
        at: landing.at,
        message: mirrorMessage({
          message: landing.message,
          cohortMessages: landing.cohortMessages,
          fallback: 'Forge landing',
          state: landing.state,
          acceptanceId: landing.receiptId,
          viewId: landing.viewId,
        }),
      });
      commit = gitHash('commit', bytes);
      objects.push({ type: 'commit', bytes }, ...(await work.objects(step, known)));
      state = landing.state;
      built.push({ state, commit, tree: step.tree.root, sequence: landing.sequence });
    }
  }
  if (!built.length) return null;
  const last = plan.landings.at(-1)!;
  const ids = objects.map(object => gitHash(object.type, object.bytes));
  // Geometric merge: the newest Forge packs join this one while they are at most twice its
  // size, so a project keeps about log2(n) Forge packs and rewrites each byte about log2(n) times.
  let packBytes = writePack(objects);
  const merged: Plan['forge'] = [];
  let size = packBytes.length;
  while (plan.forge.length > merged.length) {
    const row = plan.forge[plan.forge.length - 1 - merged.length]!;
    if (row.bytes > 2 * size) break;
    merged.unshift(row);
    size += row.bytes;
  }
  const objectIds = new Set(ids);
  if (merged.length) {
    const parts = [];
    for (const row of merged) {
      parts.push(await readChunks(projectId, row.chunks));
      for (const id of sets.get(row.tip) ?? []) objectIds.add(id);
    }
    packBytes = joinPacks([...parts, packBytes]);
  }
  invariant(
    packBytes.length - merged.reduce((sum, row) => sum + row.bytes, 0) <= plan.room,
    'HISTORY_OVER_LIMIT',
    "Forge's commits for main's landings would pass this project's history limit; the project owner can raise it (history limit).",
  );
  const pack = await storePack(ctx, projectId, packBytes);
  const listed = Object.fromEntries(
    step.items.map(item => [item.entry.path, [gitMode(item.entry.mode), item.entry.sha]]),
  );
  const recorded = await ctx.runMutation(internal.gitServeMainStore.record, {
    projectId,
    parent: plan.forge.at(-1)?.tip ?? plan.parent.commit,
    pack: {
      tip: commit,
      chunks: pack.chunks,
      bytes: pack.bytes,
      objects: pack.objects,
      packSha1: pack.packSha1,
      objectSet: await store(ctx, projectId, objectSetBytes(objectIds)),
      main: {
        state,
        tree: step.tree.root,
        sequence: last.sequence,
        listing: await store(ctx, projectId, Buffer.from(JSON.stringify(listed))),
      },
    },
    merged: merged.map(row => row.id),
    commits: built,
    objectSets: newSets,
  });
  for (const sha256 of new Set(recorded.discard))
    await deleteR2Object(r2Config(), r2Key(projectId, sha256)).catch(() => {});
  // A project the Worker serves gets the new pack framed and its clone trailer ahead of the
  // next clone, as for imported and catch-up packs (Issue 7c36abfb).
  const worker = workerConfig();
  if (recorded.recorded && worker && workerServes(worker, recorded.bytes))
    await ctx.scheduler.runAfter(0, internal.gitServeFrame.prepare, { projectId });
  console.log(
    `FORGE_GIT_MAIN_METRIC ${JSON.stringify({ projectId, ...metric, merged: merged.length, commits: built.length, objects: objects.length, packBytes: pack.bytes, ms: Date.now() - started, ...work.metric })}`,
  );
  return recorded.recorded ? commit : null;
}

/** Builds main's unpublished landings (one batch per call; the HTTP action calls it once per
 * ref listing that finds main ahead of stored history). Returns the failure to report, if any. */
export const build = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
  handler: async (ctx, { projectId }): Promise<{ code: string; message: string } | null> => {
    const plan = (await ctx.runQuery(internal.gitServeMainStore.plan, { projectId })) as
      | Plan
      | { status: 'current' | 'unavailable' };
    if (plan.status !== 'build' || !plan.landings.length) return null;
    if (
      !(await ctx.runMutation(internal.gitServeMainStore.claim, {
        projectId,
        head: plan.landings.at(-1)!.state,
      }))
    )
      return null;
    try {
      await buildMain(ctx, projectId, plan);
      return null;
    } catch (error) {
      if (error instanceof ForgeError) return { code: error.code, message: error.message };
      throw error;
    }
  },
});
