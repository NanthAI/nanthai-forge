// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { mutation } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { report } from './errors';
import { defaultHistoryLimitBytes, historyChunk, maxHistoryLimitBytes } from './projectHistoryFields';
import { githubSyncCommitSchema } from '../src/github-sync-types';

/** Pack rows a read loads at most; catch-up packs coalesce, so this bounds a
 * project that read history after more than this many separate mirror moves. */
export const historyPackPage = 256;
export const historyLimit = (row: Pick<Doc<'projectHistory'>, 'limitBytes'>) =>
  row.limitBytes ?? defaultHistoryLimitBytes;

const historyRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHistory')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();

/** Called inside the import's ready transaction: one row, one scheduled run. */
export async function beginHistory(
  ctx: MutationCtx,
  job: Pick<Doc<'projectGithubImports'>, 'projectId' | 'repository' | 'visibility' | 'owner' | 'commit'>,
  importState: string,
) {
  if (!/^[0-9a-f]{40}$/.test(job.commit)) return;
  const existing = await historyRow(ctx, job.projectId);
  if (existing) return;
  await ctx.db.insert('projectHistory', {
    projectId: job.projectId,
    repository: job.repository,
    visibility: job.visibility,
    owner: job.owner,
    importCommit: job.commit,
    importState,
    status: 'pending',
    bytes: 0,
    packs: 0,
    attempt: 1,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.projectHistoryImport.run, {
    projectId: job.projectId,
    attempt: 1,
  });
}

const packView = v.object({
  tip: v.string(),
  chunks: v.array(historyChunk),
  framed: v.optional(v.array(historyChunk)),
  bytes: v.number(),
  objects: v.number(),
  packSha1: v.string(),
  at: v.number(),
  /** Forge packs (Issue 3bd4a8e9): the main State their tip commit is. */
  state: v.optional(v.string()),
});
/** Everything one history read or import run needs, in one query. `actor` set:
 * current read access is checked first. */
export const load = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      row: v.any(),
      packs: v.array(packView),
      morePacks: v.boolean(),
      mirror: v.union(v.null(), v.object({ repository: v.string(), mapping: v.string() })),
    }),
  ),
  handler: async (ctx, input) => {
    if (input.actor !== undefined) await accessibleProject(ctx, input.projectId, input.actor);
    return loadHistory(ctx, input.projectId);
  },
});

/** History row, its first pack page and main's mirror mapping: one bounded read. */
export async function loadHistory(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const row = await historyRow(ctx, projectId);
  if (!row) return null;
  const packs = await ctx.db
    .query('projectHistoryPacks')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .take(historyPackPage + 1);
  return {
    row,
    packs: packs.slice(0, historyPackPage).map(pack => ({
      tip: pack.tip,
      chunks: pack.chunks,
      ...(pack.framed ? { framed: pack.framed } : {}),
      bytes: pack.bytes,
      objects: pack.objects,
      packSha1: pack.packSha1,
      at: pack.at,
      ...(pack.main ? { state: pack.main.state } : {}),
    })),
    morePacks: packs.length > historyPackPage,
    mirror: await mirrorMapping(ctx, projectId),
  };
}
export async function mirrorMapping(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const [mirror] = await ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .take(1);
  return mirror?.mapping ? { repository: mirror.repository, mapping: mirror.mapping } : null;
}

/** A pending history run older than this has outlived the 10-minute action limit. */
export const historyRunLeaseMs = 11 * 60 * 1000;
/** A project with main's GitHub mirror but no imported history (born on Forge, or imported
 * before history was stored) gets its history from the mirror repository once, through the
 * same row, run and limit as an import. Returns the attempt its caller runs now, or null when
 * there is nothing to seed or a fresh run owns it; a pending run past its lease is retried. */
export const seedFromMirror = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.removal) return null;
    const now = Date.now();
    const row = await historyRow(ctx, projectId);
    if (row) {
      if (row.status !== 'pending' || now - row.updatedAt < historyRunLeaseMs) return null;
      const attempt = row.attempt + 1;
      await ctx.db.patch(row._id, { attempt, updatedAt: now });
      return attempt;
    }
    const mirror = await mirrorMapping(ctx, projectId);
    if (!mirror) return null;
    const mapping = githubSyncCommitSchema.parse(JSON.parse(mirror.mapping));
    await ctx.db.insert('projectHistory', {
      projectId,
      repository: mirror.repository,
      // A public project serves its history anonymously, so it seeds only from a public repository.
      visibility: project.visibility === 'public' ? 'public' : 'private',
      owner: project.owner,
      importCommit: mapping.commit,
      importState: mapping.state,
      status: 'pending',
      bytes: 0,
      packs: 0,
      attempt: 1,
      updatedAt: now,
    });
    return 1;
  },
});

/** How long one read owns the catch-up fetch. A failed fetch is not released: the lease end is also
 * the pause before GitHub is asked again, so a broken mirror cannot be hammered by readers. */
export const catchUpLeaseMs = 2 * 60 * 1000;
/** One reader per project fetches the catch-up pack for a moved mirror. The claim is one mutation
 * on the path that needs a fetch (once per mirror move); reads with nothing to fetch never call it. */
