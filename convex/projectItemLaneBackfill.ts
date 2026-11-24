// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { recordHead } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { successorIntentId } from '../src/hosted-intent-chain';
import { invariant } from '../src/errors';

const DEV = 'https://benevolent-wildebeest-974.convex.cloud';
const onlyDev = () =>
  invariant(
    process.env.CONVEX_CLOUD_URL === DEV,
    'PROJECT_UNAVAILABLE',
    'Item membership repair runs only on Forge dev.',
  );
const PAGE = 62;
const MIB = 1024 * 1024;
const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value)).length;
type Frontier =
  | { phase: 'roots' | 'lanes'; key: string | null }
  | { phase: 'chain'; itemId: string; key: string };

/** Run explicitly before switching readers, never from normal operations. Verify roots against
 * the Work Item or an explicit self-binding, then follow the deterministic hash edges before
 * projecting Lane membership. The checkpoint records a chain position, not a list of visited keys. */
export const run = internalMutation({
  args: { projectId: v.id('hostedProjects'), after: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, { projectId, after }) => {
    onlyDev();
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'This project is unavailable.');
    if (project.itemLaneMembership === true) return { scanned: 0, patched: 0, next: null };
    const previous = project.itemLaneMembership ?? null;
    // A duplicate request returns the durable frontier without reapplying the page.
    if (after !== previous) return { scanned: 0, patched: 0, next: previous };
    invariant(
      !project.itemPurges?.some(purge => !purge.commentId && purge.purgedAt === undefined),
      'WORK_STALE',
      'Finish active Item purges before continuing membership repair.',
    );
    const generation = await selectedGeneration(ctx, project);
    if (project.work && !generation) {
      const firstHead = (kind: 'intent' | 'lane') =>
        ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_key', q => q.eq('projectId', projectId).eq('kind', kind))
          .first();
      const [intent, lane] = await Promise.all([firstHead('intent'), firstHead('lane')]);
      invariant(
        !intent && !lane,
        'PROJECT_WORK_INDEX_MISSING',
        'Rebuild the Work index before repairing Item membership.',
      );
      // Certify the empty ranges and write the checkpoint in the same transaction.
      await ctx.db.patch(projectId, { itemLaneMembership: true });
      return {
        scanned: 0,
        patched: 0,
        next: null,
        readBytes: bytes(project),
        writeBytes: bytes(project) + 1024,
      };
    }
    const current: Frontier = after?.startsWith('{') ? JSON.parse(after) : { phase: 'roots', key: null };
    const workItem = (id: string) =>
      generation
        ? record(ctx, recordPartition(generation), 'planningSearch', id)
        : recordHead(ctx, projectId, 'issue', id);
    let scanned = 0;
    let patched = 0;
    let readBytes = bytes(project) + (generation ? bytes(generation) : 0);
    let writeBytes = bytes(project) + 1024;
    const account = <T extends object>(row: T | null) => {
      if (row) readBytes += bytes(row);
      return row;
    };
    // Reserve room for the next two reads, a bounded head patch, and the checkpoint.
    const room = () => scanned < PAGE && readBytes <= 6 * MIB && writeBytes <= 3 * MIB - 1024;
    const stamp = async (head: NonNullable<Awaited<ReturnType<typeof recordHead>>>, itemId: string) => {
      if (head.planningItemId === itemId) return;
      writeBytes += bytes({ ...head, planningItemId: itemId });
      await ctx.db.patch(head._id, { planningItemId: itemId });
      patched++;
    };
    const follow = async (chain: Extract<Frontier, { phase: 'chain' }>): Promise<Frontier> => {
      let key = chain.key;
      while (room()) {
        scanned++;
        const candidate = successorIntentId(key);
        const head = account(await recordHead(ctx, projectId, 'intent', candidate));
        // Never relabel a foreign explicit binding or an Item that owns this key itself.
        if (
          !head ||
          (head.planningItemId !== chain.itemId &&
            (head.planningItemId !== undefined || account(await workItem(candidate))))
        )
          return { phase: 'roots', key: chain.itemId };
        await stamp(head, chain.itemId);
        key = candidate;
      }
      return { ...chain, key };
    };
    let next: Frontier | null = current.phase === 'chain' ? await follow(current) : current;
    if (next.phase !== 'chain' && room() && readBytes <= 4 * MIB) {
      const { phase, key } = next;
      const kind = phase === 'roots' ? 'intent' : 'lane';
      const page = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q => {
          const range = q.eq('projectId', projectId).eq('kind', kind);
          return key === null ? range : range.gt('key', key);
        })
        .paginate({ cursor: null, numItems: PAGE, maximumRowsRead: PAGE, maximumBytesRead: MIB });
      const parents = new Map<string, string | null>();
      for (const head of page.page) account(head);
      let visited = 0;
      for (const head of page.page) {
        if (!room()) break;
        scanned++;
        visited++;
        next = { phase, key: head.key };
        if (phase === 'roots') {
          const binding = head.planningItemId;
          if (binding !== head.key && (binding || !account(await workItem(head.key)))) continue;
          await stamp(head, head.key);
          next = await follow({ phase: 'chain', itemId: head.key, key: head.key });
          if (next.phase === 'chain') break;
        } else if (!head.planningItemId) {
          let itemId = parents.get(head.parent);
          if (itemId === undefined) {
            itemId = account(await recordHead(ctx, projectId, 'intent', head.parent))?.planningItemId || null;
            parents.set(head.parent, itemId);
          }
          if (itemId) await stamp(head, itemId);
        }
      }
      if (next.phase === phase && page.isDone && visited === page.page.length)
        next = phase === 'roots' ? { phase: 'lanes', key: null } : null;
    }
    const cursor = next === null ? null : JSON.stringify(next);
    invariant(
      cursor === null || cursor !== after,
      'WORK_STALE',
      'Membership repair could not advance its cursor.',
    );
    await ctx.db.patch(projectId, { itemLaneMembership: cursor ?? true });
    return { scanned, patched, next: cursor, readBytes, writeBytes };
  },
});

/** Deployment cutover census: drain this bounded stream and record checked = covered.
 * Show only incomplete project ids/frontiers so the operator can run or resume their pages. */
export const coverage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  returns: v.object({
    checked: v.number(),
    covered: v.number(),
    next: v.union(v.string(), v.null()),
    incomplete: v.array(
      v.object({ projectId: v.id('hostedProjects'), after: v.union(v.string(), v.null()) }),
    ),
  }),
  handler: async (ctx, { after }) => {
    onlyDev();
    const page = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor: after, numItems: PAGE, maximumRowsRead: PAGE, maximumBytesRead: MIB });
    const projects = page.page.filter(project => !project.removal);
    const incomplete = projects.flatMap(project =>
      project.itemLaneMembership === true
        ? []
        : [{ projectId: project._id, after: project.itemLaneMembership ?? null }],
    );
    return {
      checked: projects.length,
      covered: projects.length - incomplete.length,
      incomplete,
      next: page.isDone ? null : page.continueCursor,
    };
  },
});
