// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { CLI_TOKEN_LIFETIME } from '../src/device-lifetime';
export const deviceScope = v.union(v.literal('cli'), v.literal('coordination'));
export const deviceSettings = v.object({
  source: v.union(v.literal('write'), v.literal('read'), v.literal('coordination')),
  projects: v.union(
    v.object({ kind: v.literal('all') }),
    // This account-owned setting retains an opaque reference; it is not project-owned data.
    v.object({ kind: v.literal('project'), projectId: v.string() }),
  ),
});
export const deviceProof = v.object({ id: v.string(), key: v.string(), at: v.number(), proof: v.string() });
export const credentialFields = {
  owner: v.string(),
  name: v.string(),
  scope: deviceScope,
  credentialId: v.string(),
  tokenHash: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  revoked: v.boolean(),
  /** Reader expansion: stable identity/settings are independent of a bearer sign-in. */
  deviceKey: v.optional(v.string()),
  deviceCode: v.optional(v.string()),
  deviceApprovedAt: v.optional(v.number()),
  deviceLastSeen: v.optional(v.number()),
  removed: v.optional(v.boolean()),
  renewal: v.optional(v.object({ operationId: v.string(), requestHash: v.string(), issuedAt: v.number() })),
  settings: v.optional(deviceSettings),
};
export const credentialDocument = v.object({
  _id: v.id('cliCredentials'),
  _creationTime: v.number(),
  ...credentialFields,
});
export const deviceFields = {
  operationId: v.string(),
  request: v.string(),
  deviceHash: v.string(),
  userHash: v.string(),
  name: v.string(),
  scope: deviceScope,
  expiresAt: v.number(),
  nextPollAt: v.number(),
  state: v.union(v.literal('pending'), v.literal('approved'), v.literal('denied'), v.literal('consumed')),
  owner: v.optional(v.string()),
  credentialId: v.string(),
  issuedAt: v.optional(v.number()),
  signInExpiresAt: v.optional(v.number()),
  redemptionId: v.optional(v.string()),
  decisionId: v.optional(v.string()),
  deviceKey: v.optional(v.string()),
};
export const deviceDocument = v.object({
  _id: v.id('deviceCodes'),
  _creationTime: v.number(),
  ...deviceFields,
});
export const deviceTables = {
  deviceCodes: defineTable(deviceFields)
    .index('by_deviceHash', ['deviceHash'])
    .index('by_userHash', ['userHash'])
    .index('by_operationId', ['operationId'])
    .index('by_expiresAt', ['expiresAt']),
  cliCredentials: defineTable(credentialFields)
    .index('by_credentialId', ['credentialId'])
    .index('by_owner', ['owner']),
  deviceAttempts: defineTable({
    owner: v.string(),
    windowAt: v.number(),
    count: v.number(),
    /** Passkey budgets retain only handles charged within their fixed global allowance. */
    handles: v.optional(v.array(v.object({ handle: v.string(), count: v.number() }))),
  }).index('by_owner', ['owner']),
};

/** Current stable sign-in generation; old bearer tokens never regain access after a re-login. */
export function currentCredential(
  row: import('./_generated/dataModel').Doc<'cliCredentials'> | null,
  owner: string,
  signIn: unknown,
): row is import('./_generated/dataModel').Doc<'cliCredentials'> {
  return Boolean(
    row &&
    row.owner === owner &&
    !row.revoked &&
    !row.removed &&
    row.expiresAt > Date.now() &&
    (!row.deviceKey ||
      (!deviceApprovalExpired(row) && typeof signIn === 'string' && row.renewal?.operationId === signIn)),
  );
}

/** Renewal uses the last sign-in end as its server-observable inactivity boundary; no heartbeat. */
export function deviceApprovalExpired(
  row: { deviceApprovedAt?: number; expiresAt: number },
  now = Date.now(),
) {
  return (
    row.deviceApprovedAt === undefined ||
    now >= deviceApprovalEnd(row) ||
    now >= row.expiresAt + 30 * 86400000
  );
}
/** One calendar-year boundary for stored credentials, signed tokens and every transport. */
function deviceApprovalEnd(row: { deviceApprovedAt?: number }) {
  const approval = new Date(row.deviceApprovedAt ?? 0);
  approval.setUTCFullYear(approval.getUTCFullYear() + 1);
  return approval.getTime();
}
export function deviceSignInExpiry(row: { deviceApprovedAt?: number }, issuedAt: number) {
  return Math.min(issuedAt + CLI_TOKEN_LIFETIME, deviceApprovalEnd(row));
}
