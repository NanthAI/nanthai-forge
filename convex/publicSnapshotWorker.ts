// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { internalAction } from './server';
import { buildPublicDirectory } from './publicDirectoryProjection';
import { directoryWritePlan, writeDirectoryBatch } from './publicDirectoryWrites';
import { readDirectoryInput, commitDirectoryInput } from './publicDirectoryInput';
import { purgePublicSnapshotCache, ttlPurge } from './publicSnapshotPurge';
import { publishSnapshot } from './publicSnapshotStorage';
import { fitPublicEntity } from './publicSnapshotFit';
import { r2Config } from './r2';
import { ForgeError, invariant } from '../src/errors';
import { HANDLE, SLUG, snapshotRecord } from '../src/public-snapshot-contract';

type Job = Doc<'publicSnapshotJobs'>;
const ready = (status: string) => status === 'written' || status === 'unchanged';
const identity = (job: Job) => ({ id: job._id, serial: job.serial });
const current = (ctx: ActionCtx, job: Job) =>
  ctx.runQuery(internal.publicSnapshotJobs.current, identity(job));

async function purge(ctx: ActionCtx, job: Job, paths: readonly string[]) {
  const {
    FORGE_WEB_URL: origin,
    FORGE_PUBLIC_SNAPSHOT_ZONE: zone,
    FORGE_PUBLIC_SNAPSHOT_PURGE_TOKEN: token,
  } = process.env;
  if (ttlPurge()) return current(ctx, job);
  invariant(
    origin && zone && token,
    'R2_NOT_CONFIGURED',
    'Public snapshot revocation needs an edge purge binding.',
  );
  // At most four provider calls in flight; verify the retry token between bounded groups.
  for (let offset = 0; offset < paths.length; offset += 120) {
    if (!(await current(ctx, job))) return false;
    const group = paths.slice(offset, offset + 120);
    await Promise.allSettled(
      Array.from({ length: Math.ceil(group.length / 30) }, (_, i) =>
        purgePublicSnapshotCache({ origin, zone, token }, group.slice(i * 30, i * 30 + 30)),
      ),
    ).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  }
  return true;
}

async function directory(ctx: ActionCtx, job: Job, deployment: string, asOf: number) {
  const config = job.step === 'publish' ? r2Config() : undefined;
  const input = config && (await readDirectoryInput(ctx, config, job, asOf));
  const rows = input?.rows ?? [];
  invariant(
    new Set(rows.map(row => `${row.handle}/${row.slug}`)).size === rows.length,
    'SOURCE_CHANGED',
    'The public directory contains conflicting addresses.',
  );
  const work = directoryWritePlan(buildPublicDirectory(rows, deployment), job.extents ?? {});
  if (input && config) {
    if (
      !(await ctx.runMutation(internal.publicSnapshotJobs.reserve, {
        ...identity(job),
        extents: work.lengths,
      }))
    )
      return false;
    for (let offset = 0; offset < work.entries.length; offset += 16) {
      const outcomes = await writeDirectoryBatch(
        config,
        work.entries.slice(offset, offset + 16),
        job.generation,
        asOf,
        () => current(ctx, job),
        undefined,
        job.serial,
      );
      if (!outcomes.every(ready)) return false;
    }
    if (!(await commitDirectoryInput(ctx, config, job, input, asOf))) return false;
  }
  return (
    !job.urgent ||
    purge(
      ctx,
      job,
      work.entries.flatMap(entry => entry.cachePaths),
    )
  );
}

async function entity(
  ctx: ActionCtx,
  job: Job,
  deployment: string,
  asOf: number,
  onDependencies: (ids: Id<'hostedProjects'>[]) => void,
) {
  const [kind, handle, slug, extra] = job.key.split('/');
  invariant(
    handle &&
      HANDLE.test(handle) &&
      extra === undefined &&
      ((kind === 'project' && slug && SLUG.test(slug)) || (kind === 'profile' && slug === undefined)),
    'BAD_ARGUMENT',
    'Invalid public snapshot address.',
  );
  const path = `${job.key}.json`;
  if (job.step === 'publish' || job.step === 'blankProfile') {
    const limit = kind === 'project' ? 64 * 1024 : 24 * 1024;
    const outcome = await publishSnapshot(r2Config(), { key: `public-pages/v1/${path}`, limit }, async () => {
      const hidden = { state: 'hidden', generation: job.generation, at: asOf } as const;
      if (job.step === 'blankProfile') return (await current(ctx, job)) ? hidden : null;
      let projected: unknown;
      if (kind === 'profile') {
        const prepared = await ctx.runMutation(internal.publicRead.prepareProfile, {
          ...identity(job),
          handle,
          now: asOf,
        });
        if (!prepared) return null;
        onDependencies(prepared.dependencies);
        projected = prepared.data;
      } else {
        projected = await ctx.runQuery(internal.publicRead.projectPage, {
          handle,
          slug: slug!,
          now: asOf,
          snapshot: true,
        });
        if (!(await current(ctx, job))) return null;
      }
      if (projected === null) return hidden;
      const data = snapshotRecord(projected);
      invariant(data, 'SOURCE_CHANGED', 'Invalid public snapshot projection.');
      const content = { ...data };
      delete content.v;
      delete content.asOf;
      delete content.stale;
      const fitted = fitPublicEntity({
        kind,
        limit,
        generation: job.generation,
        asOf,
        data: { ...content, starLookup: true, deployment },
      });
      return fitted ? { state: 'public', generation: job.generation, asOf, data: fitted } : hidden;
    });
    if (!ready(outcome)) return false;
  }
  // The blanking purge is the first purge. Do not restart its 30-second clock on rewrite.
  return (
    !job.urgent ||
    (job.step === 'publish' && job.purgeAfter !== undefined) ||
    purge(ctx, job, [`/${handle}${slug ? `/${slug}` : ''}`, `/-/public/v1/${path}`])
  );
}

export const run = internalAction({
  args: { id: v.id('publicSnapshotJobs'), serial: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const job: Job | null = await ctx.runMutation(internal.publicSnapshotJobs.claim, args);
    if (!job) return null;
    let ok = false;
    let permanent = false;
    let dependencies: Id<'hostedProjects'>[] | undefined;
    try {
      const deployment = process.env.CONVEX_CLOUD_URL;
      invariant(deployment, 'R2_NOT_CONFIGURED', 'Public snapshots need the canonical deployment origin.');
      const now = Date.now();
      ok =
        job.key === 'directory'
          ? await directory(ctx, job, deployment, now)
          : await entity(ctx, job, deployment, now, ids => {
              dependencies = ids;
            });
    } catch (error) {
      // Unknown outcomes re-observe ETags on retry. Do not echo storage/provider responses into job logs.
      // A missing binding or an invalid projection cannot recover by itself: stop, alert once, resume after the fix.
      permanent = error instanceof ForgeError && ['BAD_ARGUMENT', 'R2_NOT_CONFIGURED'].includes(error.code);
    }
    await ctx.runMutation(internal.publicSnapshotJobs.settle, {
      ...args,
      ok,
      permanent,
      ...(dependencies ? { dependencies } : {}),
    });
    return null;
  },
});
