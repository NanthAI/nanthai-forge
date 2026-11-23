// SPDX-License-Identifier: Apache-2.0
// A person can write through a linked team (Item b6588425, docs/access.md#teams), so a direct read of the
// projectContributors table sees only direct writers. Authorization and listings of who may work resolve the role
// through projectRole/hasWriteRole (convex/projectRole.ts), which adds the team lookup only after the direct grants
// miss. A module may touch the table itself only when it manages or inspects the direct grant row, and it is named
// here with the reason. A new direct caller fails this test until it uses projectRole or states why it must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../convex/', import.meta.url);

/** Modules that read or write the direct grant row on purpose. */
const direct = {
  'projectRole.ts': 'resolves every role: the direct grant is its first read, teams follow only on a miss',
  'abuseLimits.ts':
    'the daily member work budget lives on the direct row; a team writer is charged on the team row',
  'projectContributors.ts':
    'the owner manages direct grants: invite, add, remove and the direct roster; `shared` pages the person own direct grants, so a team-only project is not listed there yet',
  'projectAccess.ts':
    'People and access lists and changes direct grants (setRole compares with the direct grant, not the effective role); linked teams show beside them (projectTeamAccess)',
  'projectInvitationAnswers.ts':
    'accepting an invitation creates a direct grant, never lowered by a team role',
  'projectActorNames.ts':
    'removing a direct grant retains membership and marks the removed writer for sealed secrets, unless a linked team still gives write',
  'agentGuidance.ts':
    'agent-guidance maintainer is a flag on the direct row, set per person; a team role grants none',
  'projectSelfMetrics.ts': 'metrics reads need the same maintainer flag on the direct row',
  'projectSelfMetricBills.ts': 'metrics bills need the same maintainer flag on the direct row',
  'personWork.ts':
    'lists direct writers, then the writers of linked teams through teamWriters (convex/teamGrant.ts)',
  'accountProjectOrder.ts':
    'Account > Projects order follows the person own grant rows (direct writers and readers)',
  'accountResources.ts':
    'lists what others shared with the person: the grant rows themselves (teams have their own kind)',
  'accountExecute.ts': 'leaving a shared project removes the person own direct grant row',
  'projectRetention.ts': 'a table list for retention, with no access decision',
  'projectPurgeInventory.ts': 'a table list for purging a project, with no access decision',
};

const tableOrIndex = /'projectContributors'|\bby_project_and_contributor\b|\bby_contributor\b/;

test('only modules that manage the direct grant row read projectContributors; the rest resolve roles through projectRole', () => {
  const found = readdirSync(directory)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && file !== 'schema.ts')
    .filter(file => tableOrIndex.test(readFileSync(new URL(file, directory), 'utf8')));
  const unreviewed = found.filter(file => !(file in direct));
  assert.deepEqual(
    unreviewed,
    [],
    `${unreviewed.join(', ')} reads projectContributors directly and would miss team writers. Use projectRole or hasWriteRole (convex/projectRole.ts), or add the module to this list with the reason it must see the direct row only.`,
  );
  const stale = Object.keys(direct).filter(file => !found.includes(file));
  assert.deepEqual(
    stale,
    [],
    `${stale.join(', ')} no longer reads projectContributors; remove it from the list.`,
  );
});
