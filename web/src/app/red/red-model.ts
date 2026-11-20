// SPDX-License-Identifier: Apache-2.0
// One main red's words (Item ae068e0c), from convex/projectMainRed.ts read. Pure: the screen renders what this returns;
// tests/app-main-red-browser.test.mjs drives it. A culprit the bisect proved is named as the landing that broke main; a
// landing that made never-passed tests run is named as that, never as the culprit; without either, the landings since
// the last green are candidates and are never called the cause.
import type { StateKind, StateWord } from '../../ds';

type RedLanding = {
  receiptId: string;
  sequence: number;
  at: number;
  title: string | null;
  actor: string | null;
  agent: boolean;
};
type RedEnd =
  | { how: 'red'; reason: string | null; tests: string[]; moreTests: number }
  | { how: 'flaky'; at: number; runId: string }
  | {
      how: 'recovered';
      at: number;
      runId: string;
      head: string;
      reverted: boolean;
      by: { kind: 'revert' | 'fix'; landing: RedLanding; of: number; more?: boolean } | null;
    }
  | { how: 'not-reported' };
export type RedRead = {
  red: {
    sequence: number;
    at: number;
    head: string;
    runId: string;
    drill: { outcome: 'recovered' | 'late' | 'flake' | null } | null;
  } | null;
  run?: {
    runId: string;
    status: string;
    files: { total: number | null; failed: number | null; flaky: number | null };
    failed: { file: string; firstError?: string }[];
    more?: { failed: number; flaky: number };
    failureReason?: string;
  } | null;
  runLink?: string | null;
  /** `audited` false: main's own record while the red is open; true: the newest audit pass before the red. */
  lastGreen?: { sequence: number; head: string; runId: string; at: number | null; audited: boolean } | null;
  landings?: RedLanding[];
  landingsMore?: boolean;
  culprit?: { receiptId: string; landing: RedLanding | null } | null;
  /** The landing that made the failing tests run: they had no pass on the last green main (Item 687d1eda). */
  newlyCoveredBy?: { receiptId: string; landing: RedLanding | null } | null;
  end?: RedEnd;
};

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
export const short = (head: string) => head.slice(0, 12);
export const titleOf = (landing: Pick<RedLanding, 'title' | 'receiptId'>) =>
  landing.title ?? `Landing ${landing.receiptId.slice(0, 8)}`;
export const whoOf = (landing: Pick<RedLanding, 'actor' | 'agent'>) =>
  landing.actor ? (landing.agent ? landing.actor : `@${landing.actor.replace(/^@/, '')}`) : null;
/** A named landing in a sentence: its title, or its short receipt when it is not on record. */
export const named = (ref: { receiptId: string; landing: RedLanding | null }) =>
  ref.landing ? `“${titleOf(ref.landing)}”` : `Landing ${ref.receiptId.slice(0, 8)}`;
/** The time, with the day when it is not today: an old red never reads as this morning's. */
export function clock(at: number, now = Date.now()) {
  const day = new Date(at);
  const time = day.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return day.toDateString() === new Date(now).toDateString()
    ? time
    : `${day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The head's state: how this red ended, as a glyph and a word. */
export function endState(read: RedRead): { word: StateWord; st: StateKind; text: string } {
  const end = read.end ?? { how: 'not-reported' };
  if (end.how === 'red') return { word: 'Check failed', st: 'failed', text: 'Still failing' };
  if (end.how === 'flaky') return { word: 'Done', st: 'stale', text: 'Counted as flaky' };
  if (end.how === 'recovered')
    return {
      word: 'Done',
      st: 'passed',
      text: end.by?.kind === 'revert' ? 'Passed after a revert' : 'Passed again',
    };
  return { word: 'Not reported', st: 'stale', text: 'Ending not reported' };
}

/** The page sentence: where main failed, and the answer to "which landing" in one line. */
export function redSentence(read: RedRead): { lead: string; rest: string } {
  const red = read.red!;
  const lead = `${read.red?.drill ? 'A drill failed main' : 'main failed'} at ${short(red.head)}, ${clock(red.at)}.`;
  const landings = read.landings ?? [];
  if (read.culprit)
    return {
      lead,
      rest: `${named(read.culprit)} broke it; the bisect proved it.`,
    };
  if (read.newlyCoveredBy)
    return {
      lead,
      rest: `${named(read.newlyCoveredBy)} made these tests run; they had no pass on the last green main.`,
    };
  // Once a red ended only audit passes are on record: a landing a full check passed later can still be listed.
  const since = read.lastGreen?.audited ? 'the last audit pass' : 'main last passed';
  if (!landings.length) return { lead, rest: `No landing since ${since} is on record.` };
  if (landings.length === 1 && !read.landingsMore)
    return { lead, rest: `One landing came since ${since}; it is the only candidate.` };
  return {
    lead,
    rest: `${plural(landings.length, 'landing')}${read.landingsMore ? ' or more' : ''} came since ${since}; which one broke it is not proven.`,
  };
}

/** How it ended, in one line. */
export function endLine(read: RedRead): string {
  const end = read.end ?? { how: 'not-reported' };
  if (end.how === 'red')
    return end.reason ? `Still failing. ${end.reason}` : 'Still failing; recovery has not decided why yet.';
  if (end.how === 'flaky')
    return `Counted as flaky at ${clock(end.at)}: the same source passed when checked again.`;
  if (end.how === 'not-reported') return 'How it ended is not reported.';
  if (!end.by) return `Passed again at ${clock(end.at)}, on ${short(end.head)}, with no landing in between.`;
  const what = `“${titleOf(end.by.landing)}”`;
  return end.by.kind === 'revert'
    ? `Passed again at ${clock(end.at)} after a revert: ${what}.`
    : end.by.of > 1
      ? `Passed again at ${clock(end.at)} with ${what}, the newest of ${plural(end.by.of, 'landing')}${end.by.more ? ' or more' : ''} since the red.`
      : `Passed again at ${clock(end.at)} with ${what}.`;
}

/** What an agent runs to read the same answer. */
export const agentCommand = (read: RedRead) => `nforge agent . status '{"main":${read.red?.sequence ?? 0}}'`;
