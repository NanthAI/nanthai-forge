// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Deploy records, OIDC-authenticated CI queries/callbacks, ancestry lookups for receipts &
// lane-history, reactive wait status, and CI-independent outcome recording.
import { v, type ObjectType } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { hostedStartMain } from './projectHostedChannels';
import { MAIN_LOG_WINDOW, overlapMainSince } from './projectHostedOverlapMainLog';
import { findStoredObject as findObject, readablePhysical } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { sourceObjectLocation } from './projectSourceBeginReads';
import { describeObjects } from './projectObjectDownloads';
import { deployOutcome, deploySmoke, deployTarget } from './projectDeployFields';
import { deployTargetName, type DeployTarget } from '../src/deploy-targets';
import { liveSequence, newestCompletedRow, newestSuccesses, pathsAffectTarget } from './projectDeployRows';
import { failureDetails, lastVerifiedLive, readFailure } from './projectDeployFailure';
import { DEPLOY_COALESCE_MS, queueDeployDispatch, resolveDeployRepository } from './projectDeployDispatch';

export type DeployEntry = {
  sequence: number;
  head: string;
  at: string;
  runId: string;
  url?: string;
  /** True when the landing touched no files affecting this target or produced unchanged served bytes. */
  unchanged?: true;
  /** Actual live deploy sequence currently served when `unchanged` is true and differs from `sequence`. */
  liveSequence?: number;
  /** Actual live deploy Forge State currently served when `unchanged` is true and differs from `head`. */
  liveHead?: string;
};
type LandingDeploys = Record<string, DeployEntry | null>;

const SUMMARY_CHARS = 240;

const toEntry = (row: Doc<'projectDeploys'>, unchangedOverride?: true): DeployEntry => {
  const unchanged = unchangedOverride ?? (row.unchanged ? true : undefined);
  return {
    sequence: row.sequence,
    head: row.head,
    at: row.at,
    runId: row.runId,
    ...(row.url ? { url: row.url } : {}),
    ...(unchanged ? { unchanged } : {}),
    ...(unchanged && row.liveSequence !== undefined ? { liveSequence: row.liveSequence } : {}),
    ...(unchanged && row.liveHead ? { liveHead: row.liveHead } : {}),
  };
};

const clampText = (value: string | undefined) => {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, SUMMARY_CHARS) : undefined;
};

function configuredTarget(project: Doc<'hostedProjects'>, name: string) {
  const target = project.autonomyPolicy?.deploys?.targets.find(target => target.name === name);
  invariant(target, 'EVIDENCE_CHANGED', 'This deploy target is not declared by the project.');
  return target;
}

/** Verify the signed CI identity against the live project declaration. */
async function authorizedDeployTarget(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  name: string,
  repository: string,
  workflow: string,
) {
  const project = await ctx.db.get(projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable.');
  const target = configuredTarget(project, name);
  invariant(
    project.sourceAuthority?.mode === 'server' && target.githubActions?.workflow === workflow,
    'EVIDENCE_CHANGED',
    'Deploy workflow does not match this project target.',
  );
  const expectedRepo = await resolveDeployRepository(ctx, project);
  invariant(
    expectedRepo && expectedRepo.toLowerCase() === repository.toLowerCase(),
    'EVIDENCE_CHANGED',
    'Deploy workflow repository does not match this project CI adapter.',
  );
  return target;
}

const oidcArgs = {
  projectId: v.id('hostedProjects'),
  target: deployTarget,
  repository: v.string(),
  workflow: v.string(),
};

/** True ONLY when per-landing overlap log rows strictly within `(afterSequence, toSequence]` are
 * complete, contiguous, non-null and contain zero paths affecting `target`. */
async function provenUnchangedBetween(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  target: DeployTarget,
  afterSequence: number,
  toSequence: number,
) {
  const rows = await ctx.db
    .query('projectHostedOverlapMainLog')
    .withIndex('by_project_and_sequence', q =>
      q.eq('projectId', projectId).gt('sequence', afterSequence).lte('sequence', toSequence),
    )
    .take(MAIN_LOG_WINDOW + 1);
  if (!rows.length || rows.length > MAIN_LOG_WINDOW) return false;
  if (rows[0]!.after > afterSequence || rows.at(-1)!.sequence !== toSequence) return false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.paths === null || (i > 0 && row.after !== rows[i - 1]!.sequence)) return false;
    if (pathsAffectTarget(target, JSON.parse(row.paths) as string[])) return false;
  }
  return true;
}

