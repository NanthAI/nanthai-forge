// SPDX-License-Identifier: Apache-2.0
import type { DeliveryHandoff } from './agent-handoff-types.js';
import type { AutonomyPolicy } from './autonomy-policy.js';
import { z } from 'zod';
import type { Lane, WorkData, WorkView, CheckRun } from './work-types.js';
type Intent = Omit<WorkData['intents'][number], 'base' | 'status'> & { base?: string; status: string };
export const BRIEF_SITUATIONS = [
  'start-intent',
  'add-lane',
  'land-together',
  'continue-lane',
  'resolve-conflict',
  'fix-failed-check',
  'review-and-accept',
  'take-handoff',
  'answer-message',
] as const;
export const briefInputSchema = z.object({
  situation: z.enum(BRIEF_SITUATIONS),
  laneId: z.string().uuid().optional(),
  intentId: z.string().uuid().optional(),
  viewId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  agent: z.enum(['claude-code', 'codex', 'generic']).default('generic'),
});
export type BriefInput = z.infer<typeof briefInputSchema>;
export type BriefState = { parents: string[]; files: { path: string; blob: string; mode: string }[] };
export type BriefEvent = {
  id: string;
  actor: string;
  kind: 'message' | 'handoff';
  text: string;
  head?: string;
  laneId?: string;
  intentId?: string;
  paths: string[];
};
export type BriefClaim = {
  id: string;
  actor: string;
  sessionId?: string;
  paths: string[];
  laneId?: string;
  intentId?: string;
};
export type BriefRecords = {
  intents: Intent[];
  lanes: Lane[];
  views: WorkView[];
  runs: CheckRun[];
  channels: { name: string; head: string | null }[];
  events: BriefEvent[];
  claims: BriefClaim[];
};
export type BriefContext = {
  handoff?: DeliveryHandoff | null;
  parentHandoff?: DeliveryHandoff | null;
  stack?: string;
  autonomyPolicy?: AutonomyPolicy | undefined;
  handoverTaken?: boolean;
  ownership?: { actor: string; state: string; quietMs?: number | undefined } | undefined;
  intentId?: string;
  laneId?: string;
  viewId?: string;
  runId?: string;
  messageId?: string;
  intent?: Pick<Intent, 'outcome' | 'constraints' | 'notes' | 'status'>;
  siblingLanes?: (Pick<Lane, 'name' | 'head' | 'base' | 'state' | 'after'> & { laneId: string })[];
  lane?: Pick<Lane, 'name' | 'head' | 'base' | 'state' | 'after'> & { path?: string };
  view?: { status: string; head?: string; base: string; inputs?: WorkView['inputs'] };
  run?: { status: string; check: string; failureSummary: string };
  paths: string[];
  conflictPaths: string[];
  instructionFiles: string[];
  main: { head: string | null; changedPaths: string[]; merged: boolean | null };
  claims: (BriefClaim & { overlapping: string[] })[];
  messages: BriefEvent[];
  guidance: { project: string; personal: string };
  coverage: string[];
};
export type Briefing = {
  situation: BriefInput['situation'];
  title: string;
  copyText: string;
  full: string;
  context: BriefContext;
  setup: { machine: string | null; mcpConfigured: boolean; setupLine: string };
  generatedAt: string;
};
