// SPDX-License-Identifier: Apache-2.0
import { deliveryHandoff } from './agentHandoffFields';
import { autonomyPolicy } from './autonomyFields';
import { v } from 'convex/values';
import { defineTable } from 'convex/server';
import { BRIEF_SITUATIONS } from '../src/agent-brief-types';
export const briefArgs = {
  situation: v.union(...BRIEF_SITUATIONS.map(s => v.literal(s))),
  laneId: v.optional(v.string()),
  intentId: v.optional(v.string()),
  viewId: v.optional(v.string()),
  runId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  agent: v.optional(v.union(v.literal('claude-code'), v.literal('codex'), v.literal('generic'))),
};
const event = v.object({
  id: v.string(),
  actor: v.string(),
  kind: v.union(v.literal('message'), v.literal('handoff')),
  text: v.string(),
  head: v.optional(v.string()),
  laneId: v.optional(v.string()),
  intentId: v.optional(v.string()),
  paths: v.array(v.string()),
});
const claim = {
  id: v.string(),
  actor: v.string(),
  sessionId: v.optional(v.string()),
  paths: v.array(v.string()),
  laneId: v.optional(v.string()),
  intentId: v.optional(v.string()),
};
const after = v.optional(v.union(v.object({ intentId: v.string() }), v.object({ viewId: v.string() })));
const laneContext = { name: v.string(), head: v.string(), base: v.string(), state: v.string(), after };
export const briefingResult = v.object({
  situation: briefArgs.situation,
  title: v.string(),
  copyText: v.string(),
  full: v.string(),
  generatedAt: v.string(),
  setup: v.object({
    machine: v.union(v.string(), v.null()),
    mcpConfigured: v.boolean(),
    setupLine: v.string(),
  }),
  context: v.object({
    handoff: v.optional(v.union(deliveryHandoff, v.null())),
    autonomyPolicy: v.optional(autonomyPolicy),
    laneId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    viewId: v.optional(v.string()),
    runId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    intent: v.optional(
      v.object({
        outcome: v.string(),
        constraints: v.string(),
        status: v.string(),
        notes: v.array(v.object({ kind: v.string(), text: v.string(), at: v.string() })),
      }),
    ),
    lane: v.optional(v.object(laneContext)),
    siblingLanes: v.optional(v.array(v.object({ laneId: v.string(), ...laneContext }))),
    view: v.optional(
      v.object({
        status: v.string(),
        head: v.optional(v.string()),
        base: v.string(),
        inputs: v.optional(v.array(v.object({ laneId: v.string(), head: v.string() }))),
      }),
    ),
    run: v.optional(v.object({ status: v.string(), check: v.string(), failureSummary: v.string() })),
    paths: v.array(v.string()),
    conflictPaths: v.array(v.string()),
    instructionFiles: v.array(v.string()),
    main: v.object({
      head: v.union(v.string(), v.null()),
      changedPaths: v.array(v.string()),
      merged: v.union(v.boolean(), v.null()),
    }),
    guidance: v.object({ project: v.string(), personal: v.string() }),
    coverage: v.array(v.string()),
    claims: v.array(v.object({ ...claim, overlapping: v.array(v.string()) })),
    messages: v.array(event),
  }),
});
export const briefTables = {
  agentGuidanceMaintainerOperations: defineTable({
    owner: v.string(),
    operationId: v.string(),
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    maintainer: v.boolean(),
  })
    .index('by_owner_and_operationId', ['owner', 'operationId'])
    .index('by_project', ['projectId']),
  agentUserSettings: defineTable({ actor: v.string(), agentGuidance: v.string() }).index('by_actor', [
    'actor',
  ]),
  agentGuidanceOperations: defineTable({
    actor: v.string(),
    operationId: v.string(),
    projectId: v.optional(v.id('hostedProjects')),
    scope: v.union(v.literal('project'), v.literal('personal')),
    agentGuidance: v.string(),
  })
    .index('by_actor_and_operationId', ['actor', 'operationId'])
    .index('by_project_and_scope', ['projectId', 'scope']),
  projectBriefingSources: defineTable({
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    head: v.string(),
    part: v.number(),
    value: v.string(),
  }).index('by_projectId_and_backupId_and_head_and_part', ['projectId', 'backupId', 'head', 'part']),
};
