// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from 'react';
import type { ConvexReactClient } from 'convex/react';
import { api as functions } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { BriefContext, Briefing, BriefInput } from '../../../src/agent-brief-types';

export type BriefSituation = BriefInput['situation'];
export type BriefAgent = BriefInput['agent'];
export type BriefRequest = Omit<BriefInput, 'agent'> & { agent: BriefAgent };
export type Brief = Pick<Briefing, 'situation' | 'title' | 'copyText' | 'full' | 'setup' | 'generatedAt'> & {
  /** Older servers sent only instruction files; every field is optional to the sheet. */
  context: Partial<BriefContext>;
};
/** Produces a briefing for the viewer's own coding agent. */
export type BriefSource = (request: BriefRequest, signal?: AbortSignal) => Promise<Brief>;

/** Hosted: the authorized `projectBriefings.brief` query, read once per request. */
export function hostedBriefs(client: ConvexReactClient, projectId: Id<'hostedProjects'>): BriefSource {
  return request =>
    client.query(functions.projectBriefings.brief, { projectId, ...request }) as Promise<Brief>;
}

export const BriefSourceContext = createContext<BriefSource | null>(null);
export const useBriefSource = () => useContext(BriefSourceContext);

const KEY = 'forge-brief-agent';
export function rememberedAgent(): BriefAgent {
  const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return value === 'codex' || value === 'generic' ? value : 'claude-code';
}
export function rememberAgent(agent: BriefAgent) {
  localStorage.setItem(KEY, agent);
}
export const agentNames: Record<BriefAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  generic: 'Other agent',
};

type Situation = Omit<BriefRequest, 'agent'>;
/** The briefing that matches a decision waiting for the viewer. */
export function decisionBrief(item: {
  kind: import('./attention').DecisionItem['kind'];
  laneId?: string;
  viewId?: string;
  messageId?: string;
}): Situation | null {
  const lane = item.laneId ? { laneId: item.laneId } : {};
  switch (item.kind) {
    case 'overlap':
      return null;
    case 'revert':
    case 'needs-fix':
      return null;
    case 'review':
      return { situation: 'review-and-accept', ...lane, ...(item.viewId ? { viewId: item.viewId } : {}) };
    case 'conflict':
      return item.laneId ? { situation: 'resolve-conflict', ...lane } : null;
    case 'failed':
      return item.laneId ? { situation: 'fix-failed-check', ...lane } : null;
    case 'handoff':
      return item.messageId ? { situation: 'take-handoff', messageId: item.messageId, ...lane } : null;
    case 'message':
      return item.messageId ? { situation: 'answer-message', messageId: item.messageId, ...lane } : null;
  }
}
/** The briefing that continues one Lane from where it stands. */
export function laneBrief(lane: { id: string; tone: string; viewId?: string }, runId?: string): Situation {
  if (lane.tone === 'conflict') return { situation: 'resolve-conflict', laneId: lane.id };
  if (lane.tone === 'failed')
    return { situation: 'fix-failed-check', laneId: lane.id, ...(runId ? { runId } : {}) };
  if (lane.tone === 'passed' && lane.viewId)
    return { situation: 'review-and-accept', laneId: lane.id, viewId: lane.viewId };
  return { situation: 'continue-lane', laneId: lane.id };
}
