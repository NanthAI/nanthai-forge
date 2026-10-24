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
      (child && !row.capabilities.includes('delegate'))
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