/** Read-only plan context for one deploy workflow run. Runs as an internalQuery (zero writes,
 * zero R2 URL minting). Computes `changedPaths` from the newest actual upload so `plan --deep`
 * and `site-deploy-plan` always compare against the live build. */
export const mainContext = internalQuery({
  args: oidcArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    await authorizedDeployTarget(ctx, input.projectId, input.target, input.repository, input.workflow);
    const main = await hostedStartMain(ctx, input.projectId);
    const [{ last, lastUploaded }, newest] = await Promise.all([
      newestSuccesses(ctx, input.projectId, input.target),
      newestCompletedRow(ctx, input.projectId, input.target),
    ]);
    const newestFailed = Boolean(newest && newest.status !== 'succeeded');
    const alreadyLive = Boolean(last && last.sequence >= main.sourceRevision && !newestFailed);
    const base = lastUploaded ?? last;
    let changedPaths: string[] | null = null;
    if (base && !newestFailed) {
      if (base.sequence >= main.sourceRevision) changedPaths = [];
      else {
        const since = await overlapMainSince(ctx, input.projectId, base.sequence);
        if (since && since.sequence >= main.sourceRevision) {
          const parsed = JSON.parse(since.changes) as [string, number][];
          changedPaths = [
            ...new Set(parsed.filter(([, seq]) => seq > base.sequence).map(([path]) => path)),
          ].sort();
        }
      }
    }
    return JSON.stringify({
      head: main.head,
      sequence: main.sourceRevision,
      alreadyLive,
      newestFailed,
      lastDeployed: last ? toEntry(last) : null,
      lastUploaded: lastUploaded ? toEntry(lastUploaded) : null,
      changedPaths,
    });
  },
});

async function workflowForDispatch(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; target: string; repository?: string },
) {
  const project = await ctx.db.get(input.projectId);
  if (!project || project.removal || project.sourceAuthority?.mode !== 'server') return null;
  const workflow = project.autonomyPolicy?.deploys?.targets.find(
    target => target.name === input.target,
  )?.githubActions;
  if (!workflow) return null;
  if (input.repository) {
    const repository = await resolveDeployRepository(ctx, project);
    if (repository?.toLowerCase() !== input.repository.toLowerCase()) return null;
  }
  return workflow;
}

