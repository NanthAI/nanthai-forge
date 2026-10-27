// SPDX-License-Identifier: Apache-2.0
import type { Brief, BriefAgent } from './brief';

/** One line of "What the agent will know": the fact, and where Forge took it from. */
export type KnowRow = { key: string; label: string; detail?: string; source: string; off?: boolean };

const files = (paths: readonly string[], shown = 2) =>
  paths.length === 0
    ? ''
    : `${paths.slice(0, shown).join(', ')}${paths.length > shown ? ` and ${paths.length - shown} more` : ''}`;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const clip = (text: string, length = 90) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** The facts the briefing carries, one short line each, always ending with what it leaves out. */
export function knowRows(brief: Pick<Brief, 'context' | 'situation'>): KnowRow[] {
  const c = brief.context;
  const rows: KnowRow[] = [];
  if (brief.situation === 'start-intent' && c.intent)
    rows.push({
      key: 'intent',
      label: 'The outcome',
      detail: clip(c.intent.outcome),
      source: 'Intent',
    });
  if (c.conflictPaths?.length)
    rows.push({
      key: 'conflict',
      label: c.conflictPaths.length === 1 ? 'The conflicting file, both versions' : 'The conflicting files',
      detail: files(c.conflictPaths),
      source: 'Lane',
    });
  if (c.run?.status === 'failed' && c.run.failureSummary)
    rows.push({
      key: 'failure',
      label: 'What failed',
      detail: clip(c.run.failureSummary.split('\n').find(line => line.trim()) ?? ''),
      source: 'check',
    });
  if (c.paths?.length && !c.conflictPaths?.length)
    rows.push({
      key: 'paths',
      label: 'What this Lane changed',
      detail: plural(c.paths.length, 'file'),
      source: 'Lane',
    });
  if (c.main?.changedPaths?.length)
    rows.push({
      key: 'main',
      label: 'What changed on main since it started',
      detail: files(c.main.changedPaths),
      source: 'main',
    });
  const overlapping = (c.claims ?? []).filter(claim => claim.overlapping.length);
  if (c.laneId || c.paths?.length)
    rows.push({
      key: 'claims',
      label: 'Who else touches these files',
      detail: overlapping.length ? plural(overlapping.length, 'other claim') : 'no one right now',
      source: 'overlaps',
    });
  if (c.messages?.length)
    rows.push({
      key: 'messages',
      label: c.messages[0]!.kind === 'handoff' ? 'The handoff note' : 'The message',
      detail: `“${clip(c.messages[0]!.text, 70)}”`,
      source: 'inbox',
    });
  if (c.instructionFiles?.length)
    rows.push({
      key: 'rules',
      label: "This repo's rules first",
      detail: files(c.instructionFiles, 3),
      source: 'repo',
    });
  const guidance = [c.guidance?.project, c.guidance?.personal].filter(Boolean).join(' · ');
  if (guidance)
    rows.push({
      key: 'guidance',
      label: 'Your guidance',
      detail: `“${clip(guidance, 70)}”`,
      source: 'Settings',
    });
  rows.push({
    key: 'off',
    label: 'Not: source outside the Lane, secrets, other projects',
    source: 'always',
    off: true,
  });
  return rows;
}

/** One sentence under the goal, only when it changes what the agent must do. */
export function goalNote(brief: Pick<Brief, 'context' | 'situation'>): string {
  const c = brief.context;
  if (brief.situation === 'resolve-conflict' && c.conflictPaths?.length)
    return `main changed ${files(c.conflictPaths, 1)} after this Lane started. The check must pass before it can be accepted.`;
  if (brief.situation === 'fix-failed-check')
    return 'The check must pass on the Lane’s latest save before it can be accepted.';
  return '';
}

/** The agent type a running session most likely is, from the tool it reports. */
export function agentOf(environment: string | undefined, harness?: string): BriefAgent {
  if (harness === 'codex' || harness === 'claude-code') return harness;
  const text = (environment ?? '').toLowerCase();
  return text.includes('codex') ? 'codex' : text.includes('claude') ? 'claude-code' : 'generic';
}
