// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { isDeviceIdentity, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { auditRow } from './projectHostedMainAuditState';
import { beginCheckOperation, checkCaller, completeCheckOperation } from './projectHostedCheckStore';
import { heldReplay, holdSetting, settingKey, settingReply } from './projectSettingApprovals';
import { hostedOperationRow } from './projectHostedOperations';
import { FAST_DRILL_MS, drillClaims } from '../src/landing-mode';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** Optional owner-only red-audit drill. The legacy `earn` transport key and backfill
 * request remain parseable for older CLIs; a recount is now an inert compatibility reply. */
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
    ? `Start a red-audit drill: the first red main audit within ${FAST_DRILL_MS / 3_600_000} h is the drill. If it recovers within ${FAST_DRILL_MS / 3_600_000} h it is recorded as a drill rather than a real red; otherwise it counts as a real red. A drill is optional and never required for fast landing.`
    : 'Fast landing no longer uses earning counters; no recount is needed.';
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
  // Preserve the existing owner approval for deliberate drills from an agent sign-in.
  else if (
    'drill' in request.earn &&
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
    result = {
      backfill: {
        since: request.earn.backfill.since,
        scheduled: false,
        reason: 'Fast landing uses a circuit breaker; no recount is needed.',
      },
      rule,
    };
  }
  await completeCheckOperation(ctx, prepared.operation, result);
  return canonicalPayload(result);
}
