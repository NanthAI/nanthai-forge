// SPDX-License-Identifier: Apache-2.0
// Account > People and teams as words (Item a841a76d): the head sentence counts what is listed, says "at least" while
// more pages are unread, and each team's line says the viewer's role and how many members it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { teamsSentence, teamMeta } = await import(moduleUrl('../web/src/app/people/teams-model.ts'));
const team = (role, members = 2, more = false) => ({
  id: `${role}-${members}`,
  name: 'core',
  role,
  ownerHandle: 'sample-owner',
  members: Array.from({ length: members }, (_, i) => ({ handle: `p${i}`, you: false, owner: false })),
  more,
});

test('the head sentence counts owned and joined teams, with "at least" past the read', () => {
  assert.equal(teamsSentence({ teams: [], more: false }), 'No teams yet.');
  assert.equal(teamsSentence({ teams: [team('owner')], more: false }), '1 team, all yours.');
  assert.equal(
    teamsSentence({ teams: [team('member'), team('member', 3)], more: false }),
    '2 teams, owned by others.',
  );
  assert.equal(
    teamsSentence({ teams: [team('owner'), team('member')], more: true }),
    'At least 2 teams: you own 1, you are in 1.',
  );
});

test("each team's line names the viewer's role and its member count", () => {
  assert.equal(teamMeta(team('owner', 1)), 'You own this team · 1 member');
  assert.equal(teamMeta(team('member', 12, true)), 'Member · more than 12 members');
});
