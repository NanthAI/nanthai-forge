// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './cliServer';
import { secretCapability } from './schema';

type Ctx = QueryCtx | MutationCtx;
export const affectedGrant = v.object({
  principal: v.string(),
  capabilities: v.array(secretCapability),
  expiresAt: v.union(v.number(), v.null()),
});
export function grantSummary(row: Doc<'secretGrants'>) {
  return { principal: row.principal, capabilities: row.capabilities, expiresAt: row.expiresAt ?? null };
}
export async function principalGrant(ctx: Ctx, id: Id<'secretObjects'>, principal: string) {
  return ctx.db
    .query('secretGrants')
    .withIndex('by_secretId_and_principal', q => q.eq('secretId', id).eq('principal', principal))
    .unique();
}
/** Where secret grants to a person split into given before a review and given after it. `below` is a review epoch
 * (forgeAccounts.secretsReview). Giving a grant reads the person's account row and issuing a review writes it, so
 * Convex orders the two transactions: a grant given after the review carries an epoch at or above it, whatever the
 * clock says (reviews s1-sol62 r4 #1, s1-astra62 r4 #3). Only the server issues an epoch, so no caller chooses the
 * boundary. `before` is the time cutoff that receipts, closes and accounts recorded before epochs, kept only for them. */
export type GrantCut = { below?: number | undefined; before?: number | undefined };
export function givenBefore(row: Doc<'secretGrants'>, cut: GrantCut) {
  if (cut.below !== undefined) return (row.epoch ?? 0) < cut.below;
  return cut.before !== undefined && (row.grantedAt ?? row._creationTime) <= cut.before;
}
const person = (ctx: Ctx, owner: string) =>
  ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .unique();
/** The epoch a grant to `principal` records when it is given: 0 before their first review, or with no account row. */
export async function grantEpoch(ctx: Ctx, principal: string) {
  return (await person(ctx, principal))?.secretsReview?.epoch ?? 0;
}
/** Issues the person's next review epoch in one write to their account row. A retry of the same review (operation id)
 * returns the epoch it was issued; any other review supersedes it. Each epoch is above the row's last one, which is
 * what orders it; it is also at least the current time, so epochs keep rising when a closed account's row is made again
 * for the same key (an old-provider sign-in): a grant recorded under the old row is still below the new row's first
 * review. */
export async function nextReview(ctx: MutationCtx, account: Doc<'forgeAccounts'>, operationId: string) {
  const last = account.secretsReview;
  if (last?.operationId === operationId) return last.epoch;
  const epoch = Math.max((last?.epoch ?? 0) + 1, Date.now());
  await ctx.db.patch(account._id, { secretsReview: { epoch, operationId } });
  return epoch;
}
/** Whether a Your data cleanup or a close left this grant (forgeAccounts.secretsLeftBelow): it gives nothing from the
 * moment that is recorded, before the row itself is deleted. A grant given, or given again in place, after the review
 * keeps working. */
export async function leftByCleanup(ctx: Ctx, row: Doc<'secretGrants'>) {
  const p = await person(ctx, row.principal);
  return (
    !!p &&
    (givenBefore(row, { below: p.secretsLeftBelow }) || givenBefore(row, { before: p.secretsLeftBefore }))
  );
}
/** Older rows already retain the issuing actor in the audit; no hosted rewrite is needed. */
export async function granter(ctx: Ctx, row: Doc<'secretGrants'>): Promise<string | null> {
  if (row.grantedBy) return row.grantedBy;
  const events = ctx.db
    .query('secretEvents')
    .withIndex('by_secretId_and_principal_and_policyRevision', q =>
      q.eq('secretId', row.secretId).eq('principal', row.principal),
    )
    .order('desc');
  for await (const event of events) {
    // A self-update retains the authority that allowed the original grant.
    if (event.kind === 'grant' && event.capabilities?.length && event.actor !== row.principal)
      return event.actor;
  }
  return null;
}
export async function grantAuthority(ctx: Ctx, object: Doc<'secretObjects'>, actor: string) {
  let principal = actor,
    child: Doc<'secretGrants'> | null = null,
    expiresAt: number | null = null;
  const seen = new Set<string>();
  let capabilities = [
    'discover',
    'names',
    'use',
    'reveal',
    'modify',
    'delegate',
  ] as Doc<'secretGrants'>['capabilities'];
  while (principal !== object.owner) {
    if (seen.has(principal)) return { capabilities: [], expiresAt };
    seen.add(principal);
    const row = await principalGrant(ctx, object._id, principal);
    if (
      !row ||
      row.revokedAt !== undefined ||
      !row.capabilities.length ||
      (row.expiresAt !== undefined && row.expiresAt <= Date.now()) ||
      (child?.parentGrantId !== undefined && child.parentGrantId !== row._id) ||
      (child && !row.capabilities.includes('delegate')) ||
      (await leftByCleanup(ctx, row))
    )
      return { capabilities: [], expiresAt };
    capabilities = capabilities.filter(cap => row.capabilities.includes(cap));
    if (row.expiresAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, row.expiresAt);
    const by = await granter(ctx, row);
    if (!by) return { capabilities: [], expiresAt };
    child = row;
    principal = by;
  }
  return { capabilities, expiresAt };
}
export async function descendantGrants(ctx: Ctx, id: Id<'secretObjects'>, principal: string) {
  const children = new Map<string, Doc<'secretGrants'>[]>();
  for await (const row of ctx.db
    .query('secretGrants')
    .withIndex('by_secretId_and_principal', q => q.eq('secretId', id))) {
    if (row.revokedAt !== undefined || !row.capabilities.length) continue;
    const by = await granter(ctx, row);
    if (by && by !== row.principal) children.set(by, [...(children.get(by) ?? []), row]);
  }
  const seen = new Set([principal]),
    pending = [principal],
    affected: Doc<'secretGrants'>[] = [];
  for (let index = 0; index < pending.length; index++) {
    for (const row of children.get(pending[index]!) ?? []) {
      if (seen.has(row.principal)) continue;
      seen.add(row.principal);
      pending.push(row.principal);
      affected.push(row);
    }
  }
  return affected.sort((a, b) => a.principal.localeCompare(b.principal));
}

export async function revokeDescendants(
  ctx: MutationCtx,
  object: Doc<'secretObjects'>,
  principal: string,
  actor: string,
  operationId: string,
) {
  const rows = await descendantGrants(ctx, object._id, principal);
  for (const row of rows) {
    const digest = Array.from(sha256(new TextEncoder().encode(`${operationId}:${row._id}`)), b =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const cascadeOperation = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    await ctx.db.patch(row._id, { revokedAt: Date.now(), discover: false, activeUntil: 0 });
    await ctx.db.insert('secretEvents', {
      secretId: object._id,
      actor,
      operationId: cascadeOperation,
      kind: 'cascade-revoke',
      principal: row.principal,
      capabilities: [],
      cascadeFrom: principal,
      version: object.version,
      policyRevision: object.policyRevision + 1,
      at: Date.now(),
    });
  }
  return rows.map(grantSummary);
}
