// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const sessionKind = v.union(v.literal('agent'), v.literal('subagent'), v.literal('person'));
export const harness = v.union(
  v.literal('claude-code'),
  v.literal('codex'),
  v.literal('cursor'),
  v.literal('pi'),
  v.literal('other'),
);
export const sessionStructure = {
  parentSessionId: v.optional(v.string()),
  harness: v.optional(harness),
  harnessVersion: v.optional(v.string()),
};
export const activity = v.union(
  v.literal('working'),
  v.literal('waiting'),
  v.literal('observing'),
  v.literal('completed'),
);
export const context = v.object({
  intentId: v.optional(v.string()),
  laneId: v.optional(v.string()),
  head: v.optional(v.string()),
  paths: v.optional(v.array(v.string())),
  dependsOn: v.optional(v.array(v.string())),
});
/** Commands a participant may publish. Length limits live in the zod schema (new writes only). */
export const command = v.union(
  v.object({
    kind: v.literal('activity'),
    ...sessionStructure,
    sessionKind: v.optional(sessionKind),
    sessionId: v.string(),
    sequence: v.number(),
    name: v.string(),
    environment: v.string(),
    status: activity,
    summary: v.string(),
    activityAt: v.optional(v.number()),
    activityKind: v.optional(v.string()),
    context,
  }),
  v.object({
    kind: v.literal('message'),
    sessionId: v.optional(v.string()),
    recipient: v.optional(v.string()),
    text: v.string(),
    choices: v.optional(v.array(v.string())),
    context,
  }),
  v.object({
    kind: v.literal('ack'),
    sessionId: v.optional(v.string()),
    messageId: v.string(),
    choice: v.optional(v.string()),
    text: v.string(),
  }),
  v.object({
    kind: v.literal('claim'),
    sessionId: v.optional(v.string()),
    claimId: v.optional(v.string()),
    paths: v.array(v.string()),
    intentId: v.optional(v.string()),
    laneId: v.optional(v.string()),
    ttlSeconds: v.number(),
    note: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal('release'),
    sessionId: v.optional(v.string()),
    claimId: v.string(),
  }),
  v.object({
    kind: v.literal('handoff'),
    sessionId: v.optional(v.string()),
    to: v.string(),
    summary: v.string(),
    head: v.string(),
    intentId: v.optional(v.string()),
    laneId: v.optional(v.string()),
  }),
);
/** Server-emitted related-change observation; never accepted from clients. */
export const change = v.object({
  kind: v.literal('change'),
  source: v.union(v.literal('work'), v.literal('exchange'), v.literal('return')),
  action: v.optional(v.string()),
  intentId: v.optional(v.string()),
  laneId: v.optional(v.string()),
  head: v.optional(v.string()),
  paths: v.optional(v.array(v.string())),
  pathCount: v.optional(v.number()),
});
/** Lane-level detail a source return may attach to its change events. */
export const returnChange = v.object({
  intentId: v.optional(v.string()),
  laneId: v.optional(v.string()),
  head: v.optional(v.string()),
  paths: v.optional(v.array(v.string())),
  pathCount: v.optional(v.number()),
});
export const sessionFields = {
  ...sessionStructure,
  kind: v.optional(sessionKind),
  // Server-derived credential binding; never accepted from a command.
  credentialId: v.optional(v.string()),
  projectId: v.id('hostedProjects'),
  sessionId: v.string(),
  actor: v.string(),
  actorDisplayName: v.optional(v.string()),
  actorFormerMember: v.optional(v.boolean()),
  sequence: v.number(),
  name: v.string(),
  environment: v.string(),
  status: activity,
  summary: v.string(),
  context,
  lastSeen: v.number(),
  lastActivity: v.optional(v.number()),
  activityKind: v.optional(v.string()),
  operationId: v.string(),
};
export const eventFields = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  actor: v.string(),
  actorDisplayName: v.optional(v.string()),
  actorFormerMember: v.optional(v.boolean()),
  at: v.number(),
  command: v.union(command, change),
  // Denormalized for indexed inbox and scoped feeds. Rows written before these existed lack them.
  kind: v.optional(v.string()),
  recipientActor: v.optional(v.string()),
  recipientSession: v.optional(v.string()),
  intentId: v.optional(v.string()),
  laneId: v.optional(v.string()),
};
/** First acknowledgement of a message or handoff by one participant. */
export const receiptFields = {
  projectId: v.id('hostedProjects'),
  messageId: v.string(),
  actor: v.string(),
  actorDisplayName: v.optional(v.string()),
  actorFormerMember: v.optional(v.boolean()),
  sessionId: v.optional(v.string()),
  ackId: v.string(),
  choice: v.optional(v.string()),
  at: v.number(),
};
/** Advisory scope claim. Never a lock; expiry only stops it being reported as active. */
export const claimFields = {
  projectId: v.id('hostedProjects'),
  claimId: v.string(),
  actor: v.string(),
  actorDisplayName: v.optional(v.string()),
  actorFormerMember: v.optional(v.boolean()),
  sessionId: v.optional(v.string()),
  paths: v.array(v.string()),
  intentId: v.optional(v.string()),
  laneId: v.optional(v.string()),
  note: v.optional(v.string()),
  at: v.number(),
  expiresAt: v.number(),
  releasedAt: v.optional(v.number()),
};
export const sessionDocument = v.object({
  _id: v.id('projectCoordinationSessions'),
  _creationTime: v.number(),
  ...sessionFields,
});
export const eventDocument = v.object({
  _id: v.id('projectCoordinationEvents'),
  _creationTime: v.number(),
  ...eventFields,
});
export const claimDocument = v.object({
  _id: v.id('projectCoordinationClaims'),
  _creationTime: v.number(),
  ...claimFields,
});
export const coordinationTables = {
  projectCoordinationSessions: defineTable(sessionFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_parent', ['projectId', 'parentSessionId'])
    .index('by_project_and_session', ['projectId', 'sessionId'])
    .index('by_project_and_actor', ['projectId', 'actor'])
    .index('by_project_and_parent_and_lastSeen', ['projectId', 'parentSessionId', 'lastSeen'])
    .index('by_project_and_lastSeen', ['projectId', 'lastSeen']),
  projectCoordinationEvents: defineTable(eventFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_actor', ['projectId', 'actor'])
    .index('by_project_and_at', ['projectId', 'at'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_recipientActor', ['projectId', 'recipientActor'])
    .index('by_project_and_kind_and_recipientActor', ['projectId', 'kind', 'recipientActor'])
    .index('by_project_and_intentId', ['projectId', 'intentId'])
    .index('by_project_and_laneId', ['projectId', 'laneId']),
  projectCoordinationReceipts: defineTable(receiptFields)
    .index('by_project_and_message_and_actor', ['projectId', 'messageId', 'actor'])
    .index('by_project', ['projectId']),
  projectCoordinationClaims: defineTable(claimFields)
    .index('by_project_and_claim', ['projectId', 'claimId'])
    .index('by_project_and_expiresAt', ['projectId', 'expiresAt'])
    .index('by_project_and_actor_and_expiresAt', ['projectId', 'actor', 'expiresAt']),
};
