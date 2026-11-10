// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { z } from 'zod';
import { internalAction, internalMutation, internalQuery } from './server';
import { isDeviceIdentity, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { auditRow } from './projectHostedMainAuditState';
import { beginCheckOperation, checkCaller, completeCheckOperation } from './projectHostedCheckStore';
import { heldReplay, holdSetting, settingKey, settingReply } from './projectSettingApprovals';
import { hostedOperationRow } from './projectHostedOperations';
import {
  FAST_DRILL_MS,
  drillClaims,
  earnedFromHistory,
  landingEarnedSchema,
  type EarnEvent,
  type EarnLanding,
} from '../src/landing-mode';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** Owner-only writes of the fast-landing earned state (Issue fe7d67a8): start a red-audit drill, or
 * recount the counters from retained audit history. An agent's request (any device sign-in, the
 * owner's own CLI included) only opens an approval request the owner person grants. */
const earnSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: z.number().safe().nonnegative(),
    earn: z.union([
      z.object({ drill: z.literal('start') }).strict(),
      z.object({ backfill: z.object({ since: z.iso.datetime() }).strict() }).strict(),
    ]),
  })
  .strict();
export const isEarnRequest = (text: string) => {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null && 'earn' in value;
};
const summary = (earn: z.infer<typeof earnSchema>['earn']) =>
  'drill' in earn
    ? `Start a red-audit drill: the first red main audit within ${FAST_DRILL_MS / 3_600_000} h is the drill. If it recovers within ${FAST_DRILL_MS / 3_600_000} h it is the recovered red that fast landing needs and the audited count is kept; otherwise it is a real red and the count restarts.`
    : `Recount the fast-landing counters from audit history since ${earn.backfill.since}, with the live counter's rules. Replaces the current counters.`;
export async function earnMainAudit(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  text: string,
  approved: boolean,
) {
  const request = earnSchema.parse(JSON.parse(text));
  const { actor, project } = await checkCaller(ctx, projectId);
  invariant(project.owner === actor, 'PROJECT_UNAVAILABLE', 'Project check settings belong to its owner.');
  const user = (await ctx.auth.getUserIdentity())!;
  const key = settingKey('main-audit', 'drill' in request.earn ? 'drill' : 'backfill');
  if (approved)
    invariant(!isDeviceIdentity(user), 'PROJECT_UNAVAILABLE', 'Only the owner person can grant this.');
  // Always held for an agent, setup projects included: the drill decides what fast landing may skip.
  else if (
    isDeviceIdentity(user) &&
    !(await hostedOperationRow(ctx, projectId, actor, request.operationId))
  ) {
    const payload = canonicalPayload(request);
    const row =
      (await heldReplay(ctx, projectId, key, request.operationId, payload)) ??
      (await holdSetting(ctx, {
        projectId,
        key,
        origin: 'main-audit',
        operationId: request.operationId,
        requester: actor,
        request: payload,
        summary: summary(request.earn),
      }));
    return canonicalPayload({ operationId: request.operationId, rule: 'held', approval: settingReply(row) });
  }
  const prepared = await beginCheckOperation(ctx, {
    projectId,
    actor,
    operationId: request.operationId,
    expected: { authorityEpoch: request.authorityEpoch },
    payload: request,
  });
  if (prepared.replayed) {
    invariant(
      prepared.operation.terminal?.outcome.status === 'completed',
      'SOURCE_UNAVAILABLE',
      'Original check settings receipt is unavailable.',
    );
    return canonicalPayload(prepared.operation.terminal.outcome.result);
  }
  const at = prepared.operation.firstAttempt.at;
  const rule = approved ? 'owner-approved' : 'owner-person';
  let result;
  if ('drill' in request.earn) {
    const row = await auditRow(ctx, projectId);
    invariant(
      row?.lastGreen && !row.red,
      'MAIN_RED',
      'A drill starts on a green main: wait until the main audit passes.',
    );
    const open = drillClaims(row.drill, at);
    if (!open) await ctx.db.patch(row._id, { drill: { startedAt: at } });
    result = {
      drill: { startedAt: open ? row.drill!.startedAt : at, windowMs: FAST_DRILL_MS, started: !open },
      rule,
    };
  } else {
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedMainAuditEarn:backfill'), {
      projectId,
      since: request.earn.backfill.since,
    });
    result = { backfill: { since: request.earn.backfill.since, scheduled: true }, rule };
  }
  await completeCheckOperation(ctx, prepared.operation, result);
  return canonicalPayload(result);
}

