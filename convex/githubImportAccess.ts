// SPDX-License-Identifier: Apache-2.0
'use node';
import { authorizeGithub } from '../src/github-access';
import { ForgeError } from '../src/errors';
import { networkFetch } from '../src/network-fetch';
import { appInstallation, metadataProbeToken } from './githubAppToken';
import { githubConfig } from './access';

/** Healthy access uses its existing requests. A shared public metadata quota must
 * not prevent reaching the installed App's separate quota. The rescue token has
 * metadata read only on this one repository; authorizeGithub still requires the
 * importer's current user credential for a private repository. */
export async function authorizeImportGithub(
  repository: string,
  owner: string,
  request: typeof fetch = networkFetch,
) {
  const config = githubConfig();
  try {
    return await authorizeGithub(repository, owner, config, request);
  } catch (error) {
    if (
      !(error instanceof ForgeError) ||
      error.code !== 'GITHUB_RATE_LIMIT' ||
      !process.env.GITHUB_APP_ID ||
      !process.env.GITHUB_APP_PRIVATE_KEY
    )
      throw error;
    let token: string;
    try {
      const { api, installation } = await appInstallation(repository, request, Date.now());
      token = await metadataProbeToken(api, installation.id, repository);
    } catch {
      // Preserve the original provider reset when the optional App route is unavailable.
      throw error;
    }
    return authorizeGithub(repository, owner, { ...config, publicToken: token }, request);
  }
}
