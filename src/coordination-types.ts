// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { PRESENCE } from './presence.js';

/** Limits apply to new writes only; stored rows are never re-validated against them. */
export const COORDINATION_LIMITS = {
  id: 200,
  name: 120,
  summary: 2000,
  text: 4000,
  choice: 120,
  choices: 3,
  note: 500,
  path: 500,
  paths: 100,
  dependsOn: 50,
  pageSize: 100,
  changePaths: 50,
  minTtlSeconds: 60,
  maxTtlSeconds: 86_400,
} as const;
/** Heartbeat: clients touch about every 30 s; the server skips touches under 20 s apart. */
export const COORDINATION_TOUCH_INTERVAL_MS = 30_000;
export const COORDINATION_TOUCH_MIN_MS = 20_000;
/** Working activity window; older sessions become quiet, without ending their work. */
export const COORDINATION_STALE_MS = PRESENCE.workingMs;
/** Lane activity is an observed save, check or claim within the last 15 minutes. */
export const COORDINATION_LANE_ACTIVE_MS = PRESENCE.workingMs;
export const coordinationSessionKindSchema = z.enum(['agent', 'subagent', 'person']);
export const coordinationHarnessSchema = z.enum(['claude-code', 'codex', 'cursor', 'pi', 'other']);
export type CoordinationSessionKind = z.infer<typeof coordinationSessionKindSchema>;
export type CoordinationHarness = z.infer<typeof coordinationHarnessSchema>;

const L = COORDINATION_LIMITS;
const ref = z.string().min(1).max(L.id);
const path = z.string().min(1).max(L.path);
export const coordinationPathsSchema = z.array(path).max(L.paths);
const sessionId = z.string().uuid();
export const coordinationChoicesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(L.choice)
      .refine(value => value.trim().length > 0, 'Use a nonblank choice.'),
  )
  .min(2)
  .max(L.choices)
  .refine(values => new Set(values).size === values.length, 'Use distinct answer choices.');
const choice = z.string().min(1).max(L.choice).optional();
export const coordinationContextSchema = z
  .object({
    intentId: ref.optional(),
    laneId: ref.optional(),
    head: ref.optional(),
    paths: coordinationPathsSchema.optional(),
    dependsOn: z.array(ref).max(L.dependsOn).optional(),
  })
  .strict();
export const coordinationCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('activity'),
      sessionId,
      sequence: z.number().int().positive(),
      parentSessionId: sessionId.optional(),
      sessionKind: coordinationSessionKindSchema.optional(),
      harness: coordinationHarnessSchema.optional(),
      harnessVersion: z.string().min(1).max(L.name).optional(),
      name: z.string().min(1).max(L.name),
      environment: z.string().min(1).max(L.name),
      status: z.enum(['working', 'waiting', 'observing', 'completed']),
      summary: z.string().max(L.summary),
      activityAt: z.number().finite().nonnegative().optional(),
      activityKind: z.string().max(L.name).optional(),
      context: coordinationContextSchema.default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      sessionId: sessionId.optional(),
      /** A session UUID or a participant (account subject) in this project. */
      recipient: ref.optional(),
      text: z.string().min(1).max(L.text),
      choices: coordinationChoicesSchema.optional(),
      context: coordinationContextSchema.default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ack'),
      sessionId: sessionId.optional(),
      messageId: z.string().uuid(),
      choice,
      text: z.string().max(L.summary),
    })
    .strict(),
  z
    .object({
      kind: z.literal('claim'),
      sessionId: sessionId.optional(),
      /** Renew or replace one of your own active claims; omit for a new claim. */
      claimId: z.string().uuid().optional(),
      paths: coordinationPathsSchema.min(1),
      intentId: ref.optional(),
      laneId: ref.optional(),
      ttlSeconds: z.number().int().min(L.minTtlSeconds).max(L.maxTtlSeconds),
      note: z.string().max(L.note).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('release'),
      sessionId: sessionId.optional(),
      claimId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('handoff'),
      sessionId: sessionId.optional(),
      /** A session UUID or a participant (account subject) in this project. */
      to: ref,
      summary: z.string().min(1).max(L.summary),
      /** The exact source pin being handed over. */
      head: ref,
      intentId: ref.optional(),
      laneId: ref.optional(),
    })
    .strict(),
]);
export type CoordinationCommand = z.infer<typeof coordinationCommandSchema>;
/** Server-emitted only; clients cannot publish it. */
export type CoordinationChange = {
  kind: 'change';
  source: 'work' | 'exchange' | 'return';
  action?: string;
  intentId?: string;
  laneId?: string;
  head?: string;
  paths?: string[];
  pathCount?: number;
};
export type StoredCoordinationCommand = CoordinationCommand | CoordinationChange;

