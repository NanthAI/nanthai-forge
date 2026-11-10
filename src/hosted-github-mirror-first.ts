// SPDX-License-Identifier: Apache-2.0
import { GithubMirrorApiError, type GithubRequest } from './hosted-github-api.js';
import { gitHash, gitTree } from './hosted-github-git.js';
import { invariant } from './errors.js';

/** GitHub's Git Data API (blobs, trees, commits) answers 409 "Git Repository is empty" until a
 * repository has a commit. So the first mirror into an empty repository writes one commit with
 * one file through the Contents API, and the ordinary mirror commit on top of it publishes Forge
 * main and removes that file: two commits, no force push. Forge sources never hold `.forge/`
 * paths, so the file cannot collide with a published one. */
export const firstCommitPath = '.forge/mirror-first-commit';
const firstCommitBytes = Buffer.from(
  'GitHub cannot take a tree into an empty repository, so Forge made this commit with one file.\nThe next commit publishes Forge main and removes it.\n',
);
/** The first commit's whole tree. A GitHub main with exactly this tree is that commit (made by
 * an earlier attempt whose reply was lost, say), whoever wrote it: it holds nothing else. */
export const firstCommitTree = gitTree([
  { path: firstCommitPath, mode: 'file', sha: gitHash('blob', firstCommitBytes) },
]);

/** GitHub main's commit, or null when the repository has no commit at all (409, or a 404 with
 * no branch). A repository with other branches but no main is not empty: that 404 stands. */
export async function githubMain(repository: string, api: GithubRequest): Promise<string | null> {
  try {
    return (await api<{ object: { sha: string } }>(`/repos/${repository}/git/ref/heads/main`)).object.sha;
  } catch (error) {
    if (!(error instanceof GithubMirrorApiError) || (error.status !== 404 && error.status !== 409))
      throw error;
    if (error.status === 404 && (await api<unknown[]>(`/repos/${repository}/branches?per_page=1`)).length)
      throw error;
    return null;
  }
}

/** Creates main in an empty repository with the one-file first commit; returns its commit. */
export async function createFirstCommit(
  seed: { repository: string; at: string; identity: { name: string; email: string } },
  api: GithubRequest,
) {
  const person = { ...seed.identity, date: new Date(Date.parse(seed.at)).toISOString() };
  const reply = await api<{ commit: { sha: string; tree: { sha: string } } }>(
    `/repos/${seed.repository}/contents/${firstCommitPath}`,
    'PUT',
    {
      message:
        'Forge mirror: first commit\n\nGitHub cannot take a tree into an empty repository; the next commit publishes Forge main.',
      content: firstCommitBytes.toString('base64'),
      branch: 'main',
      author: person,
      committer: person,
    },
  );
  invariant(
    reply.commit?.tree?.sha === firstCommitTree && /^[0-9a-f]{40}$/.test(reply.commit.sha),
    'GITHUB_SYNC_HASH',
    'GitHub wrote a different first commit.',
  );
  return reply.commit.sha;
}
