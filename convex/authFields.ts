// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const authTables = {
  users: defineTable({
    accountKey: v.string(),
    githubId: v.optional(v.string()),
    githubLogin: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    githubToken: v.optional(
      v.object({ keyId: v.string(), nonce: v.string(), tag: v.string(), ciphertext: v.string() }),
    ),
  })
    .index('by_githubId', ['githubId'])
    .index('by_accountKey', ['accountKey']),
};
