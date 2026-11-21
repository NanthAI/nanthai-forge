// SPDX-License-Identifier: Apache-2.0
// Needs me › FYI as data (Item 48049998, decision b15fff49): what the reader may want to know but need not act on,
// newest first, from projectNeedsFyi:read plus the held Lanes that ask nobody (model.ts `fyi`). Two kinds of row:
// events (landings, main breaking, settings and access changes) are listed from the clear line, or from the start of
// today when the reader never cleared; state rows (held Lanes, messages) are listed while they last, and drop out
// when the state changes anywhere (web, CLI or agent). A dismissal is keyed to the row's version, so a newer version
// shows again. Nothing here holds work: approvals and questions are never FYI rows. Pure: tests/app-needs-fyi.test.mjs.
import type { StateWord } from '../../ds';
import type { NowRow } from './model';
import { whoOf } from './model';

export type FyiState = { clearedAt: number | null; clearedSequence: number | null; dismissed: string[] };
export type FyiRead = {
  owner: boolean;
  state: FyiState;
  landings: {
    receiptId: string;
    sequence: number;
    at: number;
    title: string | null;
    actor: string | null;
    agent: boolean;
    checked: boolean;
    redone: boolean;
    redoneWhy: string | null;
    /** Runner seconds thrown away by the check redone; null when not reported. */
    thrown: number | null;
    laneId: string | null;
  }[];
  landingsMore: boolean;
  broke: { sequence: number; at: number; head: string; culprit: string | null; drill: boolean }[];
  mainCheckedAt?: number;
  settings: { id: string; at: number; actor: string; areas: string[]; rule: string | null }[];
  access: {
    id: string;
    at: number;
    role: string;
    handle: string | null;
    state: string | null;
    inviter: string | null;
  }[];
  messages: {
    id: string;
    at: number;
    actor: string;
    agent: string | null;
    text: string;
    laneId: string | null;
  }[];
  messagesMore: boolean;
};

export type Area = 'code' | 'outside';
export type Link = { label: string; to: { place: string; section?: string; rest?: string } };
export type FyiRow = {
  /** `kind:id@version`: what a dismissal stores. */
  key: string;
  at: number;
  area: Area;
  /** Events are windowed by the clear line or today; state rows last while their state does. */
  event: boolean;
  word: StateWord;
  tag: string;
  title: string;
  who: string | null;
  fact: string;
  links: Link[];
};
export type Tiles = {
  landed: number;
  broke: number;
  redone: number;
  /** Runner seconds thrown away; null when some redone check did not report it. */
  thrown: number | null;
  /** True when the window reaches past the newest landings the read holds: the figures are lower bounds. */
  atLeast: boolean;
};
export type FyiView = {
  rows: FyiRow[];
  tiles: Tiles;
  /** Where the window starts and why: the reader's clear line, or the start of today. */
  since: { at: number; cleared: boolean };
  /** How many rows each filter shows. */
  counts: Record<'all' | Area, number>;
};