export const dispatchWorkflow = internalQuery({
  args: { projectId: v.id('hostedProjects'), target: deployTarget, repository: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => (await workflowForDispatch(ctx, input))?.workflow ?? null,
});

/** Atomically claim the coalesced pending dispatch for `(projectId, target)`. For web, if an upload
 * just succeeded inside the 5-minute window while this dispatch was waiting, keeps the marker alive
 * and returns `{ action: 'defer', delayMs }` so the caller reschedules once when the window opens. */
export const claimQueued = internalMutation({
  args: { projectId: v.id('hostedProjects'), target: deployTarget, repository: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectDeploys')
      .withIndex('by_project_and_target_and_run', q =>
        q.eq('projectId', input.projectId).eq('target', input.target).eq('runId', 'queued'),
      )
      .unique();
    if (!row) return JSON.stringify({ action: 'none' });
    const workflow = await workflowForDispatch(ctx, input);
    if (!workflow) {
      await ctx.db.delete(row._id);
      return JSON.stringify({ action: 'none' });
    }
    if (workflow.minimumIntervalMs) {
      const { lastUploaded } = await newestSuccesses(ctx, input.projectId, input.target);
      if (lastUploaded && lastUploaded.sequence >= row.sequence) {
        await ctx.db.delete(row._id);
        return JSON.stringify({ action: 'none' });
      }
      const remaining = lastUploaded
        ? Date.parse(lastUploaded.at) + workflow.minimumIntervalMs - Date.now()
        : 0;
      if (remaining > 0)
        return JSON.stringify({
          action: 'defer',
          delayMs: Math.max(DEPLOY_COALESCE_MS, remaining + 1_000),
          state: row.head,
          sequence: row.sequence,
        });
    }
    await ctx.db.delete(row._id);
    return JSON.stringify({
      action: 'dispatch',
      state: row.head,
      sequence: row.sequence,
      workflow: workflow.workflow,
    });
  },
});

/** Select main's exact State for manifest download or stateSourceGrants during a deploy checkout. */
export const selectState = internalMutation({
  args: {
    ...oidcArgs,
    state: v.string(),
    sequence: v.optional(v.number()),
    recheck: v.optional(
      v.object({
        size: v.number(),
        physical: v.optional(v.object({ sha256: v.string(), size: v.number() })),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    await authorizedDeployTarget(ctx, input.projectId, input.target, input.repository, input.workflow);
    invariant(/^[a-f0-9]{64}$/.test(input.state), 'SOURCE_UNAVAILABLE', 'Select a valid State.');
    const main = await hostedStartMain(ctx, input.projectId);
    if (main.head !== input.state) {
      let found = false;
      if (input.sequence !== undefined && Number.isSafeInteger(input.sequence) && input.sequence > 0) {
        const [bySeq] = await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_sequence', q =>
            q.eq('projectId', input.projectId).eq('sequence', input.sequence!),
          )
          .take(1);
        if (bySeq) {
          try {
            found =
              (JSON.parse(bySeq.value) as { candidate?: { head?: string } }).candidate?.head === input.state;
          } catch {
            found = false;
          }
        }
      }
      if (!found) {
        const accepted = await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_sequence', q => q.eq('projectId', input.projectId))
          .order('desc')
          .take(100);
        found = accepted.some(row => {
          try {
            return (
              (JSON.parse(row.value) as { candidate?: { head?: string } }).candidate?.head === input.state
            );
          } catch {
            return false;
          }
        });
      }
      invariant(found, 'SOURCE_UNAVAILABLE', 'Selected State is not on hosted main.');
    }
    const row = await findObject(ctx, input.projectId, input.state);
    invariant(row && !row.removed && isStored(row), 'SOURCE_UNAVAILABLE', 'Selected State is unavailable.');
    const object = { sha256: input.state, size: row.size };
    const physical = await readablePhysical(ctx, row);
    if (
      input.recheck &&
      row.sourceReferenced &&
      input.recheck.size === row.size &&
      input.recheck.physical?.sha256 === physical?.sha256 &&
      input.recheck.physical?.size === physical?.size
    )
      return JSON.stringify({
        descriptor: { object, recipe: null },
        ...(physical ? { statePhysical: physical } : {}),
        url: null,
      });
    const value = await sourceObjectLocation(
      ctx,
      input.projectId,
      object,
      physical ? row : { ...row, statePhysical: undefined },
    );
    return JSON.stringify(value);
  },
});

export const catalog = internalMutation({
  args: {
    ...oidcArgs,
    digests: v.array(v.string()),
    runs: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    await authorizedDeployTarget(ctx, input.projectId, input.target, input.repository, input.workflow);
    return describeObjects(
      ctx,
      { projectId: input.projectId, digests: input.digests, signed: true, runs: input.runs },
      500,
    );
  },
});

const safeUrl = (value: string | undefined) =>
  value && /^https:\/\/[^\s]{1,400}$/.test(value) ? value : undefined;

const deployReportArgs = {
  state: v.string(),
  sequence: v.number(),
  status: deployOutcome,
  runId: v.string(),
  url: v.optional(v.string()),
  summary: v.optional(v.string()),
  cause: v.optional(v.string()),
  smoke: v.optional(deploySmoke),
  unchanged: v.optional(v.literal(true)),
  liveSequence: v.optional(v.number()),
  liveHead: v.optional(v.string()),
};
const deployReportArgsForProject = {
  projectId: v.id('hostedProjects'),
  target: deployTarget,
  ...deployReportArgs,
};
type DeployReport = ObjectType<typeof deployReportArgsForProject>;

/** Record a deploy run outcome from an OIDC-authenticated deploy workflow. Keyed by verified
 * `${run_id}:${run_attempt}` so retries of the same callback are idempotent while re-runs never
 * overwrite an earlier successful attempt's record. */
export const record = internalMutation({
  args: { ...oidcArgs, ...deployReportArgs },
  returns: v.string(),
  handler: async (ctx, input) => {
    const target = await authorizedDeployTarget(
      ctx,
      input.projectId,
      input.target,
      input.repository,
      input.workflow,
    );
    invariant(
      /^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(input.runId),
      'BAD_ARGUMENT',
      'Invalid signed CI run id.',
    );
    return recordDeploy(ctx, input, target, input.repository, input.workflow);
  },
});

/** A project owner can report the same outcome from a CI system using Forge account/device authorization. */
export const reportByoci = mutation({
  args: deployReportArgsForProject,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to report deploy evidence.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const target = configuredTarget(project, input.target);
      invariant(deployTargetName.safeParse(input.target).success, 'BAD_ARGUMENT', 'Invalid deploy target.');
      invariant(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.runId),
        'BAD_ARGUMENT',
        'Invalid CI run id.',
      );
      return await recordDeploy(ctx, { ...input, runId: `ci:${input.runId}` }, target);
    } catch (error) {
      return report(error);
    }
  },
});

