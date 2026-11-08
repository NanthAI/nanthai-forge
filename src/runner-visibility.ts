// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the CLI and in the Convex non-Node runtime.
import { invariant } from './errors.js';
/** A runner repository's GitHub visibility. `internal` repositories are readable
 * by a whole enterprise, so only `private` keeps a private project's logs private. */
export type RepositoryVisibility = 'public' | 'private' | 'internal' | 'unknown';
/** How long one GitHub visibility read is reused for dispatch. The OIDC session
 * check is fresh on every runner call, so a repository made public inside this
 * window is still refused before any source is sent. */
export const runnerVisibilityTtlMs = 5 * 60_000;
export const runnerPublicCode = 'RUNNER_REPOSITORY_PUBLIC';
/** GitHub repository JSON: `visibility` when present, else the `private` flag. */
export function repositoryVisibility(body: unknown): RepositoryVisibility {
  const { visibility, private: hidden } = (body ?? {}) as { visibility?: unknown; private?: unknown };
  if (visibility === 'public' || visibility === 'private' || visibility === 'internal') return visibility;
  if (typeof hidden === 'boolean') return hidden ? 'private' : 'public';
  return 'unknown';
}
/** The plain notice every receipt and runner view shows once the owner accepted public logs. */
export const publicLogsNotice = (repository: string | undefined) =>
  `Check logs are public: this runner runs in ${repository ?? 'its runner repository'}, whose GitHub Actions logs, test names, paths and printed output anyone who can see that repository can read (the project owner set publicLogs:true).`;
/** The receipt field for a runner configuration: the notice, or nothing. */
export function checkLogsField(
  configuration: { publicLogs?: unknown; repository?: unknown } | null | undefined,
) {
  return configuration?.publicLogs === true
    ? {
        checkLogs: publicLogsNotice(
          typeof configuration.repository === 'string' ? configuration.repository : undefined,
        ),
      }
    : {};
}
export function runnerPublicReason(repository: string, visibility: string | undefined) {
  return (
    `Runner repository ${repository} is ${visibility && visibility !== 'unknown' ? visibility : 'not proven private'}, ` +
    'but this project is private: Actions logs, test names, paths and printed output there are readable outside ' +
    'the project. No source was sent. Fix one of two ways: connect a private runner repository with ' +
    `nforge agent ROOT configure-runner '{"provider":"github-actions","repository":"OWNER/PRIVATE_REPO"}', ` +
    'or, as the project owner, accept public check logs for this runner with ' +
    `nforge agent ROOT configure-runner '{"provider":"github-actions","repository":"${repository}","publicLogs":true}'.`
  );
}
/** Projects without an explicit `public` visibility are private, as everywhere else. */
export const privateProject = (visibility: string | undefined) => visibility !== 'public';
/** Refuses a private project's checks in any runner repository not proven private,
 * unless the project owner accepted public check logs on this runner. */
export function requirePrivateRunner(
  projectVisibility: string | undefined,
  repository: string,
  visibility: string | undefined,
  publicLogs = false,
) {
  if (!privateProject(projectVisibility) || publicLogs) return;
  invariant(visibility === 'private', runnerPublicCode, runnerPublicReason(repository, visibility));
}
