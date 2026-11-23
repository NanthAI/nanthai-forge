// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { trialReader } from './projectHostedConflictRead';
import { trialMerge } from '../src/hosted-trial-merge';
import { mergePathsOf } from '../src/native-docs-resolve';
import { FORGE_CONFIG_FILE, type DeclaredMergePaths } from '../src/project-config';
import { type TrialObject, type TrialPlan } from '../src/hosted-trial-plan';
import { rawContent } from './projectObjectContent';
import type { ObjectView } from './projectObjectFind';
import { candidateFileListSchema } from '../src/hosted-compose';
import { sameBytesPaths } from '../src/hosted-would-conflict';
import type { SameBytes, SameBytesCheck } from './projectHostedLandingWouldConflict';

const mainStateOf = (ctx: ActionCtx, projectId: Id<'hostedProjects'>) =>
  ctx.runQuery(
    makeFunctionReference<
      'query',
      { projectId: Id<'hostedProjects'> },
      { head: string; state: TrialObject } | null
    >('projectHostedConflicts:mainState'),
    { projectId },
  );
/** Warm action processes keep the last main head's merge lists: main moves a few times an hour, so
 * most conflicts reuse them without re-reading main's State (megabytes at dogfood scale). The same
 * entry also keeps that head's path entries (blob and mode per path, no bytes) for the same-bytes
 * comparison, so a main State is fetched at most once per head per process. */
let lastMain:
  | {
      projectId: string;
      head: string;
      /** Absent when forge.json could not be read: that is not remembered as "no lists". */
      declared?: DeclaredMergePaths;
      entries?: ReadonlyMap<string, { blob: string; mode: string }>;
      /** The paths `entries` answers for; absent means every path of the State. */
      known?: ReadonlySet<string>;
    }
  | undefined;
/** Past this many paths a warm process keeps only the asked paths' entries (about 250 bytes each, so
 * a full map stays near 5 MB); another path on the same head then reads the State again. */
const CACHED_MAIN_PATHS = 20_000;
const cachedMain = (projectId: string, head: string) =>
  lastMain?.projectId === projectId && lastMain.head === head ? lastMain : undefined;
/** Main's forge.json merge lists, as compose reads them (from main only): from main's State the
 * caller already parsed, else main's current head State. None when absent or unreadable. */
async function mainMergeLists(ctx: ActionCtx, projectId: Id<'hostedProjects'>): Promise<DeclaredMergePaths> {
  const main = await mainStateOf(ctx, projectId).catch(() => null);
  if (!main) return mergePathsOf(undefined);
  const cached = cachedMain(projectId, main.head)?.declared;
  if (cached) return cached;
  // This read also keeps the head's entries for the same-bytes comparison, under the same cap (no
  // paths asked: past it, none are kept).
  return (await mainEntries(ctx, projectId, main, new Set())).declared;
}
/** One read of main's State: its forge.json merge lists and its path entries (blob and mode only; no
 * file bytes). Both are kept for this head. */
async function readMain(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  main: { head: string; state: TrialObject },
) {
  const head = main.head;
  const reader = trialReader(ctx, projectId, { laneId: '', head, peers: [], tasks: [], objects: [] }, 'all');
  const files = await reader.state(main.state).catch(() => null);
  if (!files) return { declared: mergePathsOf(undefined), entries: undefined };
  const config = files.get(FORGE_CONFIG_FILE);
  const bytes = config?.mode === 'file' ? await reader.blob(config.blob).catch(() => undefined) : undefined;
  const declared = mergePathsOf(bytes);
  const readable = config?.mode !== 'file' || bytes !== undefined;
  const entries = reader.entries(main.state.digest);
  // A forge.json that could not be read is not remembered as "no lists".
  if (readable || entries)
    lastMain = { projectId, head, ...(readable ? { declared } : {}), ...(entries ? { entries } : {}) };
  return { declared, entries };
}
/** Main's lists and the entries at `paths`: from this head's cache when it answers them, else one
 * State read that fills it. */
async function mainEntries(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  main: { head: string; state: TrialObject },
  paths: ReadonlySet<string>,
) {
  const cached = cachedMain(projectId, main.head);
  if (cached?.declared && cached.entries && [...paths].every(path => !cached.known || cached.known.has(path)))
    return { declared: cached.declared, entries: cached.entries };
  const read = await readMain(ctx, projectId, main);
  if (read.entries && read.entries.size > CACHED_MAIN_PATHS && lastMain?.entries === read.entries)
    lastMain = {
      ...lastMain,
      entries: new Map(
        [...paths].flatMap(path => (read.entries!.has(path) ? [[path, read.entries!.get(path)!]] : [])),
      ),
      known: paths,
    };
  return read;
}