async function recordDeploy(
  ctx: MutationCtx,
  input: DeployReport,
  target: DeployTarget,
  repository?: string,
  workflow?: string,
) {
  invariant(/^[a-f0-9]{64}$/.test(input.state), 'BAD_ARGUMENT', 'State must be a full 64-hex hash.');
  invariant(
    Number.isSafeInteger(input.sequence) && input.sequence > 0,
    'BAD_ARGUMENT',
    'Sequence must be a positive integer.',
  );
  if (input.liveHead !== undefined)
    invariant(/^[a-f0-9]{64}$/.test(input.liveHead), 'BAD_ARGUMENT', 'liveHead must be a full 64-hex hash.');
  if (input.liveSequence !== undefined)
    invariant(
      Number.isSafeInteger(input.liveSequence) && input.liveSequence > 0,
      'BAD_ARGUMENT',
      'liveSequence must be a positive integer.',
    );
  // Verify the reported (sequence, state) is a real main revision on this project.
  const main = await hostedStartMain(ctx, input.projectId);
  if (main.sourceRevision !== input.sequence || main.head !== input.state) {
    const [row] = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('sequence', input.sequence),
      )
      .take(1);
    const head = row ? (JSON.parse(row.value) as { candidate?: { head?: string } }).candidate?.head : null;
    invariant(head === input.state, 'EVIDENCE_CHANGED', 'Reported deploy head differs from hosted main.');
  }
  const existing = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_run', q =>
      q.eq('projectId', input.projectId).eq('target', input.target).eq('runId', input.runId),
    )
    .unique();
  // Never erase or downgrade an already-recorded successful deploy for the same run attempt.
  if (
    existing &&
    existing.status === 'succeeded' &&
    (input.status !== 'succeeded' || existing.head !== input.state)
  ) {
    return JSON.stringify({
      recorded: false,
      preserved: true,
      target: input.target,
      sequence: existing.sequence,
      status: existing.status,
    });
  }
  if (existing?.head !== undefined) {
    invariant(
      existing.head === input.state && existing.sequence === input.sequence,
      'EVIDENCE_CHANGED',
      'The CI run id already names a different landing.',
    );
    if (existing.status === input.status)
      return JSON.stringify({
        recorded: true,
        target: input.target,
        sequence: input.sequence,
        status: input.status,
      });
  }
  const clampedSmoke = input.smoke
    ? {
        ok: input.smoke.ok,
        checks: input.smoke.checks.slice(0, 16).map(check => ({
          name: check.name.slice(0, 64),
          ok: check.ok,
          ...(check.status !== undefined ? { status: check.status } : {}),
          ...(clampText(check.detail) ? { detail: clampText(check.detail) } : {}),
        })),
      }
    : undefined;
  const summary = clampText(input.summary);
  const unchanged: true | undefined = input.status === 'succeeded' && input.unchanged ? true : undefined;
  const now = Date.now();
  const doc = {
    projectId: input.projectId,
    target: input.target,
    ...(workflow ? { workflow } : {}),
    sequence: input.sequence,
    head: input.state,
    status: input.status,
    runId: input.runId,
    at: new Date(now).toISOString(),
    ...(safeUrl(input.url) ? { url: safeUrl(input.url) } : {}),
    ...(summary ? { summary } : {}),
    ...(clampedSmoke ? { smoke: clampedSmoke } : {}),
    ...(unchanged ? { unchanged } : {}),
    ...(unchanged && input.liveSequence !== undefined ? { liveSequence: input.liveSequence } : {}),
    ...(unchanged && input.liveHead ? { liveHead: input.liveHead } : {}),
  };
  let failure: Doc<'projectDeploys'>['failure'];
  if (doc.status !== 'succeeded') {
    const newest = await newestCompletedRow(ctx, input.projectId, input.target);
    const previous =
      newest && newest.sequence <= input.sequence && newest.status !== 'succeeded'
        ? await readFailure(ctx, newest)
        : null;
    const lastLive = previous
      ? previous.liveSequence
      : newest?.status === 'succeeded'
        ? liveSequence(newest)
        : await lastVerifiedLive(ctx, input.projectId, input.target);
    failure = failureDetails({ ...doc, cause: clampText(input.cause) }, previous, lastLive);
  }
  if (existing) await ctx.db.patch(existing._id, { ...doc, failure });
  else await ctx.db.insert('projectDeploys', { ...doc, ...(failure ? { failure } : {}) });
  // If a newer web-affecting landing arrived while this web upload was in flight, schedule one
  // trailing flush when the 5-minute window opens so it never waits for the 3-hour catch-up.
  let trailingFlushScheduled = false;
  if (
    repository &&
    workflow &&
    target.githubActions?.minimumIntervalMs &&
    input.status === 'succeeded' &&
    !unchanged &&
    main.sourceRevision > input.sequence
  ) {
    const unchangedAfter = await provenUnchangedBetween(
      ctx,
      input.projectId,
      target,
      input.sequence,
      main.sourceRevision,
    );
    if (!unchangedAfter) {
      trailingFlushScheduled = await queueDeployDispatch(ctx, {
        projectId: input.projectId,
        repository,
        workflow,
        target: input.target,
        head: main.head,
        sequence: main.sourceRevision,
        delayMs: target.githubActions.minimumIntervalMs + 1_000,
        now,
      });
    }
  }
  return JSON.stringify({
    recorded: true,
    target: input.target,
    sequence: input.sequence,
    status: input.status,
    ...(unchanged ? { unchanged: true } : {}),
    ...(trailingFlushScheduled ? { trailingFlushScheduled: true } : {}),
  });
}

