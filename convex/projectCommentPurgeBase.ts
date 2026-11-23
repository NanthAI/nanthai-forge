// SPDX-License-Identifier: Apache-2.0
'use node';
// The base-checkpoint scrub of one purged comment (Item b6588425 line 2d), a step of
// convex/projectCommentPurgeArchive.ts, and of a whole purged Item (line 2e: every version, listed row, comment,
// Intent and Initiative record of the Item, src/work-base-scrub.ts itemScrub), a step of the Item purge's walk
// (convex/projectPlanningPurgeWalk.ts, through `scrubItem`). The comment's words are in the stored base: its planningComments record, the
// hostedEvents record that wrote it (and, for a decision, the derived body version), as content-addressed objects
// and the record packs over them, pinned by the backup's exchange root. The step builds a scrubbed root
// (src/work-base-scrub.ts: those records in their purged form, the packs rebuilt, the whole-Work digest measured
// again in one pass over the base), stores its new objects, publishes it on the backup and tombstones the old objects
// in one mutation (convex/projectCommentPurgeBaseStore.ts), then deletes their bytes from R2 (the save-purge
// primitives). Cost per purge: the base's metadata trees, every record once (by pack where the root packs them), a
// few new objects (records, packs, changed tree chunks, the root) and three small mutations; nothing while idle.
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { storeProjectArtifact } from './projectArtifactActions';
import { purgeR2Bytes } from './r2Operations';
import { r2Config } from './r2';
import {
  backupRootPin,
  commentScrubTargets,
  itemScrub,
  scrubbableRoot,
  scrubExchange,
  type ScrubTarget,
} from '../src/work-base-scrub';
import { exchangeRootSchema, isExchangeRoot } from '../src/native-exchange-tree';
import { decisionVersionValue } from '../src/work-planning-purge';
import { objectChunkPageSchema, objectRecipeSchema } from '../src/object-chunks';
import { invariant } from '../src/errors';

/** A comment's scrub (`commentId`) or a whole Item's (none). */
type Identity = { projectId: Id<'hostedProjects'>; itemId: string; commentId?: string; operationId: string };
type Plan = {
  owner: string;
  backupId: Id<'projectBackups'>;
  state: 'new' | 'publish' | 'delete' | 'done';
  decision?: { key: string; marker: string; redacted: string; request: string };
};

const baseRoot = async (ctx: ActionCtx, input: Identity, plan: Plan) => {
  const { backup }: { backup: Doc<'projectBackups'> } = await ctx.runQuery(internal.projectBackups.get, {
    id: plan.backupId,
    owner: plan.owner,
  });
  const reader = exchangeObjectReader(ctx, false, 0);
  const read = (pins: { sha256: string; size: number }[]) => reader.read(input.projectId, plan.owner, pins);
  const previous = backupRootPin(backup);
  const [rootBytes] = await read([previous]);
  return { backup, read, previous, rootBytes: rootBytes! };
};

/** What the scrub replaces, refused (before the purge's first step writes anything) for a base it cannot rewrite: a
 * legacy archive, another stored base, a root with no record catalog. One read of the root. */
export async function scrubPlan(ctx: ActionCtx, input: Identity): Promise<Plan> {
  const plan: Plan = await ctx.runQuery(internal.projectCommentPurgeBaseStore.plan, input);
  if (plan.state === 'new') scrubbableRoot((await baseRoot(ctx, input, plan)).rootBytes);
  return plan;
}

/** Build the scrubbed root over the backup's current root and store its new objects. Read-only for Work. One base
 * scrub runs per project at a time (convex/projectCommentPurge.ts), so only a new base checkpoint selected meanwhile
 * leaves a build unpublished: its objects are then unreferenced copies of that older base's records. */
async function buildScrub(ctx: ActionCtx, input: Identity, plan: Plan) {
  const { backup, read, previous, rootBytes } = await baseRoot(ctx, input, plan);
  const { targets, check, fields } = await scrubScope(ctx, input, plan);
  const scrub = await scrubExchange({
    rootBytes,
    read,
    targets,
    purgeOperationId: input.operationId,
    ...(backup.scrubbed ? { originalWork: backup.scrubbed.originalWork } : {}),
    ...(check ? { check } : {}),
    ...(fields ? { fields } : {}),
  });
  if (!scrub) return { previous, scrub: undefined };
  for (const bytes of scrub.objects.values())
    await storeProjectArtifact(ctx, input.projectId, plan.owner, bytes);
  const shared = await sharedParts(ctx, input, plan, read);
  // A backup naming the same old catalog keeps its tree.
  const catalogShared = shared.has(scrub.catalog.root);
  const replaced = [
    ...scrub.replaced.filter(pin => !(catalogShared && scrub.catalog.chunks.has(pin.sha256))),
    ...(shared.has(scrub.previousWork.sha256) ? [] : [scrub.previousWork]),
  ];
  replaced.push(
    ...(await recipeParts(ctx, input, replaced, read)).filter(
      pin => !scrub.keeps(pin.sha256) && !shared.has(pin.sha256) && !scrub.workChunks.has(pin.sha256),
    ),
  );
  return { previous, scrub, replaced };
}

/** The records a scrub replaces: one comment's (and a decision's derived body version), or a whole Item's, which
 * also checks every record of the base for a copy of the Item's words the list missed. */
