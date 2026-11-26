// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bulk permanent delete in one owner approval (Item 7456856f). An unrestricted sign-in to the account prepares a request:
// the exact list of projects (ids, slugs, revisions, last landing, size), frozen when it is made. Only the owner person
// approves it, once, in the browser; approval re-checks every project and runs the existing permanent purge
// (projectLifecycle `transition`) for each one that is unchanged. A project that changed since the list was made is
// skipped and named. Nothing here polls: the page and `--wait` hold one subscription to the request row, which is
// written on prepare, on the decision and once per project when its purge ends.
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { isDeviceIdentity, accountMutation, query } from './cliServer';
import { requireOwnerPerson } from './ownerPerson';
import { transition } from './projectLifecycle';
import { STORAGE_QUOTA } from './abuseLimits';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { latestLanding } from './projectLatestLanding';
import {
  DELETE_REQUEST_OPERATION as OPERATION,
  deletePurgeOperation,
  reconcileDeleteOutcomes,
} from './projectDeleteRequestOutcome';
import { purgeSettleMs } from './projectRetention';

/** A request holds at most this many projects (owner request, Item 7456856f). */
export const DELETE_REQUEST_LIMIT = 100;
/** An unapproved request ends after this long; nothing is deleted. */
export const DELETE_REQUEST_TTL_MS = 30 * 60_000;
/** Projects read to match a name pattern or the trash (one bounded page of the account's projects). */
const SCAN = 500;

type Row = Doc<'projectDeleteRequests'>;
type Outcome = NonNullable<Row['results']>[number]['outcome'];

const selection = v.union(
  v.object({ glob: v.string() }),
  v.object({ ids: v.array(v.string()) }),
  v.object({ trash: v.literal(true) }),
);

/** `bench-zoo-*`: `*` is any run of characters, `?` one character; the whole slug must match. */
export function slugPattern(glob: string) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

async function caller(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage your Forge projects.');
  return user;
}
async function ownRequest(ctx: QueryCtx | MutationCtx, requestId: string, owner: string) {
  const id = ctx.db.normalizeId('projectDeleteRequests', requestId);
  const row = id ? await ctx.db.get(id) : null;
  // Another account's request reads as missing: no existence oracle.
  invariant(row && row.owner === owner, 'NOT_FOUND', 'This delete request was not found.');
  return row;
}
async function storedBytes(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const shards = await ctx.db
    .query('projectStorageUsage')
    .withIndex('by_project_and_shard', q => q.eq('projectId', projectId))
    .take(STORAGE_QUOTA.shards);
  return shards.reduce((sum, shard) => sum + shard.bytes, 0);
}
const deletable = (project: Doc<'hostedProjects'> | null, owner: string): project is Doc<'hostedProjects'> =>
  Boolean(project && project.owner === owner && !['deleting', 'deleted'].includes(project.removal ?? ''));

export function requestView(row: Row, now = Date.now()) {
  const results = new Map((row.results ?? []).map(entry => [entry.projectId as string, entry.outcome]));
  const kept = new Set<string>(row.decision?.kept ?? []);
  return {
    id: row._id as string,
    status: row.status === 'requested' && now >= row.expiresAt ? ('expired' as const) : row.status,
    selector: row.selector,
    byDevice: row.requester.device,
    at: new Date(row.at).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    projects: row.projects.map(project => ({
      ...project,
      outcome: kept.has(project.projectId) ? ('kept' as const) : (results.get(project.projectId) ?? null),
    })),
    ...(row.decision?.reason ? { reason: row.decision.reason } : {}),
  };
}
export function deleteRequestUrl(requestId: string) {
  const web = process.env.FORGE_WEB_URL;
  if (!web) return null;
  const url = new URL('/account', web);
  url.searchParams.set('request', requestId);
  return url.href;
}
function reply(row: Row) {
  const view = requestView(row);
  const url = deleteRequestUrl(view.id);
  const running = view.projects.filter(project => project.outcome === 'started').length;
  const settled = view.projects.filter(
    project => project.outcome === 'deleted' || project.outcome === 'failed',
  ).length;
  return canonicalPayload({
    ...view,
    url,
    ...(!row.tracksPurgeReceipt && running ? { legacyPurgeReconcile: true } : {}),
    next:
      view.status === 'requested'
        ? `Only the owner person can approve this, once, signed in on the web${url ? `: ${url}` : ''}. Wait for the decision with nforge host ROOT --delete-projects --wait ${view.id}; withdraw with --withdraw ${view.id}.`
        : running
          ? `${settled} of ${settled + running} purges finished. For a newly removed project, Forge allows up to ${purgeSettleMs / 60_000} minutes for existing uploads to expire before purging.`
          : `This request is ${view.status}.`,
  });
}

