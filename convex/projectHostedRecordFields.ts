// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedKind = v.union(
  v.literal('intent'),
  v.literal('lane'),
  v.literal('save'),
  v.literal('candidate'),
  v.literal('job'),
);
export const hostedRef = v.object({
  kind: hostedKind,
  key: v.string(),
  version: v.number(),
  digest: v.string(),
  bytes: v.number(),
});
const identity = { projectId: v.id('hostedProjects'), kind: hostedKind, key: v.string() };
const indexed = { parent: v.string(), status: v.string(), version: v.number() };
export const hostedRecordFields = {
  ...identity,
  ...indexed,
  bodyId: v.id('projectHostedRecordBodies'),
  /** Server-written Candidate creator, independent of its check requester. */
  creatorAccountId: v.optional(v.string()),
  digest: v.string(),
  bytes: v.number(),
  lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
};
export const hostedRecordDocument = v.object({
  _id: v.id('projectHostedRecords'),
  _creationTime: v.number(),
  ...hostedRecordFields,
});
export const hostedRecordTables = {
  projectHostedRecordBodies: defineTable({ projectId: v.id('hostedProjects'), value: v.string() }).index(
    'by_project',
    ['projectId'],
  ),
  // Canonical immutable versions; the head is only a per-resource CAS pointer.
  projectHostedRecords: defineTable(hostedRecordFields)
    .index('by_project_and_kind_and_key_and_version', ['projectId', 'kind', 'key', 'version'])
    .index('by_project_and_kind_and_key_and_version_and_plan', [
      'projectId',
      'kind',
      'key',
      'version',
      'lifecyclePlanId',
    ])
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    .index('by_project', ['projectId']),
  projectHostedRecordHeads: defineTable({ ...identity, ...indexed, recordId: v.id('projectHostedRecords') })
    .index('by_project_and_kind_and_key', ['projectId', 'kind', 'key'])
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    .index('by_project_and_kind_and_status', ['projectId', 'kind', 'status'])
    .index('by_project', ['projectId']),
  projectHostedOperations: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    value: v.string(),
  }).index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId']),
};
