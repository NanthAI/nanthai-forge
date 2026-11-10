// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import type { CiBranchCleanup } from './projectCiStatusLifecycle';
import { actionsToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { candidateBranch } from '../src/ci-status';
import { githubRequest, GithubMirrorApiError } from '../src/hosted-github-api';
import { invariant } from '../src/errors';

/** The existing signed webhook action performs ref IO after its verdict mutation. The mutation
 * supplies current repository scope, so this adds no Convex call, timer or idle cleanup sweep. */
export async function cleanupCiBranch(ctx: ActionCtx, input: CiBranchCleanup) {
  invariant(
    /^[a-f0-9-]{36}$/.test(input.runId) && /^[a-f0-9]{40}$/.test(input.commit),
    'EVIDENCE_CHANGED',
    'Invalid Candidate cleanup identity.',
  );
  const branch = candidateBranch(input.runId);
  const token = await actionsToken(
    ctx,
    input.projectId,
    input.repository,
    input.scope,
    convexFetch,
    Date.now(),
    { contents: 'write' },
  );
  const api = githubRequest(token, convexFetch);
  try {
    const ref = await api<{ object: { sha: string } }>(`/repos/${input.repository}/git/ref/heads/${branch}`);
    invariant(
      ref.object.sha === input.commit,
      'EVIDENCE_CHANGED',
      'The Candidate ref changed; its contents are preserved.',
    );
    await api(`/repos/${input.repository}/git/refs/heads/${branch}`, 'DELETE');
    console.log(
      `FORGE_CI_BRANCH_CLEANUP ${JSON.stringify({
        runId: input.runId,
        repository: input.repository,
        branch,
        commit: input.commit,
        undo: {
          method: 'POST',
          path: `/repos/${input.repository}/git/refs`,
          body: { ref: `refs/heads/${branch}`, sha: input.commit },
        },
      })}`,
    );
  } catch (error) {
    if (!(error instanceof GithubMirrorApiError) || error.status !== 404) throw error;
  }
}
