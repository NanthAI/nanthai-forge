// SPDX-License-Identifier: Apache-2.0
'use node';
// The base-checkpoint scrub of one purged comment (Item b6588425 line 2d), a step of
// convex/projectCommentPurgeArchive.ts. The comment's words are in the stored base: its planningComments record, the
// hostedEvents record that wrote it (and, for a decision, the derived body version), as content-addressed objects
// and the record packs over them, pinned by the backup's exchange root. The step builds a scrubbed root
// (src/work-base-scrub.ts: those records in their purged form, the packs rebuilt, the whole-Work digest measured
// again in one pass over the base), stores its new objects, publishes it on the backup and tombstones the old objects
// in one mutation (convex/projectCommentPurgeBaseStore.ts), then deletes their bytes from R2 (the save-purge
// primitives). Cost per purge: the base's metadata trees, every record once (by pack where the root packs them), a
// few new objects (records, packs, changed tree chunks, the root) and three small mutations; nothing while idle.
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { storeProjectArtifact } from './projectArtifactActions';
import { purgeR2Bytes } from './r2Operations';
import { r2Config } from './r2';
import {
  backupRootPin,
  commentScrubTargets,
  scrubbableRoot,
  scrubExchange,
  type ScrubTarget,
} from '../src/work-base-scrub';
import { decisionVersionValue } from '../src/work-planning-purge';
import { objectChunkPageSchema, objectRecipeSchema } from '../src/object-chunks';
import { invariant } from '../src/errors';

type Identity = { projectId: Id<'hostedProjects'>; itemId: string; commentId: string; operationId: string };
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
  const targets: ScrubTarget[] = commentScrubTargets(input.commentId);
  const decision = plan.decision;
  if (decision)
    targets.push({
      collection: 'planningItems',
      key: decision.key,
      transform: value => decisionVersionValue(value, decision, decision.request),
    });
  const scrub = await scrubExchange({
    rootBytes,
    read,
    targets,
    purgeOperationId: input.operationId,
    ...(backup.scrubbed ? { originalWork: backup.scrubbed.originalWork } : {}),
  });
  if (!scrub) return { previous, scrub: undefined };
  for (const bytes of scrub.objects.values())
    await storeProjectArtifact(ctx, input.projectId, plan.owner, bytes);
  const replaced = [...scrub.replaced, scrub.previousWork];
  replaced.push(...(await recipeParts(ctx, input, replaced, read)).filter(pin => !scrub.keeps(pin.sha256)));
  return { previous, scrub, replaced };
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

/** Run the scrub step to its end: build and publish, then delete the replaced bytes and mark it done. */
export async function scrubBase(ctx: ActionCtx, input: Identity) {
  const identity = { projectId: input.projectId, commentId: input.commentId, operationId: input.operationId };
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
