// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  /** Scoped grant (df06081d): writes only to these folders (`dir/`) or files of the selected project. */
  paths: v.optional(v.array(v.string())),
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
  /** Clock of a scoped grant (settings.paths): granted at, last renewed by a write. Expiry is computed at check time. */
  grant: v.optional(v.object({ at: v.number(), usedAt: v.number() })),
  /** The account sign-out epoch this sign-in was issued in; "sign out everywhere" ends every one below its own. */
  signOutEpoch: v.optional(v.number()),
  /** Gate B2 M3: the sealed device ids this sign-in wrote or joined as, per project (at most 100). Ending the sign-in
   * from elsewhere marks them there (convex/sealedSecretMarkers.ts). Absent when it never used sealed secrets. */
  // An account-owned opaque project reference, like `settings.projects.projectId`: not project-owned data.
  sealed: v.optional(v.array(v.object({ projectId: v.string(), deviceId: v.bytes() }))),
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
  /** The account sign-out epoch at approval; the credential issued from this code records it. */
  signOutEpoch: v.optional(v.number()),
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
    /** Account limiter rows (`limit:<channel>:<shard>:<subject>`, convex/accountLimits.ts) cache the tier for the day. */
    established: v.optional(v.boolean()),
    /** Passkey budgets retain only handles charged within their fixed global allowance. */
    handles: v.optional(v.array(v.object({ handle: v.string(), count: v.number() }))),
    /** Per-visitor rows (convex/visitorBudget.ts): the device minute window, and when the row may be removed. */
    minuteAt: v.optional(v.number()),
    minuteCount: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index('by_owner', ['owner'])
    .index('by_expiresAt', ['expiresAt']),
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