const page = {
  cursor: z.string().max(4096).nullable().default(null),
  pageSize: z.number().int().positive().max(L.pageSize).default(50),
};
const scope = {
  sessionId: sessionId.optional(),
  intentIds: z.array(ref).max(20).optional(),
  laneIds: z.array(ref).max(20).optional(),
  paths: coordinationPathsSchema.optional(),
  includeMine: z.boolean().optional(),
};
const operationId = z.string().uuid().optional();
const write = { operationId, sessionId: sessionId.optional() };
export const coordinationRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('watch'),
      ...page,
      waitMs: z.number().int().min(0).max(60000).default(30000),
      related: z.boolean().optional(),
      ...scope,
    })
    .strict(),
  z
    .object({
      action: z.literal('publish'),
      operationId: z.string().uuid(),
      command: coordinationCommandSchema,
    })
    .strict(),
  z.object({ action: z.literal('feed'), ...page, intentId: ref.optional(), laneId: ref.optional() }).strict(),
  z
    .object({
      action: z.literal('sessions'),
      ...page,
      parentSessionId: z.string().optional(),
      all: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal('recent'), ...page }).strict(),
  z.object({ action: z.literal('counts') }).strict(),
  z
    .object({ action: z.literal('touch'), sessionId, activityKind: z.string().max(L.name).optional() })
    .strict(),
  z.object({ action: z.literal('inbox'), ...page, sessionId: sessionId.optional() }).strict(),
  z
    .object({
      action: z.literal('unacked'),
      sessionId: sessionId.optional(),
      limit: z.number().int().positive().max(L.pageSize).default(50),
    })
    .strict(),
  z.object({ action: z.literal('related'), ...page, ...scope }).strict(),
  z.object({ action: z.literal('claims') }).strict(),
  z
    .object({
      action: z.literal('overlaps'),
      paths: coordinationPathsSchema.min(1),
      includeMine: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('message'),
      ...write,
      to: ref.optional(),
      text: z.string().min(1).max(L.text),
      choices: coordinationChoicesSchema.optional(),
      intentId: ref.optional(),
      laneId: ref.optional(),
      paths: coordinationPathsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('handoff'),
      ...write,
      to: ref,
      summary: z.string().min(1).max(L.summary),
      head: ref,
      intentId: ref.optional(),
      laneId: ref.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('ack'),
      ...write,
      messageId: z.string().uuid(),
      choice,
      text: z.string().max(L.summary).default('Acknowledged'),
    })
    .strict(),
  z
    .object({
      action: z.literal('claim'),
      ...write,
      claimId: z.string().uuid().optional(),
      paths: coordinationPathsSchema.min(1),
      intentId: ref.optional(),
      laneId: ref.optional(),
      ttlMinutes: z.number().int().min(1).max(1440).default(60),
      note: z.string().max(L.note).optional(),
    })
    .strict(),
  z.object({ action: z.literal('release'), ...write, claimId: z.string().uuid() }).strict(),
]);
export type CoordinationRequest = z.infer<typeof coordinationRequestSchema>;
