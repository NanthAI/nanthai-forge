// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { isDeviceIdentity } from './cliServer';
import {
  approvalRow,
  laneApproveUrl,
  openSettingRequest,
  writeApproval,
  type ApprovalRow,
} from './projectHostedApprovalStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

/**
 * Issue 470ef29b: the project policy, check definitions and runner settings decide what a landing
 * must pass, so an agent (any device sign-in, the owner's own CLI included) cannot change them
 * silently. Its write becomes one approval request the owner person grants on the approve link
 * (the fe5bea80 path); the grant applies exactly that change. The result names the rule that applied.
 */
export type SettingRule =
  /** The owner person wrote it. */
  | 'owner-person'
  /** The owner person granted an agent's request; the change was applied as requested. */
  | 'owner-approved'
  /** An agent on a project with no accepted landing yet: setup (scratch, zoo, bench) applies directly. */
  | 'bootstrap'
  /** An agent's policy edit that changes nothing a landing depends on (agent defaults, notifications…). */
  | 'no-gate-change'
  /** An agent's change, held for the owner person. */
  | 'held';
export type SettingOrigin = 'policy' | 'check-definition' | 'check-import' | 'runner' | 'main-audit';

/** Settings requests share the approvals table under a `setting:` key, one row per setting. Like fork
 * PR requests they are never `live` (they hold no landing, so the landing gate's read never sees
 * them); a request is open until it `ended`. */
export const settingKey = (origin: SettingOrigin, item?: string) =>
  `setting:${origin}${item ? `:${item}` : ''}`;

/** Direct for the owner person; for an agent, direct only before the project's first accepted landing.
 * One indexed read, only for an agent's settings write; nothing on the landing path. */
export async function agentSettingRule(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  user: { issuer?: string; forgeCredential?: unknown },
): Promise<'owner-person' | 'bootstrap' | 'held'> {
  if (!isDeviceIdentity(user)) return 'owner-person';
  const landed = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .first();
  return landed ? 'held' : 'bootstrap';
}

/** The digest the owner decides on: the exact request (and the policy it was made against). */
const requestHead = (request: string, base?: string) =>
  digest(canonicalPayload({ request, base: base ?? null }));

export function settingReply(row: ApprovalRow) {
  const url = laneApproveUrl(row.projectId, row.laneId);
  return {
    id: row.laneId,
    status: row.status,
    live: openSettingRequest(row),
    url,
    next: `This settings change needs the project owner. ${url ? 'Hand them this link; they open it signed in and grant or decline. ' : 'Ask them to grant it on the approve page. '}The grant applies exactly this change. Wait for the decision: nforge agent ROOT wait '{"approval":"${row.laneId}"}'.`,
  };
}

/** The held request with this operation id, for a replay; refuses a changed retry. */
export async function heldReplay(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  key: string,
  operationId: string,
  request: string,
) {
  const row = await approvalRow(ctx, projectId, key);
  if (row?.operationId !== operationId || !row.setting) return null;
  invariant(row.setting.request === request, 'WORK_OPERATION_CHANGED', 'Retry with the original values.');
  return row;
}

/** Writes (or reopens) the one request row for this setting: one indexed read and one write. */
export async function holdSetting(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    key: string;
    origin: SettingOrigin;
    operationId: string;
    requester: string;
    request: string;
    summary: string;
    base?: string;
  },
) {
  const old = await approvalRow(ctx, input.projectId, input.key);
  const fields = {
    operationId: input.operationId,
    requester: input.requester,
    reason: input.summary,
    head: requestHead(input.request, input.base),
    at: Date.now(),
    status: 'requested' as const,
    live: false,
    decision: undefined,
    ended: undefined,
    agent: undefined,
    setting: {
      origin: input.origin,
      request: input.request,
      ...(input.base ? { base: input.base } : {}),
    },
  };
  if (old) await writeApproval(ctx, old, fields);
  else
    await ctx.db.insert('projectHostedApprovals', {
      projectId: input.projectId,
      laneId: input.key,
      ...fields,
      version: 1,
    });
  return (await approvalRow(ctx, input.projectId, input.key))!;
}
