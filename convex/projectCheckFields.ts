// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const runnerFields = {
  projectId: v.id('hostedProjects'),
  runnerId: v.string(),
  actor: v.string(),
  name: v.string(),
  listening: v.boolean(),
  lastSeen: v.number(),
};
export const runnerDocument = v.object({
  _id: v.id('projectCheckRunners'),
  _creationTime: v.number(),
  ...runnerFields,
});
export const checkReport = v.object({
  status: v.union(
    v.literal('queued'),
    v.literal('preparing'),
    v.literal('running'),
    v.literal('passed'),
    v.literal('failed'),
    v.literal('cancelled'),
    v.literal('interrupted'),
    v.literal('runner-unavailable'),
    v.literal('runner-budget-exhausted'),
    v.literal('error'),
  ),
  runId: v.union(v.string(), v.null()),
  environmentFingerprint: v.union(v.string(), v.null()),
  startedAt: v.union(v.string(), v.null()),
  endedAt: v.union(v.string(), v.null()),
  exitCode: v.union(v.number(), v.null()),
  message: v.string(),
});
export const requestPins = {
  operationId: v.string(),
  runnerId: v.string(),
  viewId: v.string(),
  head: v.string(),
  checkId: v.string(),
  definition: v.string(),
};
export const requestFields = {
  projectId: v.id('hostedProjects'),
  ...requestPins,
  actor: v.string(),
  intentId: v.string(),
  checkName: v.string(),
  runnerName: v.string(),
  state: v.union(v.literal('queued'), v.literal('claimed'), v.literal('finished')),
  cancelRequested: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  report: v.union(checkReport, v.null()),
};
export const requestDocument = v.object({
  _id: v.id('projectCheckRequests'),
  _creationTime: v.number(),
  ...requestFields,
});
export const checkTables = {
  projectCheckRunners: defineTable(runnerFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_runner', ['projectId', 'runnerId']),
  projectCheckRequests: defineTable(requestFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_updatedAt', ['projectId', 'updatedAt'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_view', ['projectId', 'viewId'])
    .index('by_project_and_runner_and_state', ['projectId', 'runnerId', 'state'])
    .index('by_project_and_runner_and_state_and_actor', ['projectId', 'runnerId', 'state', 'actor']),
};
