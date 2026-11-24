// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Where a new project's setup stands (Items 6beca32b, 0c9207b8, 871e9b73): the facts Getting started on Needs me and
// Settings > Landing and checks show, from rows that already exist. One bounded read: the project, its first GitHub
// repository connection, its mirror, the check runner setting, the first accepted landing and the handles of the
// people named. At most 8 documents; no Work, no source, no paths. A subscription re-runs only when one of those rows
// is written. The checklist excludes the mirror row (which moves on each mirror push); only Landing and checks
// reads it. Personal visibility and skips travel with Needs me's existing FYI read, not this read.
import { v } from 'convex/values';
import { z } from 'zod';
import { invariant } from '../src/errors';
import { mutation, query } from './cliServer';
import type { QueryCtx } from './server';
import {
  landingReadState,
  setupPreferences,
  setupVisibility,
  skippableSetupStep,
} from './projectLandingReadFields';
import { report } from './errors';
import { accessibleProject } from './projectAuthority';
import { checkSetting } from './projectHostedCheckStore';
import { accountFor } from './urlIdentity';
import type { Id } from './_generated/dataModel';

const stamp = v.object({ at: v.number(), by: v.union(v.string(), v.null()) });
const check = v.union(
  v.object({
    kind: v.literal('ci-file'),
    repository: v.string(),
    workflow: v.string(),
    chosenAt: v.number(),
  }),
  v.object({
    kind: v.literal('forge-runner'),
    repository: v.union(v.string(), v.null()),
    publicLogs: v.boolean(),
    chosenAt: v.number(),
  }),
  v.object({ kind: v.literal('machine'), chosenAt: v.number() }),
  v.object({ kind: v.literal('other'), provider: v.string(), chosenAt: v.number() }),
);
export const setupView = v.object({
  owner: v.union(v.string(), v.null()),
  viewerIsOwner: v.boolean(),
  created: stamp,
  repository: v.union(
    v.object({ fullName: v.string(), at: v.number(), by: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  mirror: v.union(v.object({ repository: v.string(), at: v.number() }), v.null()),
  check: v.union(check, v.null()),
  firstLanding: v.union(v.object({ at: v.number() }), v.null()),
  /** A person or approved agent has set who approves landings; absent means the project still runs on the default. */
  approvalsAnswered: v.boolean(),
});

const handle = async (ctx: QueryCtx, actor: string) => (await accountFor(ctx, actor))?.handle ?? null;

function checkView(value: string, chosenAt: number) {
  const runner = JSON.parse(value) as {
    provider?: string;
    ci?: { adapter?: string; repository?: string; workflow?: string };
    repository?: string;
    publicLogs?: boolean;
  };
  if (runner.provider === 'ci-status' && runner.ci?.adapter === 'github-actions')
    return {
      kind: 'ci-file' as const,
      repository: runner.ci.repository ?? '',
      workflow: runner.ci.workflow ?? '',
      chosenAt,
    };
  if (runner.provider === 'github-actions')
    return {
      kind: 'forge-runner' as const,
      repository: runner.repository ?? null,
      publicLogs: runner.publicLogs === true,
      chosenAt,
    };
  if (runner.provider === 'self-hosted' || runner.provider === 'mac')
    return { kind: 'machine' as const, chosenAt };
  return { kind: 'other' as const, provider: runner.provider ?? 'not reported', chosenAt };
}

export const read = query({
  args: { projectId: v.id('hostedProjects'), checklist: v.optional(v.boolean()) },
  returns: setupView,
  handler: async (ctx, input) => {
    try {
      return await setup(ctx, input.projectId, input.checklist === true);
    } catch (error) {
      return report(error);
    }
  },
});

/** Personal presentation only: never changes access, checks, or the project's actual setup. */
export const setPreferences = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    expectedRevision: v.number(),
    change: v.union(
      v.object({ visibility: setupVisibility }),
      v.object({ step: skippableSetupStep, skip: v.boolean() }),
    ),
  },
  returns: setupPreferences,
  handler: async (ctx, { projectId, operationId, expectedRevision, change }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change your Getting started preferences.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'Use an operation UUID.');
      const row = await landingReadState(ctx, projectId, user.subject);
      const { operationId: previous, ...before } = row?.setup ?? {
        visibility: 'automatic' as const,
        skipped: [],
        revision: 0,
        operationId: undefined,
      };
      if (operationId === previous) return before;
      invariant(
        expectedRevision === before.revision,
        'WORK_STALE',
        'Getting started changed on another tab or device. Review it and try again.',
      );
      const after =
        'visibility' in change
          ? { ...before, visibility: change.visibility }
          : {
              ...before,
              skipped: [
                ...before.skipped.filter(step => step !== change.step),
                ...(change.skip ? [change.step] : []),
              ],
            };
      after.revision++;
      const setup = { ...after, operationId };
      if (row) await ctx.db.patch(row._id, { setup });
      else
        await ctx.db.insert('projectLandingReads', {
          projectId,
          account: user.subject,
          through: -1,
          read: [],
          at: Date.now(),
          setup,
        });
      return after;
    } catch (error) {
      return report(error);
    }
  },
});

async function setup(ctx: QueryCtx, projectId: Id<'hostedProjects'>, checklist: boolean) {
  const user = await ctx.auth.getUserIdentity();
  const project = await accessibleProject(ctx, projectId, user?.subject ?? '');
  const [binding, mirror, runner, first] = await Promise.all([
    ctx.db
      .query('projectGithubBindings')
      .withIndex('by_project_and_name', q => q.eq('projectId', projectId))
      .first(),
    checklist
      ? null
      : ctx.db
          .query('projectGithubMirrors')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .unique(),
    checkSetting(ctx, projectId, 'runner', 'runner'),
    ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
      .first(),
  ]);
  const owner = await handle(ctx, project.owner);
  return {
    owner,
    viewerIsOwner: !!user && user.subject === project.owner,
    created: { at: project._creationTime, by: owner },
    repository: binding
      ? {
          fullName: binding.fullName,
          at: binding.boundAt,
          by: binding.boundBy === project.owner ? owner : await handle(ctx, binding.boundBy),
        }
      : null,
    mirror: mirror ? { repository: mirror.repository, at: mirror._creationTime } : null,
    check: runner ? checkView(runner.value, runner._creationTime) : null,
    firstLanding: first ? { at: first._creationTime } : null,
    approvalsAnswered: project.autonomyPolicy !== undefined,
  };
}
