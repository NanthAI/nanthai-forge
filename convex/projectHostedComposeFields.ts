// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const identity = { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() };
export const hostedComposeTables = {
  projectHostedComposes: defineTable({
    culpritRunId: v.optional(v.string()),
    ...identity,
    jobId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_job', ['projectId', 'jobId']),
  projectHostedComposePages: defineTable({
    ...identity,
    kind: v.string(),
    index: v.number(),
    digest: v.string(),
  }).index('by_project_and_actor_and_operation_and_kind_and_index', [
    'projectId',
    'actor',
    'operationId',
    'kind',
    'index',
  ]),
  projectHostedComposeSelections: defineTable({ ...identity, kind: v.string(), key: v.string() }).index(
    'by_project_and_actor_and_operation_and_kind_and_key',
    ['projectId', 'actor', 'operationId', 'kind', 'key'],
  ),
};
