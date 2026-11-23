// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { GithubMirrorApiError, type GithubRequest } from '../src/hosted-github-api';
import { pullStatusContext } from '../src/github-pull-check';
import { postPullStatus } from './projectGithubPullStatus';

export type MirrorVerification = 'pending' | 'success' | 'failure';
const descriptions: Record<MirrorVerification, string> = {
  pending: 'Forge landed this State. Main audit coverage is pending.',
  success: 'Forge verification passed.',
  failure: 'Forge main audit failed.',
};

export async function writeMirrorVerification(
  api: GithubRequest,
  repository: string,
  sha: string,
  state: MirrorVerification,
  link: string | null,
  replay: boolean,
) {
  const description = descriptions[state];
  try {
    if (replay) {
      const result = await api<{
        statuses: { context: string; state: string; description: string; target_url: string | null }[];
      }>(`/repos/${repository}/commits/${sha}/status`);
      if (
        result.statuses.some(
          status =>
            status.context === pullStatusContext &&
            status.state === state &&
            status.description === description &&
            status.target_url === link,
        )
      )
        return undefined;
    }
    await postPullStatus(api, repository, sha, state, description, link);
    return undefined;
  } catch (error) {
    if (error instanceof GithubMirrorApiError) {
      if ([401, 403].includes(error.status)) return 'GITHUB_APP_PERMISSIONS';
      if (error.status === 422) return error.code;
    }
    throw error;
  }
}
