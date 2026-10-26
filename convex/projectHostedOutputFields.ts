// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
export const hostedOutputTables = {
  projectHostedOutputSummaries: defineTable({
    ...identity,
    streamId: v.string(),
    position: v.number(),
    text: v.string(),
  }).index('by_project_and_run_and_stream_and_position', ['projectId', 'runId', 'streamId', 'position']),
  projectHostedOutputHeads: defineTable({
    ...identity,
    revision: v.number(),
    chain: v.string(),
    streams: v.number(),
    sealed: v.number(),
    chunks: v.number(),
    bytes: v.number(),
    final: v.union(v.string(), v.null()),
  }).index('by_project_and_run', ['projectId', 'runId']),
  projectHostedOutputStreams: defineTable({
    ...identity,
    streamId: v.string(),
    descriptor: v.string(),
    retired: v.optional(v.boolean()),
    failureExcerpt: v.optional(v.string()),
    chunks: v.number(),
    bytes: v.number(),
    maxSequence: v.number(),
    seal: v.union(v.string(), v.null()),
  })
    .index('by_project_and_run_and_stream', ['projectId', 'runId', 'streamId'])
    .index('by_project_and_run', ['projectId', 'runId']),
  projectHostedOutputChunks: defineTable({
    ...identity,
    streamId: v.string(),
    sequence: v.number(),
    revision: v.number(),
    value: v.string(),
  })
    .index('by_project_and_run_and_stream_and_sequence', ['projectId', 'runId', 'streamId', 'sequence'])
    .index('by_project_and_run_and_revision', ['projectId', 'runId', 'revision'])
    .index('by_project_and_run', ['projectId', 'runId']),
};
