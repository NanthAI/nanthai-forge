// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const record = { projectId: v.id('hostedProjects'), id: v.string(), request: v.string(), value: v.string() };
export const hostedFrictionTables = {
  projectHostedFriction: defineTable({ ...record, actor: v.string() }).index('by_project_and_id', [
    'projectId',
    'id',
  ]),
  projectHostedOverlapAcks: defineTable({
    ...record,
    actor: v.string(),
    laneId: v.string(),
    noticeId: v.string(),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project_and_lane_and_notice', ['projectId', 'laneId', 'noticeId']),
  projectHostedAckBatches: defineTable({ ...record, actor: v.string() }).index('by_project_and_id', [
    'projectId',
    'id',
  ]),
};