/** Same bytes are not a conflict (Item 36fd3295): main's lists and path entries (one State read per head per
 * warm process, shared with the lists cache), then each queued Candidate's own file listing (one
 * small R2 object each) against main's blobs at its shared paths. Unreadable keeps the advice. */
async function sameBytesOnMain(ctx: ActionCtx, projectId: Id<'hostedProjects'>, checks: SameBytesCheck[]) {
  const main = await mainStateOf(ctx, projectId).catch(() => null);
  if (!main) return { declared: mergePathsOf(undefined), same: [] as SameBytes };
  // This head's path entries are kept with its lists: later passes on the same head read nothing.
  const { declared, entries } = await mainEntries(
    ctx,
    projectId,
    main,
    new Set(checks.flatMap(check => check.paths)),
  );
  const same: SameBytes = [];
  if (entries)
    for (const check of checks)
      try {
        const raw = await rawContent(ctx, check.listing as unknown as ObjectView, {
          sha256: check.listing.digest,
          size: check.listing.size,
        });
        const listing = candidateFileListSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
        const paths = sameBytesPaths(check.paths, entries, listing);
        if (paths.length) same.push({ candidateId: check.candidateId, paths });
      } catch {
        // An unreadable listing leaves this Candidate's path advice as it was.
      }
  return { declared, same };
}

/** The would-conflict pass's one read of main's forge.json (a mutation cannot read R2): main's State,
 * then forge.json, then the pass again with `declared`. On any failure the pass runs with none, as
 * before (path advice only). Runs only when a landing would mark a queued entry. */
export const wouldConflictConfig = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    paths: v.array(v.string()),
    landedSubmissionId: v.string(),
    /** JSON SameBytesCheck[] from the first pass. Absent: main's lists only, and the pass hands off
     * once more with its checks. */
    checks: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { checks, ...input }) => {
    if (checks !== undefined) {
      const found = await sameBytesOnMain(ctx, input.projectId, JSON.parse(checks) as SameBytesCheck[]);
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingWouldConflict:mark'), {
        ...input,
        ...found,
      });
      return null;
    }
    const declared = await mainMergeLists(ctx, input.projectId);
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingWouldConflict:mark'), {
      ...input,
      declared,
    });
    return null;
  },
});

/** One save's trial merge (flip 4, Issue 853fcde3): reads the planned objects from R2, merges with
 * composition's rules and records the result in one mutation. Advisory: a failure is logged and
 * leaves no notice; the landing's own composition still decides. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), plan: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, plan: text }) => {
    const started = performance.now();
    const plan = JSON.parse(text) as TrialPlan;
    const reader = trialReader(ctx, projectId, plan);
    let found: Awaited<ReturnType<typeof trialMerge>>['conflicts'] = [];
    try {
      const files = await reader.prepare();
      // Merge rules come from main's pinned State (R2), read only when a merge needs them.
      const declared = async () => {
        const main =
          files ?? (plan.main ? await reader.state(plan.main.state).catch(() => undefined) : undefined);
        if (!main) return mainMergeLists(ctx, projectId);
        const config = main.get(FORGE_CONFIG_FILE);
        return mergePathsOf(
          config?.mode === 'file' ? await reader.blob(config.blob).catch(() => undefined) : undefined,
        );
      };
      const result = await trialMerge(plan.tasks, reader.read, declared);
      found = result.conflicts;
      console.log(
        `FORGE_TRIAL_MERGE ${JSON.stringify({
          lane: plan.laneId.slice(0, 8),
          files: plan.tasks.length,
          peers: plan.peers.length,
          merges: result.merges,
          conflicts: result.conflicts.length,
          unavailable: result.unavailable.length,
          bytes: reader.bytes,
          ms: Math.round(performance.now() - started),
        })}`,
      );
    } catch (error) {
      console.log(
        `FORGE_TRIAL_MERGE_FAILED ${JSON.stringify({
          lane: plan.laneId.slice(0, 8),
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        })}`,
      );
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedConflicts:record'), {
      projectId,
      laneId: plan.laneId,
      head: plan.head,
      peers: plan.peers,
      ...(plan.main ? { mainHead: plan.main.head } : {}),
      conflicts: found,
    });
    return null;
  },
});