export const claimCatchUp = internalMutation({
  args: { projectId: v.id('hostedProjects'), tip: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, tip }) => {
    const row = await historyRow(ctx, projectId);
    if (!row || row.status !== 'ready') return false;
    const now = Date.now();
    if (row.catchUp && row.catchUp.until > now) return false;
    await ctx.db.patch(row._id, { catchUp: { tip, until: now + catchUpLeaseMs } });
    return true;
  },
});

/** One pack row per fetched pack; a replay or a concurrent catch-up for the same
 * tip keeps the first row. The limit is enforced here as well as on the stream. */
export const record = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    attempt: v.optional(v.number()),
    pack: v.object({
      tip: v.string(),
      haves: v.array(v.string()),
      chunks: v.array(historyChunk),
      bytes: v.number(),
      objects: v.number(),
      packSha1: v.string(),
      source: v.union(v.literal('import'), v.literal('catch-up')),
    }),
  },
  returns: v.union(v.literal('recorded'), v.literal('duplicate'), v.literal('stale')),
  handler: async (ctx, { projectId, attempt, pack }) => {
    const row = await historyRow(ctx, projectId);
    if (!row || (attempt !== undefined && (row.attempt !== attempt || row.status !== 'pending')))
      return 'stale';
    if (attempt === undefined && row.status !== 'ready') return 'stale';
    const existing = await ctx.db
      .query('projectHistoryPacks')
      .withIndex('by_project_and_tip', q => q.eq('projectId', projectId).eq('tip', pack.tip))
      .take(1)
      .then(rows => rows[0] ?? null);
    if (existing) {
      if (row.status === 'pending' || row.catchUp)
        await ctx.db.patch(row._id, { status: 'ready', catchUp: undefined, updatedAt: Date.now() });
      return 'duplicate';
    }
    invariant(
      row.bytes + pack.bytes <= historyLimit(row),
      'HISTORY_OVER_LIMIT',
      'The history pack would exceed the project history limit.',
    );
    await ctx.db.insert('projectHistoryPacks', { projectId, ...pack, at: Date.now() });
    await ctx.db.patch(row._id, {
      status: 'ready',
      bytes: row.bytes + pack.bytes,
      packs: row.packs + 1,
      error: undefined,
      catchUp: undefined,
      updatedAt: Date.now(),
    });
    return 'recorded';
  },
});

/** Which of these chunk digests a recorded pack of the project still pins (its chunks,
 * framed copy, object set or main listing); those are never deleted by unrecorded-chunk cleanup. Bounded by
 * historyPackPage rows. */
export const referencedChunks = internalQuery({
  args: { projectId: v.id('hostedProjects'), sha256s: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, input) => {
    const wanted = new Set(input.sha256s);
    const packs = await ctx.db
      .query('projectHistoryPacks')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .take(historyPackPage + 1);
    return [
      ...new Set(
        packs
          .flatMap(pack =>
            [
              ...pack.chunks,
              ...(pack.framed ?? []),
              ...(pack.objectSet ? [pack.objectSet] : []),
              ...(pack.trees ? [pack.trees] : []),
              ...(pack.main ? [pack.main.listing] : []),
            ].map(chunk => chunk.sha256),
          )
          .filter(sha => wanted.has(sha)),
      ),
    ];
  },
});

export const finish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    attempt: v.number(),
    status: v.union(v.literal('over-limit'), v.literal('failed')),
    error: v.object({ code: v.string(), message: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await historyRow(ctx, input.projectId);
    if (!row || row.attempt !== input.attempt || row.status !== 'pending') return null;
    await ctx.db.patch(row._id, { status: input.status, error: input.error, updatedAt: Date.now() });
    return null;
  },
});

async function ownedHistory(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'AUTH_REQUIRED', 'Sign in to change project history settings.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  invariant(project.owner === user.subject, 'PROJECT_OWNER_REQUIRED', 'Only the project owner can do this.');
  const row = await historyRow(ctx, projectId);
  invariant(row, 'HISTORY_UNAVAILABLE', 'This project has no imported Git history.');
  return row;
}

/** Owner setting: the most history bytes this project may store. Lowering it never
 * deletes stored packs; it only refuses new ones. */
export const setLimit = mutation({
  args: { projectId: v.id('hostedProjects'), limitBytes: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      invariant(
        Number.isSafeInteger(input.limitBytes) &&
          input.limitBytes >= 0 &&
          input.limitBytes <= maxHistoryLimitBytes,
        'BAD_ARGUMENT',
        `Choose a history limit from 0 to ${maxHistoryLimitBytes} bytes.`,
      );
      const row = await ownedHistory(ctx, input.projectId);
      await ctx.db.patch(row._id, { limitBytes: input.limitBytes, updatedAt: Date.now() });
      return JSON.stringify({ limitBytes: input.limitBytes, bytes: row.bytes, status: row.status });
    } catch (error) {
      return report(error);
    }
  },
});

/** Owner retry of a failed or over-limit history import (for example after raising
 * the limit). One scheduled run; stored packs are kept. */
export const retry = mutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const row = await ownedHistory(ctx, input.projectId);
      if (row.status === 'pending' || row.status === 'ready')
        return JSON.stringify({ status: row.status, attempt: row.attempt });
      const attempt = row.attempt + 1;
      await ctx.db.patch(row._id, { status: 'pending', attempt, error: undefined, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.projectHistoryImport.run, {
        projectId: input.projectId,
        attempt,
      });
      return JSON.stringify({ status: 'pending', attempt });
    } catch (error) {
      return report(error);
    }
  },
});