const AREAS: Record<string, string> = {
  acceptance: 'landing rules',
  checks: 'checks',
  lifecycle: 'Lane lifecycle',
  githubMirror: 'the GitHub mirror',
  notify: 'alerts',
  trust: 'trust',
  agentDefaults: 'agent defaults',
  autoExchange: 'automatic updates',
  autoSnapshot: 'snapshots',
  laneUpdates: 'Lane updates',
  integrationPreview: 'integration previews',
  ownerRootUpdates: 'owner updates',
  accessIdentities: 'access identities',
  checkLogs: 'check logs',
};
const areaWords = (areas: readonly string[]) => {
  const words = areas.map(area => AREAS[area] ?? area);
  return words.length > 2
    ? `${words.slice(0, 2).join(', ')} and ${words.length - 2} more`
    : words.join(' and ');
};
const RULES: Record<string, string> = {
  'owner-person': 'by the owner',
  'owner-approved': 'asked for, then approved by the owner',
  bootstrap: 'set up with the project',
  'no-gate-change': 'changed nothing that decides a landing',
  held: 'held for the owner',
};
const minutes = (seconds: number) =>
  seconds < 60 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60).toLocaleString('en')} min`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** Midnight of the reader's day, local time: the window when nothing was cleared. */
export function startOfDay(now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Held Lanes that ask nobody, as FYI rows: the version is why and since, so a new hold shows again. */
function heldRows(held: readonly NowRow[]): FyiRow[] {
  return held.map(row => ({
    key: `held:${row.landing?.submissionId ?? row.laneId}@${row.why}.${row.since}`,
    at: row.since,
    area: 'code',
    event: false,
    word: row.word,
    tag: row.tag,
    title: row.head,
    who: row.who,
    fact: [row.next ? `next: ${row.next}` : '', row.note ?? ''].filter(Boolean).join(' · '),
    links: row.laneId ? [{ label: 'Open the Lane', to: { place: 'lanes', rest: row.laneId } }] : [],
  }));
}

/** The address of one main red's view (web/src/app/red): its audit event's sequence. */
const mainRedLink = (sequence: number) => ({ place: 'code', rest: `red/${sequence}` });
/** The culprit by its landing's title when the read holds it, else by its receipt's short id. */
function culpritName(receiptId: string, titles: ReadonlyMap<string, string | null>) {
  const title = titles.get(receiptId);
  return title ? `“${title}”` : `landing ${receiptId.slice(0, 8)}`;
}

function readRows(read: FyiRead): FyiRow[] {
  const rows: FyiRow[] = [];
  for (const landing of read.landings) {
    const how = !landing.checked
      ? 'landed without a check'
      : landing.redone
        ? `checked again after main moved${landing.thrown ? `, ${minutes(landing.thrown)} of CI time thrown away` : landing.thrown === null ? ', CI time thrown away not reported' : ''}`
        : 'landed, checked';
    // Every Review and Why opens the thing it names (ae068e0c): the Lane's evidence, else this landing's receipt.
    const receipt = { place: 'code', rest: landing.receiptId };
    const review: Link = landing.laneId
      ? { label: 'Review', to: { place: 'lanes', rest: `${landing.laneId}/checked` } }
      : { label: 'Review', to: receipt };
    rows.push({
      key: `landing:${landing.receiptId}@1`,
      at: landing.at,
      area: 'code',
      event: true,
      word: landing.redone ? 'Waiting its turn' : 'Landed',
      tag: landing.redone ? 'Redone' : 'Landed',
      title: landing.title || 'A landing without a message',
      who: landing.actor ? (landing.agent ? landing.actor : whoOf(landing.actor, null)) : null,
      fact: how,
      // Why it was checked again is on its receipt ("Checked again on top of main").
      links: landing.redone ? [review, { label: 'Why', to: receipt }] : [review],
    });
  }
  const titles = new Map(read.landings.map(landing => [landing.receiptId, landing.title]));
  for (const red of read.broke)
    rows.push({
      key: `broke:${red.sequence}@1`,
      at: red.at,
      area: 'code',
      event: true,
      word: 'Check failed',
      tag: red.drill ? 'Drill' : 'Main broke',
      title: red.drill ? 'A main-break drill ran' : 'The check on main failed',
      who: null,
      fact: red.culprit ? `at ${red.head}; broken by ${culpritName(red.culprit, titles)}` : `at ${red.head}`,
      // Why opens this red (code/red/<sequence>), never the bare Code page.
      links: [{ label: 'Why', to: mainRedLink(red.sequence) }],
    });
  for (const change of read.settings)
    rows.push({
      key: `setting:${change.id}@1`,
      at: change.at,
      area: 'outside',
      event: true,
      word: 'Done',
      tag: 'Setting',
      title: `Settings changed: ${areaWords(change.areas)}`,
      who: whoOf(change.actor, null),
      fact: change.rule ? (RULES[change.rule] ?? change.rule) : '',
      links: [{ label: 'Open Settings', to: { place: 'settings' } }],
    });
  for (const invite of read.access)
    rows.push({
      key: `access:${invite.id}@${invite.state ?? 'sent'}`,
      at: invite.at,
      area: 'outside',
      event: true,
      word: invite.state === 'accepted' ? 'Done' : 'Waiting its turn',
      tag: 'Access',
      title: `${invite.handle ? `@${invite.handle.replace(/^@/, '')}` : 'Someone'} invited as ${invite.role === 'read' ? 'a reader' : 'a writer'}`,
      who: invite.inviter ? whoOf(invite.inviter, null) : null,
      fact: invite.state ? `invitation ${invite.state}` : 'invitation sent',
      links: [{ label: 'Open Settings', to: { place: 'settings' } }],
    });
  for (const message of read.messages)
    rows.push({
      key: `message:${message.id}@1`,
      at: message.at,
      area: 'code',
      event: false,
      word: 'Waiting its turn',
      tag: 'Message',
      title: message.text || 'A message without text',
      who: whoOf(message.actor, message.agent),
      fact: 'for you; it clears when its Lane lands',
      links: message.laneId ? [{ label: 'Open the Lane', to: { place: 'lanes', rest: message.laneId } }] : [],
    });
  return rows;
}

/** The FYI list as drawn: dismissed and cleared rows out, events windowed, newest first, figures for the window. */
export function fyiView(read: FyiRead, held: readonly NowRow[], now: number): FyiView {
  const cleared = read.state.clearedAt;
  const from = cleared ?? startOfDay(now);
  const hidden = new Set(read.state.dismissed);
  const rows = [...heldRows(held), ...readRows(read)]
    .filter(row => !hidden.has(row.key))
    .filter(row => (row.event ? row.at >= from : cleared === null || row.at > cleared))
    .sort((a, b) => b.at - a.at);
  const inWindow = read.landings.filter(landing => landing.at >= from);
  const redone = inWindow.filter(landing => landing.redone);
  const oldest = read.landings[read.landings.length - 1];
  return {
    rows,
    tiles: {
      landed: inWindow.length,
      broke: read.broke.filter(red => red.at >= from && !red.drill).length,
      redone: redone.length,
      thrown: redone.some(landing => landing.thrown === null)
        ? null
        : redone.reduce((sum, landing) => sum + (landing.thrown ?? 0), 0),
      atLeast: read.landingsMore && oldest !== undefined && oldest.at >= from,
    },
    since: { at: from, cleared: cleared !== null },
    counts: {
      all: rows.length,
      code: rows.filter(row => row.area === 'code').length,
      outside: rows.filter(row => row.area === 'outside').length,
    },
  };
}

/** The tiles' words: each figure with its own noun (rule 2), "or more" when the read stopped short. */
export function tileText(tiles: Tiles) {
  const more = tiles.atLeast ? '+' : '';
  return [
    { n: `${tiles.landed.toLocaleString('en')}${more}`, label: 'landed' },
    { n: tiles.broke.toLocaleString('en'), label: 'broke main' },
    {
      n: `${tiles.redone.toLocaleString('en')}${more}`,
      label: tiles.redone === 1 ? 'check redone' : 'checks redone',
    },
    {
      n: tiles.thrown === null ? 'not reported' : minutes(tiles.thrown),
      label: 'CI time thrown away',
    },
  ];
}

/** "since you cleared at 14:02" or "today": the header says which window the figures count. */
export function sinceText(since: FyiView['since'], now: number) {
  if (!since.cleared) return 'today';
  const at = new Date(since.at);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return since.at >= startOfDay(now)
    ? `since you cleared at ${time}`
    : `since you cleared on ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The summary when folded or on a phone: the answer in one line. */
export function fyiSum(view: FyiView) {
  return view.rows.length
    ? `${plural(view.tiles.landed, 'landing')}, ${plural(view.rows.length, 'row')}`
    : 'nothing new';
}
