// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const invitationState = v.union(
  v.literal('pending'),
  v.literal('accepted'),
  v.literal('declined'),
  v.literal('cancelled'),
  v.literal('replaced'),
  v.literal('expired'),
);
export const invitationMail = v.object({
  status: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed'), v.literal('off')),
  sends: v.number(),
  at: v.number(),
  code: v.optional(v.string()),
  resend: v.optional(v.string()),
});
export const invitationTables = {
  // Recipient-owned account preference. Never returned to an inviter or a project roster.
  invitationBlocks: defineTable({
    recipient: v.string(),
    inviter: v.string(),
    blocked: v.boolean(),
    emailHash: v.optional(v.string()),
    version: v.optional(v.number()),
    unblockOperation: v.optional(v.string()),
  })
    .index('by_recipient_and_inviter', ['recipient', 'inviter'])
    .index('by_email_and_inviter', ['emailHash', 'inviter', 'blocked']),
};