/** Prepare a request. An unrestricted account sign-in, a device or agent included; it deletes nothing. Retry-safe by
 * operation id. Reads: one page of the account's projects (a pattern or the trash) or one get per id, then one landing
 * read and one storage read per listed project (at most DELETE_REQUEST_LIMIT); one insert. */
export const prepare = accountMutation('write')({
  args: { operationId: v.string(), select: selection },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await caller(ctx);
      const request = canonicalPayload(input.select);
      invariant(/^[0-9a-f-]{36}$/.test(input.operationId), 'BAD_ARGUMENT', 'Use a fresh operation UUID.');
      const old = await ctx.db
        .query('projectDeleteRequests')
        .withIndex('by_owner_and_operation', q =>
          q.eq('owner', user.subject).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(old.request === request, 'WORK_OPERATION_CHANGED', 'Retry with the original selection.');
        return reply(old);
      }
      let matched: Doc<'hostedProjects'>[];
      let selector: string;
      if ('ids' in input.select) {
        const ids = [...new Set(input.select.ids)];
        invariant(
          ids.length > 0 && ids.length <= DELETE_REQUEST_LIMIT,
          'BAD_ARGUMENT',
          `List 1 to ${DELETE_REQUEST_LIMIT} project ids.`,
        );
        matched = [];
        for (const id of ids) {
          const projectId = ctx.db.normalizeId('hostedProjects', id);
          const project = projectId ? await ctx.db.get(projectId) : null;
          invariant(
            deletable(project, user.subject),
            'PROJECT_UNAVAILABLE',
            `Project ${id} is not yours to delete.`,
          );
          matched.push(project);
        }
        selector = `${ids.length} project ${ids.length === 1 ? 'id' : 'ids'}`;
      } else if ('trash' in input.select) {
        // The trash is one index range: the first DELETE_REQUEST_LIMIT trashed projects, however many projects the
        // account holds. More than that stay in the trash for the next request.
        matched = (
          await ctx.db
            .query('hostedProjects')
            .withIndex('by_owner_and_removal', q => q.eq('owner', user.subject).eq('removal', 'trash'))
            .take(DELETE_REQUEST_LIMIT)
        ).filter(p => deletable(p, user.subject));
        selector = 'the trash';
      } else {
        const page = await ctx.db
          .query('hostedProjects')
          // Active and removed rows: a name pattern may match either.
          .withIndex('by_owner_and_removal', q => q.eq('owner', user.subject))
          .take(SCAN + 1);
        invariant(
          page.length <= SCAN,
          'BAD_ARGUMENT',
          `This account has over ${SCAN} projects; list project ids instead.`,
        );
        const glob = input.select.glob.trim();
        invariant(
          glob && glob.length <= 200,
          'BAD_ARGUMENT',
          'Give a project name pattern such as bench-zoo-*.',
        );
        const pattern = slugPattern(glob);
        matched = page.filter(p => deletable(p, user.subject) && pattern.test(p.slug ?? p.name));
        selector = glob;
      }
      invariant(matched.length > 0, 'NOT_FOUND', `No project of yours matches ${selector}.`);
      invariant(
        matched.length <= DELETE_REQUEST_LIMIT,
        'BAD_ARGUMENT',
        `${matched.length} projects match ${selector}; a request holds at most ${DELETE_REQUEST_LIMIT}. Use a narrower pattern.`,
      );
      const projects = [];
      for (const project of matched) {
        const landing = await latestLanding(ctx, project._id);
        projects.push({
          projectId: project._id as string,
          slug: project.slug ?? project.name,
          revision: project.revision,
          landing: (landing?._id as string | undefined) ?? null,
          lastLandingAt: landing?._creationTime ?? null,
          bytes: await storedBytes(ctx, project._id),
          trash: project.removal === 'trash',
        });
      }
      projects.sort((a, b) => b.bytes - a.bytes || a.slug.localeCompare(b.slug));
      const at = Date.now();
      const id = await ctx.db.insert('projectDeleteRequests', {
        owner: user.subject,
        requester: { device: isDeviceIdentity(user) },
        operationId: input.operationId,
        request,
        selector,
        at,
        expiresAt: at + DELETE_REQUEST_TTL_MS,
        projects,
        status: 'requested',
      });
      return reply((await ctx.db.get(id))!);
    } catch (error) {
      return report(error);
    }
  },
});

