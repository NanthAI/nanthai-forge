// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > People and teams as words (Item a841a76d): the head sentence and each team's one line, from the rows of
// convex/accountTeams.ts. Plain functions so the words are tested without a browser.
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';

export type TeamRow = FunctionReturnType<typeof api.accountTeams.list>['page'][number];
export type TeamsRead = { teams: TeamRow[]; more: boolean };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The head sentence: how many teams the person owns and is in; "at least" while more pages are unread. */
export function teamsSentence({ teams, more }: TeamsRead) {
  if (!teams.length) return more ? 'Your teams could not all be shown.' : 'No teams yet.';
  const owned = teams.filter(team => team.role === 'owner').length;
  const joined = teams.length - owned;
  const lead = more ? 'At least ' : '';
  if (!joined) return `${lead}${plural(owned, 'team')}, all yours.`;
  if (!owned) return `${lead}${plural(joined, 'team')}, owned by others.`;
  return `${lead}${plural(teams.length, 'team')}: you own ${owned.toLocaleString()}, you are in ${joined.toLocaleString()}.`;
}

/** The team's one line of context under its name. */
export function teamMeta(team: TeamRow) {
  const shown = team.members.length;
  const members = team.more ? `more than ${plural(shown, 'member')}` : plural(shown, 'member');
  return team.role === 'owner' ? `You own this team · ${members}` : `Member · ${members}`;
}
