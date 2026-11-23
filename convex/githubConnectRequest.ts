// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  approvalRow,
  openSettingRequest,
  writeApproval,
  type ApprovalRow,
} from './projectHostedApprovalStore';
import { holdSetting, settingKey, settingReply } from './projectSettingApprovals';
import { canonicalPayload } from '../src/hosted-source-operation';

/**
 * Item c63c2171: an agent's `nforge github connect` is the owner's decision, asked on Forge in the agent's
 * own words (Needs me and the approve link), not a bare GitHub page. Granting sends the owner person on
 * to GitHub's own authorization, which still proves repository access; declining ends the connect.
 * One approval row per project (`setting:github-connect`); a new connect replaces an older request.
 * Cost: two indexed reads and one write when an agent starts a connect, and one read when that connect is
 * replayed, completes or fails. A person's connect, landings and idle pages pay nothing.
 */
const key = settingKey('github-connect');
const WORDS_LIMIT = 500;
type BindingOperation = Doc<'githubBindingOperations'>;

const reply = (row: ApprovalRow) => {
  const { id, status, url } = settingReply(row);
  return {
    id,
    status,
    url,
    next: `Connecting GitHub needs the project owner. ${url ? 'Hand them this link; they open it signed in, read your request and allow it, then authorize on GitHub. ' : 'Ask them to allow it in Forge → Needs me. '}Tell your user in your own app that it waits for the owner. This command waits for the result.`,
  };
};

/** Holds the request for the owner person; the agent's words are what they read first. */
export async function holdConnect(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    actor: string;
    repository: string;
    mirror?: boolean;
    oneWay?: boolean;
    reason?: string;
  },
) {
  const words = input.reason?.replace(/\s+/g, ' ').trim().slice(0, WORDS_LIMIT);
  const direction = input.mirror === false ? 'off' : input.oneWay ? 'one-way' : 'two-way';
  const row = await holdSetting(ctx, {
    projectId: input.projectId,
    key,
    origin: 'github-connect',
    operationId: input.operationId,
    requester: input.actor,
    request: canonicalPayload({ operationId: input.operationId, repository: input.repository, direction }),
    summary: words || `Connect ${input.repository} to this project.`,
  });
  return reply(row);
}

/** A replayed connect returns the same request link (one indexed read, replays only). */
export async function connectApproval(ctx: QueryCtx | MutationCtx, op: BindingOperation) {
  if (!op.asked) return null;
  const row = await approvalRow(ctx, op.projectId, key);
  return row?.setting?.origin === 'github-connect' && row.operationId === op.operationId ? reply(row) : null;
}

const requested = (row: ApprovalRow) => JSON.parse(row.setting!.request) as { operationId: string };
const operation = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('githubBindingOperations')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();

/** A grant: the page continues to GitHub's authorization for the waiting connect (one indexed read). */
export async function grantConnect(ctx: MutationCtx, row: ApprovalRow) {
  const op = await operation(ctx, row.projectId, requested(row).operationId);
  return op?.status === 'waiting' ? { authorizeUrl: op.authorizeUrl } : { status: op?.status ?? 'missing' };
}

/** A decline ends the waiting connect (the decline code every owner decision uses), so the agent's `github connect` returns at once. */
export async function declineConnect(ctx: MutationCtx, row: ApprovalRow) {
  const op = await operation(ctx, row.projectId, requested(row).operationId);
  if (op?.status === 'waiting')
    await ctx.db.patch(op._id, { status: 'failed', code: 'REVIEW_DECLINED', verifier: '' });
}

/** GitHub's authorization finished (or failed) without the Forge page: the request is no longer open. */
export async function settleConnect(ctx: MutationCtx, op: BindingOperation) {
  if (!op.asked) return;
  const row = await approvalRow(ctx, op.projectId, key);
  if (row?.operationId === op.operationId && openSettingRequest(row))
    await writeApproval(ctx, row, { ended: { kind: 'applied', at: Date.now() } });
}
