// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDeleteRequest, parseDeleteProjects } from '../dist/host-delete-projects.js';

test('bulk delete prepares from a glob, explicit ids or the trash', () => {
  for (const [flags, select] of [
    [['scratch-*'], { glob: 'scratch-*' }],
    [['--ids', 'project-one,project-two'], { ids: ['project-one', 'project-two'] }],
    [['--trash'], { trash: true }],
  ])
    assert.deepEqual(parseDeleteProjects(['--delete-projects', ...flags]), { kind: 'prepare', select });
});

test('the terminal receipt identifies each frozen project, the approval link and the original deployment', () => {
  const deployment = 'https://scratch.convex.cloud';
  const url = 'https://forge.example/account?request=sample';
  const receipt = formatDeleteRequest(
    {
      id: 'sample',
      status: 'requested',
      at: '2026-11-18T00:00:00Z',
      expiresAt: '2026-11-18T00:30:00Z',
      projects: [{ projectId: 'project-one', slug: 'scratch-one', revision: 7, bytes: 2048, trash: true }],
      url,
    },
    'scratch checkout',
    deployment,
  );
  assert.match(receipt, /scratch-one {2}project-one {2}revision 7 {2}in the trash {2}2 KB/);
  assert.equal(receipt.split(url).length, 2);
  assert.match(receipt, /--deployment 'https:\/\/scratch\.convex\.cloud' --wait sample/);
});