async function scrubScope(
  ctx: ActionCtx,
  input: Identity,
  plan: Plan,
): Promise<{
  targets: ScrubTarget[];
  check?: (collection: string, bytes: Buffer) => void;
  fields?: (name: string, value: unknown) => unknown;
}> {
  if (input.commentId === undefined) {
    const item = await ctx.runQuery(internal.projectCommentPurgeBaseStore.itemTargets, {
      projectId: input.projectId,
      operationId: input.operationId,
    });
    return itemScrub({
      ...item,
      purgeOperationId: input.operationId,
      decisions: new Map(item.decisions as [string, string][]),
    });
  }
  const targets: ScrubTarget[] = commentScrubTargets(input.commentId);
  const decision = plan.decision;
  if (decision)
    targets.push({
      collection: 'planningItems',
      key: decision.key,
      transform: value => decisionVersionValue(value, decision, decision.request),
    });
  return { targets };
}

/** The whole Work each of the project's other backups names, and its recipe parts (recipe, pages, chunks): the
 * reference check that keeps an object the base's old whole Work shares with another live copy (the same Work, or
 * content-defined chunks that repeat across seeds). One root read per other backup, then its recipe and pages. Not
 * checked: a source-file recipe sharing a chunk (a chunk is Work bytes, a file chunk sharing one is not expected). */
async function sharedParts(
  ctx: ActionCtx,
  input: Identity,
  plan: Plan,
  read: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>,
) {
  const roots = await ctx.runQuery(internal.projectCommentPurgeBaseStore.otherRoots, {
    projectId: input.projectId,
    backupId: plan.backupId,
  });
  const works: { sha256: string; size: number }[] = [],
    catalogs: string[] = [];
  for (const root of roots) {
    const bytes = await read([root]).catch(() => [undefined]);
    if (!bytes[0]) continue;
    const value: unknown = JSON.parse(bytes[0].toString('utf8'));
    if (!isExchangeRoot(value)) continue;
    const parsed = exchangeRootSchema.safeParse(value);
    // A schema-1 root keeps its Work as a byte tree, not one object a recipe could store.
    if (parsed.success && parsed.data.schema === 2) {
      works.push(parsed.data.work);
      if (parsed.data.records) catalogs.push(parsed.data.records.sha256);
    }
  }
  return new Set([
    ...catalogs,
    ...works.map(pin => pin.sha256),
    ...(await recipeParts(ctx, input, works, read)).map(pin => pin.sha256),
  ]);
}

/** Every object a replaced object stored in chunks is made of: its recipe, the recipe's pages and their chunks. A
 * seed stores its whole work.json this way above 1 MiB. One read per recipe and per page. */
async function recipeParts(
  ctx: ActionCtx,
  input: Identity,
  replaced: { sha256: string; size: number }[],
  read: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>,
) {
  const parts = new Map<string, { sha256: string; size: number }>();
  const rows = await ctx.runQuery(internal.projectCommentPurgeBaseStore.recipes, {
    projectId: input.projectId,
    digests: replaced.map(pin => pin.sha256),
  });
  for (const row of rows) {
    const [bytes] = await read([row.recipe]);
    const recipe = objectRecipeSchema.parse(JSON.parse(bytes!.toString('utf8')));
    invariant(
      recipe.object.sha256 === row.digest && recipe.object.size === row.size,
      'INVALID_WORK_BACKUP',
      'Object recipe differs from its binding.',
    );
    parts.set(row.recipe.sha256, row.recipe);
    for (const pending = [recipe.tree]; pending.length;) {
      const tree = pending.pop()!;
      if (parts.has(tree.sha256)) continue;
      parts.set(tree.sha256, { sha256: tree.sha256, size: tree.size });
      if (!tree.height) continue;
      const [page] = await read([tree]);
      pending.push(...objectChunkPageSchema.parse(JSON.parse(page!.toString('utf8'))).children);
    }
  }
  return [...parts.values()];
}

const itemArgs = { projectId: v.id('hostedProjects'), itemId: v.string(), operationId: v.string() };
/** A whole Item purge's refusal of a base the scrub cannot rewrite, before its first step writes anything. */
export const checkItem = internalAction({
  args: itemArgs,
  returns: v.null(),
  handler: async (ctx, input) => {
    await scrubPlan(ctx, input);
    await ctx.runQuery(internal.projectCommentPurgeBaseStore.checkComments, {
      projectId: input.projectId,
      itemId: input.itemId,
    });
    return null;
  },
});
/** A whole Item purge's base scrub (line 2e), run to its end; a fixed point once done. */
export const scrubItem = internalAction({
  args: itemArgs,
  returns: v.null(),
  handler: async (ctx, input) => {
    await scrubBase(ctx, input);
    return null;
  },
});

/** Run the scrub step to its end: build and publish, then delete the replaced bytes and mark it done. */
export async function scrubBase(ctx: ActionCtx, input: Identity) {
  const identity = {
    projectId: input.projectId,
    operationId: input.operationId,
    ...(input.commentId !== undefined ? { commentId: input.commentId } : {}),
  };
  let plan = await scrubPlan(ctx, input);
  if (plan.state === 'publish') {
    const { previous, scrub, replaced } = await buildScrub(ctx, input, plan);
    if (scrub)
      await ctx.runMutation(internal.projectCommentPurgeBaseStore.publish, {
        ...identity,
        previous,
        root: scrub.root,
        manifestDigest: scrub.manifestDigest,
        originalWork: scrub.originalWork,
        replaced: replaced!,
      });
    else await ctx.runMutation(internal.projectCommentPurgeBaseStore.done, identity);
    plan = await scrubPlan(ctx, input);
  }
  if (plan.state === 'delete') {
    const pending = await ctx.runQuery(internal.projectCommentPurgeBaseStore.pending, identity);
    await purgeR2Bytes(r2Config(), pending);
    await ctx.runMutation(internal.projectCommentPurgeBaseStore.done, identity);
  }
}