/** The page and `--wait` subscribe to this request row. Legacy reconciliation is a one-shot read. */
export const read = query({
  args: { requestId: v.string(), reconcile: v.optional(v.literal(true)) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await caller(ctx);
      const row = await ownRequest(ctx, input.requestId, user.subject);
      return reply(input.reconcile ? await reconcileDeleteOutcomes(ctx, row) : row);
    } catch (error) {
      return report(error);
    }
  },
});

/** The account's unexpired open requests, newest first: one bounded indexed read (the account page and Loose ends). */
export async function openDeleteRequests(ctx: QueryCtx, owner: string, now = Date.now()) {
  const rows = await ctx.db
    .query('projectDeleteRequests')
    .withIndex('by_owner_and_status', q => q.eq('owner', owner).eq('status', 'requested'))
    .order('desc')
    .take(10);
  return rows
    .filter(row => row.expiresAt > now)
    .map(row => ({
      id: row._id as string,
      selector: row.selector,
      projects: row.projects.length,
      byDevice: row.requester.device,
    }));
}

/** The account's open requests, newest first (the account page lists them). One bounded indexed read. */
export const open = query({
  args: {},
  returns: v.string(),
  handler: async ctx => {
    try {
      const user = await caller(ctx);
      return canonicalPayload(
        (await openDeleteRequests(ctx, user.subject)).map(row => ({
          id: row.id,
          selector: row.selector,
          projects: row.projects,
          url: deleteRequestUrl(row.id),
        })),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** The owner person's decision. `approve` runs the permanent purge for every listed project not kept out and still as
 * it was; `count` is the number the owner typed and must equal that remainder as shown. Replaying the same decision is
 * a no-op. Device and agent sign-ins are refused (requireOwnerPerson); another account reads the request as missing. */
export const decide = accountMutation('same')({
  args: {
    requestId: v.string(),
    operationId: v.string(),
    decision: v.union(v.literal('approve'), v.literal('decline')),
    kept: v.optional(v.array(v.string())),
    count: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'permanently delete projects');
      const row = await ownRequest(ctx, input.requestId, user.subject);
      if (row.decision?.operationId === input.operationId) return reply(row);
      const view = requestView(row);
      invariant(view.status === 'requested', 'WORK_STALE', `This request is already ${view.status}.`);
      const reason = input.reason?.trim().slice(0, 500) || undefined;
      if (input.decision === 'decline') {
        await ctx.db.patch(row._id, {
          status: 'declined',
          decision: {
            operationId: input.operationId,
            at: Date.now(),
            kept: [],
            ...(reason ? { reason } : {}),
          },
        });
        return reply((await ctx.db.get(row._id))!);
      }
      const listed = new Set<string>(row.projects.map(project => project.projectId));
      const kept = [...new Set(input.kept ?? [])];
      invariant(
        kept.every(id => listed.has(id)),
        'BAD_ARGUMENT',
        'Keep out only projects on this list.',
      );
      const go = row.projects.filter(project => !kept.includes(project.projectId));
      invariant(go.length > 0, 'BAD_ARGUMENT', 'Every project was kept out; decline the request instead.');
      invariant(
        input.count === go.length,
        'BAD_ARGUMENT',
        `Type the number of projects to delete (${go.length}) to approve.`,
      );
      const results: { projectId: string; outcome: Outcome }[] = [];
      for (const frozen of go)
        results.push({
          projectId: frozen.projectId,
          outcome: await purgeOne(ctx, row, frozen, user.subject),
        });
      await ctx.db.patch(row._id, {
        status: 'approved',
        decision: {
          operationId: input.operationId,
          at: Date.now(),
          kept,
        },
        results,
        tracksPurgeReceipt: true,
      });
      return reply((await ctx.db.get(row._id))!);
    } catch (error) {
      return report(error);
    }
  },
});

/** One listed project: skipped unless it is exactly as the list froze it (same owner, revision and newest landing). */
async function purgeOne(
  ctx: MutationCtx,
  row: Row,
  frozen: Row['projects'][number],
  owner: string,
): Promise<Outcome> {
  const id = ctx.db.normalizeId('hostedProjects', frozen.projectId);
  const project = id ? await ctx.db.get(id) : null;
  if (!project || project.owner !== owner) return 'refused';
  if (
    project.removal === 'deleting' ||
    project.removal === 'deleted' ||
    project.revision !== frozen.revision ||
    ((await latestLanding(ctx, project._id))?._id ?? null) !== frozen.landing
  )
    return 'changed';
  await transition(
    ctx,
    { projectId: project._id, operationId: `${OPERATION}${row._id}`, expectedRevision: frozen.revision },
    'delete',
    { confirmed: true },
  );
  return 'started';
}

/** Retry only the projects whose purge stopped: each one replays its original purge operation. Owner person only. */
export const retry = accountMutation('same')({
  args: { requestId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'permanently delete projects');
      const row = await reconcileDeleteOutcomes(ctx, await ownRequest(ctx, input.requestId, user.subject));
      const results: NonNullable<Row['results']> = [];
      for (const entry of row.results ?? []) {
        if (entry.outcome !== 'failed') {
          results.push(entry);
          continue;
        }
        const id = ctx.db.normalizeId('hostedProjects', entry.projectId);
        const project = id ? await ctx.db.get(id) : null;
        if (!project || project.owner !== user.subject) {
          results.push({ projectId: entry.projectId, outcome: 'refused' });
          continue;
        }
        const operationId = `${OPERATION}${row._id}`;
        if (deletePurgeOperation(project) !== operationId) {
          results.push({ projectId: entry.projectId, outcome: 'changed' });
          continue;
        }
        if (project.removal === 'deleting')
          await transition(
            ctx,
            {
              projectId: project._id,
              operationId,
              expectedRevision:
                project.lifecycle?.operationId === operationId
                  ? project.lifecycle.expectedRevision
                  : project.revision,
            },
            'delete',
            { confirmed: true },
          );
        results.push({
          projectId: entry.projectId,
          outcome:
            project.removal === 'deleted' && project.purge?.completedAt !== undefined
              ? 'deleted'
              : project.removal === 'deleting'
                ? 'started'
                : 'changed',
        });
      }
      await ctx.db.patch(row._id, { results });
      return reply((await ctx.db.get(row._id))!);
    } catch (error) {
      return report(error);
    }
  },
});

/** The requester (any sign-in of the account) withdraws an open request; nothing was deleted. */
export const withdraw = accountMutation('write')({
  args: { requestId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await caller(ctx);
      const row = await ownRequest(ctx, input.requestId, user.subject);
      if (row.status === 'requested') await ctx.db.patch(row._id, { status: 'withdrawn' });
      return reply((await ctx.db.get(row._id))!);
    } catch (error) {
      return report(error);
    }
  },
});
