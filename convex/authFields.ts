// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const authTables = {
  /** Durable, secret-free linking receipts; written with the identity grant. */
  authLinkEvents: defineTable({
    userId: v.id('users'),
    operationId: v.string(),
    request: v.string(),
    kind: v.union(v.literal('legacy-passkey'), v.literal('github'), v.literal('device')),
    /** Browser session, or (kind device) the device sign-in operation reference. */
    sessionId: v.string(),
    identityId: v.string(),
    at: v.number(),
  }).index('by_user_and_operation', ['userId', 'operationId']),
  users: defineTable({
    accountKey: v.string(),
    legalAcceptance: v.optional(v.object({ version: v.string(), at: v.number() })),
    passkeyNotice: v.optional(v.object({ at: v.number(), passkeyId: v.string() })),
    deviceNotice: v.optional(v.object({ at: v.number(), credentialId: v.string(), signInId: v.string() })),
    deviceApprovalProof: v.optional(v.object({ sessionId: v.string(), verifiedUntil: v.number() })),
    /** CLI device sign-out epoch: each "sign out everywhere" start moves it on (convex/deviceEndAll.ts). */
    deviceSignOutEpoch: v.optional(v.number()),
    /** The latest "Sign out everywhere" with devices: its issuing browser session and the epoch it moved to. Only a
     * device approval in that session clears the sweep's sealed marks (convex/sealedSecretMarkers.ts). */
    sealedSweep: v.optional(v.object({ sessionId: v.string(), epoch: v.number(), until: v.number() })),
    sessionEnd: v.optional(
      v.object({
        sessionId: v.string(),
        operationId: v.string(),
        stateHash: v.string(),
        verifiedUntil: v.number(),
        revokedCount: v.optional(v.number()),
        includeDevices: v.optional(v.boolean()),
        purpose: v.optional(v.literal('device')),
      }),
    ),
    githubId: v.optional(v.string()),
    /** Backfill found an unresolved competing verified identity claim. */
    githubConflict: v.optional(v.boolean()),
    githubLogin: v.optional(v.string()),
    /** One current linking proof/request and successful legacy ceremony receipt per user. */
    githubLink: v.optional(
      v.object({
        sessionId: v.string(),
        verifiedUntil: v.number(),
        confirmed: v.boolean(),
        stateHash: v.optional(v.string()),
      }),
    ),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    /** When a provider last confirmed `email` (a GitHub sign-in or link). Missing on older rows,
     * which count from their creation. Recipient lookup ignores an older address (16723708). */
    emailConfirmedAt: v.optional(v.number()),
    githubToken: v.optional(
      v.object({ keyId: v.string(), nonce: v.string(), tag: v.string(), ciphertext: v.string() }),
    ),
    /** Present when the GitHub App issues expiring user tokens: the sealed refresh token and when the
     * access token expires. Forge renews on first use after expiry, never on a timer. */
    githubTokenRenewal: v.optional(
      v.object({
        refreshToken: v.object({
          keyId: v.string(),
          nonce: v.string(),
          tag: v.string(),
          ciphertext: v.string(),
        }),
        expiresAt: v.number(),
      }),
    ),
  })
    .index('by_email', ['email'])
    .index('by_githubId', ['githubId'])
    .index('by_accountKey', ['accountKey']),
};
