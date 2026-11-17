// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerBoundaryFindings } from '../scripts/check-owner-boundary.mjs';

// Reviewed device permissions. Each entry names an existing owner entry point; new ones need an
// explicit classification. Read-only metadata, reversible source/Work operations, project setup,
// decisions and metrics retain device access. Existing person gates remain in their own handlers.
const allowed = {
  accountTeams: ['list'], // Read-only: the person's own teams, members by handle; keys to the owner only.
  accountProjects: ['list'], // Read-only: the person's own and member projects with role; grants no authority.
  sealedSecrets: ['write'], // Owner unrestricted stable device; readers enforce signed-roster authority.
  agentGuidance: ['setMaintainer'],
  backupTransfer: ['prepare'],
  clientErrors: ['recent'],
  projectUncheckedLandingSettings: ['teams', 'history'], // Owner-only metadata, no source authority.
  projectUncheckedLanding: ['pickPerson'], // Read-only current-writer picker; grants no authority.
  projectAutonomy: ['set'], // Existing exact-change settings approvals.
  projectBackups: ['deletionStatus'],
  projectCheckLogCleanupStore: ['archive', 'review'],
  projectContributors: ['remove', 'list', 'handles', 'pending', 'cancelInvite'],
  projectExchangeMigration: ['migrate'],
  projectGithubMirrorRead: ['read'], // Read-only mirror sentence; the owner flag only shows controls.
  projectGithubMirrorResume: ['resume'], // Owner device recovery only; policy.set keeps Pause/un-pause person-only.
  projectGithubStatus: ['publish'],
  projectHostedAcceptance: ['approve'], // Existing acceptanceActor person gate.
  projectHostedApprovals: ['decide', 'observe'], // decide already requires a person.
  projectHostedBirth: ['makeEditable'],
  projectHostedLanes: ['head'], // Read-only source pins and opt-in member-only holder metadata; grants no authority.
  projectHostedDecisions: ['decide', 'setMaintainer'],
  projectHostedDormant: ['abandon'],
  projectHostedLandingPriority: ['prioritize'],
  projectHostedLanePin: ['setPin'],
  projectHostedLifecycleMerged: ['completeMerged'],
  projectHostedSeed: ['begin'],
  projectLifecycle: ['rename'], // A device's rename is held for the owner person (Item eb631a53); the person's applies.
  projectNeedsMe: ['read'], // Read-only: says whether the viewer may decide; decide keeps its own person gate.
  projectNeedsFyi: ['read'], // Read-only: the owner flag only hides settings and access rows from other readers.
  projectPlanSettled: ['page'], // Read-only done and dropped plan rows, one bounded page; no write.
  projectLooseEnds: ['read'], // Read-only: tells the owner the authority epoch; setting aside goes through abandon.
  projectPlanView: ['read'], // Read-only plan rows; moves and new Items go through projectWorkCommand's owner gate.
  projectProposals: ['remove'],
  publicDiscovery: ['stargazers', 'settings'], // Owner-only read-only metadata: who starred, the Lane-title opt-in.
  projectR2Backfill: ['page', 'targets'],
  projectReaders: ['list', 'shared'],
  projectSelfMetricBills: ['record', 'page'],
  projectSourceAuthority: ['transition'],
  projectWorkIndex: ['workspace', 'detail'],
  planningReactions: ['toggle'], // Reversible per-person reaction toggle, same owner gate as comments.
};
test('class guard: every public owner authority entry point has reviewed device permission or a person gate', () => {
  assert.deepEqual(ownerBoundaryFindings(new URL('../convex/', import.meta.url), allowed), []);
});
