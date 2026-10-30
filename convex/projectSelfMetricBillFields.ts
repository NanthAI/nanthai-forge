// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** One small row per owner-entered bill; corrections add rows and the newest wins. */
export const selfMetricBillTables = {
  projectSelfMetricBills: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    provider: v.string(),
    periodFrom: v.string(),
    actor: v.string(),
    at: v.string(),
    digest: v.string(),
    value: v.string(),
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_period', ['projectId', 'periodFrom']),
};