/** When no deploy at/after `sequence` has succeeded yet, check whether the latest prior successful
 * deploy already serves the exact same files for `target` (zero target-affecting paths changed in
 * `(prior.sequence, sequence]`). Queries per-landing log rows strictly within `(prior.sequence,
 * sequence]` so a later landing (`> sequence`) touching the same path can never mask an earlier change. */
async function unchangedPriorDeploy(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  target: DeployTarget,
  sequence: number,
): Promise<DeployEntry | null> {
  const [prior] = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_status_and_sequence', q =>
      q
        .eq('projectId', projectId)
        .eq('target', target.name)
        .eq('status', 'succeeded')
        .lt('sequence', sequence),
    )
    .order('desc')
    .take(1);
  if (!prior) return null;
  if (!(await provenUnchangedBetween(ctx, projectId, target, prior.sequence, sequence))) return null;
  return toEntry(prior, true);
}

/** First successful deploy per target whose head contains `sequence` (ancestry: deploy.sequence >= sequence),
 * or the prior successful deploy marked `unchanged: true` when no files affecting that target changed.
 * Returns null when the project has no deploy records at all, so projects without deploys stay untouched. */
export async function deploysForSequence(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  sequence: number,
): Promise<LandingDeploys | null> {
  const targets = project.autonomyPolicy?.deploys?.targets ?? [];
  if (!targets.length) return null;
  const projectId = project._id;
  const resolved = await Promise.all(
    targets.map(async target => {
      const [firstSuccess] = await ctx.db
        .query('projectDeploys')
        .withIndex('by_project_and_target_and_status_and_sequence', q =>
          q
            .eq('projectId', projectId)
            .eq('target', target.name)
            .eq('status', 'succeeded')
            .gte('sequence', sequence),
        )
        .take(1);
      return [
        target.name,
        firstSuccess ? toEntry(firstSuccess) : await unchangedPriorDeploy(ctx, projectId, target, sequence),
      ] as const;
    }),
  );
  if (!resolved.some(([, entry]) => entry)) {
    const newest = await ctx.db
      .query('projectDeploys')
      .withIndex('by_project_and_target_and_sequence', q => q.eq('projectId', projectId))
      .first();
    if (!newest) return null;
  }
  return Object.fromEntries(resolved);
}

