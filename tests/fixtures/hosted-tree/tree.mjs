// SPDX-License-Identifier: Apache-2.0
// The data a signed-in viewer sees with one hosted project selected. Shared by the hosted tree test
// and the review screenshots, so both exercise the same route tree.
import { hostedCockpitFixture } from '../../hosted-cockpit-fixture.mjs';

export const PROJECT = 'project-under-test';
export function hostedTree() {
  const f = hostedCockpitFixture();
  const rows = collection =>
    f.projection.entries
      .filter(row => row.collection === collection)
      .map((row, position) => ({ id: row.id ?? String(position), position, value: row.value }));
  const workspace = {
    generationId: 'g1',
    revision: 1,
    backupId: 'backup-1',
    backupDigest: 'd'.repeat(64),
    sourceHead: f.data.nativeHead,
    key: 'k',
    name: 'NanthAi Forge',
    capabilities: { owner: true, editableIntentIds: [], sourceReturn: true, hostedChannels: true },
  };
  return {
    fixture: f,
    viewer: { id: 'viewer', fullName: 'Test Viewer' },
    queries: {
      'urlProjects:resolve': () => ({ id: PROJECT, handle: 'test-viewer', slug: 'nanthai-forge', name: 'NanthAi Forge' }),
      'urlAccounts:current': () => ({ handle: 'test-viewer' }),
      'urlAccounts:available': () => null,
      'projectContributors:list': () => [],
      'projectAutonomy:read': () => ({preset:'supervised',acceptance:{mode:'review',autoActors:[],protectedPaths:[]},laneUpdates:'ask',lifecycle:{completeOnAccept:false,cleanRegenerableCopies:false},notify:{awaySummary:true}}),
      'projectWork:state': () => ({
        id: PROJECT,
        name: 'NanthAi Forge',
        owner: 'viewer',
        _creationTime: 1,
        visibility: 'private',
        work: { backupId: 'backup-1', revision: 1 },
        currentBackup: { id: 'backup-1' },
      }),
      'projectWorkIndex:workspace': () => JSON.stringify(workspace),
      'projectCoordinationReads:unacked': () => ({ items: [], complete: true }),
      'projectCoordinationReads:claims': () => ({ claims: [] }),
    },
    actions: {
      'hosted:discover': () => JSON.stringify({ page: [], isDone: true, continueCursor: '', unavailable: 0 }),
    },
    pages: {
      'projectWorkIndex:records': args => rows(args.collection),
    },
  };
}
