// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
const mirror = await import(moduleUrl('../convex/projectGithubMirrorRead.ts'));
export function mirrorControlsFixture(inbound = true, repository = 'example/repo') {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: repository, autoPush: true, laneRefs: false, inbound },
    },
  });
  const bound = {
    projectId,
    repoId: 42,
    fullName: repository,
    installationId: 9,
    boundBy: 'owner',
    boundAt: 1,
  };
  const bindingId = f.insert('projectGithubBindings', bound);
  const mirrorId = f.insert('projectGithubMirrors', {
    projectId,
    repository: repository,
    repositoryKey: repository,
    activeId: null,
    mapping: null,
  });
  const read = (actor = 'owner') => f.call('mirror', mirror.read, { projectId }, actor);
  const change = autoPush => ({
    projectId,
    command: JSON.stringify({
      action: 'set-policy',
      operationId: randomUUID(),
      githubMirror: { repo: repository, autoPush, inbound: autoPush && inbound, laneRefs: false },
    }),
  });
  return { ...f, projectId, bindingId, mirrorId, bound, read, change };
}
