// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const authTables = {
  /** Durable, secret-free linking receipts; written with the identity grant. */
  authLinkEvents: defineTable({
    userId: v.id('users'),
    operationId: v.string(),
    request: v.string(),
    kind: v.union(v.literal('legacy-passkey'), v.literal('github')),
    sessionId: v.string(),
    identityId: v.string(),
    at: v.number(),
  }).index('by_user_and_operation', ['userId', 'operationId']),
  users: defineTable({
    accountKey: v.string(),
    legalAcceptance: v.optional(v.object({ version: v.string(), at: v.number() })),
    passkeyNotice: v.optional(v.object({ at: v.number(), passkeyId: v.string() })),
    sessionEnd: v.optional(
      v.object({
        sessionId: v.string(),
        operationId: v.string(),
        stateHash: v.string(),
        verifiedUntil: v.number(),
        revokedCount: v.optional(v.number()),
      }),
    ),
    githubId: v.optional(v.string()),
    /** Backfill found an unresolved competing verified identity claim. */
    githubConflict: v.optional(v.boolean()),
    /** Preserve the existing provider-token path while Clerk remains configured. */
    legacyGithubProvider: v.optional(v.boolean()),
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
    legacyPasskeyFlow: v.optional(
      v.object({ operationId: v.string(), sessionId: v.string(), confirmed: v.boolean() }),
    ),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    githubToken: v.optional(
      v.object({ keyId: v.string(), nonce: v.string(), tag: v.string(), ciphertext: v.string() }),
    ),
  })
    .index('by_email', ['email'])
    .index('by_githubId', ['githubId'])
    .index('by_accountKey', ['accountKey']),
};