/** Reactive wait read for `wait {"deploy": ...}`: checks ancestry (`sequence >= targetSequence`)
 * without polling. Targets unaffected by changes since their prior successful deploy count as
 * deployed (`unchanged: true`) so single-target or test-only landings never hang waiting forever. */
export async function deployWaitStatus(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  sequence: number,
  requested: string,
) {
  const targets =
    requested === 'all'
      ? (project.autonomyPolicy?.deploys?.targets ?? [])
      : [configuredTarget(project, requested)];
  const projectId = project._id;
  const entries = await Promise.all(
    targets.map(async target => {
      const [firstSuccess] = await ctx.db
        .query('projectDeploys')
        .withIndex('by_project_and_target_and_status_and_sequence', q =>
          q
            .eq('projectId', projectId)
            .eq('target', target.name)
            .eq('status', 'succeeded')
            .gte('sequence', sequence),
        )
        .take(1);
      if (firstSuccess)
        return [target.name, { state: 'deployed' as const, deploy: toEntry(firstSuccess) }] as const;
      const recent = await ctx.db
        .query('projectDeploys')
        .withIndex('by_project_and_target_and_sequence', q =>
          q.eq('projectId', projectId).eq('target', target.name).gte('sequence', sequence),
        )
        .order('desc')
        .take(4);
      const newest = recent.find(row => row.status !== 'queued');
      if (newest && newest.status !== 'succeeded')
        return [
          target.name,
          {
            state: 'failed' as const,
            deploy: {
              ...toEntry(newest),
              status: newest.status,
              ...(newest.summary ? { summary: newest.summary } : {}),
              ...(newest.smoke ? { smoke: newest.smoke } : {}),
            },
          },
        ] as const;
      const unchanged = await unchangedPriorDeploy(ctx, projectId, target, sequence);
      if (unchanged) return [target.name, { state: 'deployed' as const, deploy: unchanged }] as const;
      return [target.name, { state: 'pending' as const, deploy: null, queuedAt: recent[0]?.at }] as const;
    }),
  );
  const byTarget = Object.fromEntries(entries.map(([name, info]) => [name, info.deploy]));
  const states = entries.map(([, info]) => info.state);
  const state =
    states.length > 0 && states.every(s => s === 'deployed')
      ? 'deployed'
      : states.some(s => s === 'failed')
        ? 'failed'
        : 'pending';
  const lastProgressAt = entries
    .map(([, info]) => ('queuedAt' in info ? info.queuedAt : info.deploy?.at))
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  return { state, deploys: byTarget, lastProgressAt } as const;
}
