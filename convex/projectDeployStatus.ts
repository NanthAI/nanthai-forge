// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { mutation } from './cliServer';
import { activeProject, accessibleProject, coordinationAccess } from './projectAuthority';
import { publicActorLabel } from './publicPeople';
import { hostedStartMain } from './projectHostedChannels';
import { landingReadState } from './projectLandingReadFields';
import { DEFAULT_DEPLOY_ATTENTION_MINUTES } from '../src/deploy-targets';
import type { DeployStatus, DeployStatusRead } from '../src/deploy-status';
import { invariant } from '../src/errors';
import { report } from './errors';
import { deployFailureWork } from './projectDeployFields';
import { readFailure } from './projectDeployFailure';
import { liveSequence, newestCompletedRow } from './projectDeployRows';

type Work = NonNullable<NonNullable<Doc<'projectDeploys'>['failure']>['work']>;

async function workOwner(ctx: QueryCtx, projectId: Id<'hostedProjects'>, work: Work) {
  const lanes = ctx.db.query('projectHostedPresence');
  const lane =
    work.kind === 'lane'
      ? await lanes
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', work.id))
          .unique()
      : await lanes
          .withIndex('by_project_and_intent_and_at', q =>
            q.eq('projectId', projectId).eq('intentId', work.id),
          )
          .order('desc')
          .first();
  if (lane && !lane.park)
    return (await publicActorLabel(ctx, lane.actor, lane.agent, true)) || lane.agent || 'A project member';
  if (work.kind !== 'item') return null;
  // Hosted Items use their id as the Intent id. Their owner is also recorded before work starts.
  const item = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', 'issue').eq('key', work.id),
    )
    .unique();
  const owner = item?.value ? itemOwner(item.value) : null;
  return owner ? (await publicActorLabel(ctx, owner)) || 'A project member' : null;
}

function itemOwner(value: string) {
  const item = JSON.parse(value) as { status?: string; owner?: string; purged?: boolean };
  return item.status === 'in-progress' && !item.purged ? (item.owner ?? null) : null;
}

export async function deployStatusForViewer(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  viewer: string,
): Promise<DeployStatusRead | undefined> {
  const settings = project.autonomyPolicy?.deploys;
  if (!settings?.targets.length) return undefined;
  if (!(await coordinationAccess(ctx, project, viewer))) return undefined;
  const projectId = project._id;
  const rows = await Promise.all(
    settings.targets.map(async target => ({
      target,
      row: await newestCompletedRow(ctx, projectId, target.name),
    })),
  );
  if (!rows.some(({ row }) => row)) return undefined;
  const [main, seen] = await Promise.all([
    hostedStartMain(ctx, projectId),
    rows.some(({ row }) => row && row.status !== 'succeeded')
      ? landingReadState(ctx, projectId, viewer)
      : null,
  ]);
  const attentionMinutes = settings.needsAttentionAfterMinutes ?? DEFAULT_DEPLOY_ATTENTION_MINUTES;
  const targets = await Promise.all(
    rows.map(async ({ target, row }): Promise<DeployStatus | null> => {
      if (!row) return null;
      const label = { target: target.name, label: target.label, environment: target.environment };
      if (row.status === 'succeeded') return { ...label, liveSequence: liveSequence(row) };
      const failure = await readFailure(ctx, row);
      if (seen?.deploySeen?.[target.name] === failure.key) return null;
      const who = failure.work ? await workOwner(ctx, projectId, failure.work) : null;
      return {
        ...label,
        liveSequence: failure.liveSequence,
        failure: {
          key: failure.key,
          since: failure.since,
          sinceSequence: failure.sinceSequence,
          ...(row.url && /^https:\/\/[^\s]+$/.test(row.url) ? { runUrl: row.url } : {}),
          ...(who && failure.work ? { work: { ...failure.work, who } } : {}),
          ...(!who && viewer === project.owner
            ? { attentionAt: Date.parse(failure.since) + attentionMinutes * 60_000 }
            : {}),
          attentionMinutes,
        },
      };
    }),
  );
  return { mainSequence: main.sourceRevision, targets: targets.filter(target => target !== null) };
}

const failureArgs = { projectId: v.id('hostedProjects'), target: v.string(), key: v.string() };
async function selectFailure(ctx: QueryCtx, project: Doc<'hostedProjects'>, target: string, key: string) {
  invariant(
    project.autonomyPolicy?.deploys?.targets.some(candidate => candidate.name === target),
    'NOT_FOUND',
    'This project has no such deploy target.',
  );
  const row = await newestCompletedRow(ctx, project._id, target);
  if (!row || row.status === 'succeeded') return null;
  const failure = await readFailure(ctx, row);
  return failure.key === key ? { row, failure } : null;
}

export const seen = mutation({
  args: failureArgs,
  returns: v.string(),
  handler: async (ctx, { projectId, target, key }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to mark the deploy failure as seen.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      invariant(
        await coordinationAccess(ctx, project, user.subject),
        'PROJECT_UNAVAILABLE',
        'Deploy status is unavailable.',
      );
      if (!(await selectFailure(ctx, project, target, key))) return JSON.stringify({ changed: false });
      const existing = await landingReadState(ctx, projectId, user.subject);
      if (existing?.deploySeen?.[target] === key) return JSON.stringify({ changed: false });
      const deploySeen = Object.fromEntries(
        project.autonomyPolicy!.deploys!.targets.flatMap(({ name }) => {
          const value = name === target ? key : existing?.deploySeen?.[name];
          return typeof value === 'string' ? [[name, value]] : [];
        }),
      );
      if (existing) await ctx.db.patch(existing._id, { deploySeen });
      else
        await ctx.db.insert('projectLandingReads', {
          projectId,
          account: user.subject,
          through: -1,
          read: [],
          at: Date.now(),
          deploySeen,
        });
      return JSON.stringify({ changed: true });
    } catch (error) {
      return report(error);
    }
  },
});

export const linkWork = mutation({
  args: { ...failureArgs, work: v.union(deployFailureWork, v.null()) },
  returns: v.string(),
  handler: async (ctx, { projectId, target, key, work }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to link work to a deploy failure.');
      const project = await activeProject(ctx, projectId, user.subject);
      const selected = await selectFailure(ctx, project, target, key);
      if (!selected) return JSON.stringify({ changed: false });
      const { row, failure } = selected;
      if (failure.work?.id === work?.id && failure.work?.kind === work?.kind)
        return JSON.stringify({ changed: false });
      if (work)
        invariant(
          await workOwner(ctx, projectId, work),
          'NOT_FOUND',
          'Select a Lane or Item with somebody on it.',
        );
      if (work) failure.work = work;
      else delete failure.work;
      await ctx.db.patch(row._id, { failure });
      return JSON.stringify({ changed: true });
    } catch (error) {
      return report(error);
    }
  },
});
