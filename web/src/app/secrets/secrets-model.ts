// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Secrets page's view (Item 41a0df87, slice 4): names, kinds, versions, handles, codes and counts from
// sealedSecrets:overview, and the words and commands built from them. Nothing here holds, fetches or subscribes to a
// value, a ciphertext or a key: the page reads names only, one-shot, and changes nothing. Every action is a command a
// person copies and runs on a terminal.
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';
import { checksSetCommand } from '../../../../src/secret-names';

export type Overview = Extract<FunctionReturnType<typeof api.sealedSecrets.overview>, { status: 'ok' }>;
export type OverviewSet = Overview['sets'][number];
export type SetKind = OverviewSet['kind'];
export type SecretsView =
  | { status: 'loading' }
  | { status: 'reader' }
  | { status: 'failed'; previous?: Overview; lastShown?: number }
  | { status: 'ready'; data: Overview; shownAt: number };

export const setLabel = (kind: SetKind) =>
  kind === 1 ? 'Development' : kind === 2 ? 'Checks' : 'Production';
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Names are ASCII today (safeSecretName); anything else is quoted as one shell argument and never run. */
const shellWord = (value: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** The command that sets `name` in the set it was listed under: Development is the CLI's default, Checks needs
 * `--set checks` (so a Checks row can never overwrite the Development value of the same name), and Production has no
 * CLI selector, so it gets no command at all (null). `kind` is the value's kind (2 is a file). */
export const setCommand = (name: string, kind: 1 | 2 | 3, set: SetKind = 1) =>
  set === 3
    ? null
    : `${set === 2 ? checksSetCommand(shellWord(name)) : `nforge secret set ${shellWord(name)}`}${kind === 2 ? ' --file' : ''}`;
export const applyCommand = (id: string) => `nforge secret apply ${shellWord(id)}`;
export const rejectCommand = (id: string) => `nforge secret reject ${shellWord(id)}`;
export const UNSHARE_MARKED = 'nforge secret unshare --marked';
export const LIST_COMMAND = 'nforge secret list';

const MIN = 60_000;
/** "just now", "12 min ago", "2 h ago", "yesterday", "3 d ago": relative, with the exact time on hover. */
export function relative(at: number, now: number) {
  const ms = Math.max(0, now - at);
  if (ms < MIN) return 'just now';
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < 24 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))} h ago`;
  const days = Math.floor(ms / (24 * 60 * MIN));
  return days === 1 ? 'yesterday' : `${days} d ago`;
}
export const exact = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
export const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const OPERATION = { 1: 'add', 2: 'change', 3: 'remove' } as const;
export const KIND_WORD = { 1: 'env', 2: 'file', 3: 'removal' } as const;

/** What waits on a person, in the order the page draws it. The total is the number of rows, and equals the counter
 * on the project row (convex/sealedSecretNeeds.ts). */
export function needsOf(data: Overview) {
  const takeOut = data.sets.flatMap(set => (set.takeOut ?? []).map(row => ({ ...row, set: set.kind })));
  const rotate = data.sets.flatMap(set => (set.rotate?.page ?? []).map(row => ({ ...row, set: set.kind })));
  const rotateTotal = data.sets.reduce((n, set) => n + (set.rotate?.total ?? 0), 0);
  const proposals = data.sets.flatMap(set => (set.proposals ?? []).map(row => ({ ...row, set: set.kind })));
  return { takeOut, rotate, rotateTotal, proposals, total: takeOut.length + rotateTotal + proposals.length };
}

export const nameTotal = (data: Overview) => data.sets.reduce((n, set) => n + (set.names?.total ?? 0), 0);

/** The one sentence under the title: the first of these that is true (README "Copy"). */
export function sentence(data: Overview, missingChecks = false) {
  const needs = needsOf(data),
    names = nameTotal(data);
  const who =
    needs.takeOut.find(row => row.left && row.handle)?.handle ??
    needs.rotate.flatMap(row => row.devices).find(device => device.handle)?.handle ??
    null;
  const waiting = needs.proposals.length
    ? ` ${count(needs.proposals.length, 'proposal waits', 'proposals wait')} for a person.`
    : '';
  if (needs.rotateTotal)
    return {
      lead: `${count(needs.rotateTotal, 'secret needs', 'secrets need')} a new value`,
      rest: `${who ? ` after @${who} left.` : ' after a computer was removed.'}${waiting}`,
    };
  if (needs.proposals.length)
    return {
      lead: `${count(needs.proposals.length, 'proposal waits', 'proposals wait')} for a person.`,
      rest: names ? ` ${count(names, 'secret')} in ${count(data.sets.length, 'set')}.` : '',
    };
  if (needs.takeOut.length) {
    const computers = needs.takeOut.reduce((n, row) => n + row.codes.length, 0);
    return {
      lead: `${count(computers, 'removed computer still holds', 'removed computers still hold')} ${setLabel(needs.takeOut[0]!.set)}.`,
      rest: ' Take it out in a terminal.',
    };
  }
  if (!names) return { lead: 'This project has no secrets yet.', rest: '' };
  return {
    lead: `${count(names, 'secret')} in ${count(data.sets.length, 'set')}.`,
    rest: missingChecks ? '' : ' Nothing needs you.',
  };
}

/** What `nforge secret list` prints, drawn from the names this page holds (names and kinds only). */
export function listOutput(data: Overview) {
  const lines = [`$ ${LIST_COMMAND}`];
  const rotating = new Set<string>();
  for (const set of data.sets) {
    for (const row of set.rotate?.page ?? []) rotating.add(row.name);
    for (const row of (set.names?.page ?? []).slice(0, 5))
      lines.push(`${row.name}\t${row.kind === 2 ? 'file' : 'env'}\tv${row.version}`);
    if ((set.names?.total ?? 0) > 5) lines.push('…');
  }
  if (rotating.size)
    lines.push(`To rotate (a removed computer could open these): ${[...rotating].slice(0, 12).join(', ')}`);
  return lines.join('\n');
}

/** True for a refusal that says this person can no longer read the project's secrets (a lost grant, a signed-out or
 * revoked sign-in, a project that is gone). Such a refusal clears the page's rows; any other failure keeps them. */
export const accessDenied = (code: string | undefined) =>
  code !== undefined && (code.startsWith('AUTH_') || code === 'PROJECT_UNAVAILABLE');

/** What a "Show the next" reply does to the snapshot that asked for it. A reader reply is an access denial and
 * clears the page. A page of a set whose head or total moved on (someone rotated, joined or removed meanwhile) is
 * never appended to the old rows: the page reads the whole overview again. Otherwise the page is appended. */
export function appendPage(
  data: Overview,
  kind: SetKind,
  part: 'names' | 'people' | 'rotate',
  reply: { status: 'reader' } | { status: 'ok'; sets: readonly Partial<OverviewSet>[] },
): { to: 'reader' } | { to: 'again' } | { to: 'ready'; data: Overview } {
  if (reply.status === 'reader') return { to: 'reader' };
  const asked = data.sets.find(s => s.kind === kind);
  const got = reply.sets[0];
  const page = got?.[part];
  if (!asked || !got || !page || got.kind !== kind || got.headVersion !== asked.headVersion)
    return { to: 'again' };
  if (page.total !== asked[part]?.total) return { to: 'again' };
  return {
    to: 'ready',
    data: {
      ...data,
      sets: data.sets.map(s =>
        s.kind === kind
          ? ({ ...s, [part]: { ...page, page: [...(s[part]?.page ?? []), ...page.page] } } as typeof s)
          : s,
      ),
    },
  };
}