const PAGE = 100;
const pageArgs = {
  projectId: v.id('hostedProjects'),
  since: v.number(),
  through: v.number(),
  cursor: v.union(v.string(), v.null()),
};
/** The main revision the recount runs through: the last green, unless main is red. */
export const head = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, input) => {
    const row = await auditRow(ctx, input.projectId);
    return row?.lastGreen && !row.red ? row.lastGreen.sequence : null;
  },
});
/** One page of receipts at or below `through`, reduced to what the counter reads. */
export const landingPage = internalQuery({
  args: pageArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project', q => q.eq('projectId', input.projectId).gte('_creationTime', input.since))
      .order('asc')
      .paginate({ cursor: input.cursor, numItems: PAGE, maximumBytesRead: 4 * 1024 * 1024 });
    const landings: EarnLanding[] = [];
    let past = false;
    for (const row of page.page) {
      if (row.sequence > input.through) {
        past = true;
        continue;
      }
      const receipt = JSON.parse(row.value) as {
        check?: { skipped?: unknown };
        firstCheck?: { landedOn?: string };
      };
      landings.push({
        sequence: row.sequence,
        kind: receipt.check?.skipped
          ? 'docs'
          : receipt.firstCheck?.landedOn === 'recheck'
            ? 'exact'
            : 'proof',
      });
    }
    return JSON.stringify({ landings, next: page.isDone || past ? null : page.continueCursor });
  },
});
/** One page of audit events from `since` (a sequence here) through `through`. */
export const eventPage = internalQuery({
  args: pageArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectHostedMainAuditEvents')
      .withIndex('by_project_and_sequence', q =>
        q.eq('projectId', input.projectId).gte('sequence', input.since).lte('sequence', input.through),
      )
      .order('asc')
      .paginate({ cursor: input.cursor, numItems: 4 * PAGE });
    const events: EarnEvent[] = page.page.map(({ kind, at, runId, sequence, drill, reverted }) => ({
      kind,
      at,
      runId,
      sequence,
      ...(drill ? { drill } : {}),
      ...(reverted !== undefined ? { reverted } : {}),
    }));
    return JSON.stringify({ events, next: page.isDone ? null : page.continueCursor });
  },
});
/** Replaces the counters only if main has not moved past the recount; the action recounts otherwise. */
export const write = internalMutation({
  args: { projectId: v.id('hostedProjects'), through: v.number(), earned: v.string() },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await auditRow(ctx, input.projectId);
    if (!row || row.red || row.lastGreen?.sequence !== input.through) return false;
    await ctx.db.patch(row._id, { earned: landingEarnedSchema.parse(JSON.parse(input.earned)) });
    return true;
  },
});
/** The owner's recount: pages of receipts and events once (about 300 landings, ~1.5 MB on dogfood),
 * then one write. Rerunning gives the same counters for the same history: idempotent. */
export const backfill = internalAction({
  args: { projectId: v.id('hostedProjects'), since: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const ref = (name: string) => makeFunctionReference<'query'>(`projectHostedMainAuditEarn:${name}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const through = (await ctx.runQuery(ref('head'), { projectId: input.projectId })) as number | null;
      if (through === null) return null;
      const landings: EarnLanding[] = [];
      const events: EarnEvent[] = [];
      for (const [name, into, since] of [
        ['landingPage', landings, Date.parse(input.since)],
        ['eventPage', events, null],
      ] as const) {
        let cursor: string | null = null;
        do {
          const page = JSON.parse(
            (await ctx.runQuery(ref(name), {
              projectId: input.projectId,
              since: since ?? landings[0]?.sequence ?? through + 1,
              through,
              cursor,
            })) as string,
          ) as { landings?: EarnLanding[]; events?: EarnEvent[]; next: string | null };
          (into as unknown[]).push(...(page.landings ?? page.events ?? []));
          cursor = page.next;
        } while (cursor !== null);
      }
      landings.sort((a, b) => a.sequence - b.sequence);
      const earned = earnedFromHistory(landings, events);
      const written = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedMainAuditEarn:write'),
        {
          projectId: input.projectId,
          through,
          earned: JSON.stringify(earned),
        },
      );
      if (written) return null;
    }
    return null;
  },
});
