// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { checkEnvironment, checkPassthrough } from './check-environment.js';
import type { AutonomyPolicy } from './autonomy-policy.js';
import type { Check } from './work-types.js';

export const ownerEnvNames = [
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'FORGE_WORK_LOCK_WAIT_MS',
  'FORGE_LANDING_LOCK_WAIT_MS',
  'FORGE_WORK_LOCK_TRACE',
  'FORGE_ACTOR',
  'FORGE_AGENT_NAME',
  'FORGE_ACTOR_TOOL',
  'FORGE_DISK_WARN_GB',
  'FORGE_DISK_BLOCK_GB',
];
// gh and its Git credential helper use these names for the selected GitHub account.
export const githubEnvNames = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'GH_DEBUG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
];
export const syncEnvNames = [
  ...ownerEnvNames,
  ...githubEnvNames,
  'FORGE_GITHUB_SYNC_NAME',
  'FORGE_GITHUB_SYNC_EMAIL',
  'FORGE_GITHUB_SYNC_COAUTHOR',
  'FORGE_GIT_TIMEOUT_MS',
];

/** Controllers need only explicitly declared check inputs and selected
 * GitHub authentication. Project commands still use checkProcessEnvironment. */
export function checkWorkerEnv(
  checks: Pick<Check, 'env' | 'credentials'>[],
  allow: string[] = [],
  extra: NodeJS.ProcessEnv = {},
) {
  return childEnv({
    allow: [
      ...ownerEnvNames,
      ...Object.keys(checkEnvironment().env),
      ...allow,
      // These names were explicitly selected by the check owner for execution.
      ...checks.flatMap(checkPassthrough),
    ],
    extra,
  });
}

/** Owner drivers can run queued checks and mirror a resulting green main.
 * Provider credentials follow the selected backend/mirror, never an ambient prefix. */
export function checkServiceEnv(
  checks: Pick<Check, 'env' | 'credentials'>[],
  policy: AutonomyPolicy,
  allow: string[] = [],
  extra: NodeJS.ProcessEnv = {},
) {
  return checkWorkerEnv(
    checks,
    [
      ...allow,
      ...(policy.githubMirror?.autoPush
        ? syncEnvNames
        : policy.checks?.runner === 'github-actions'
          ? githubEnvNames
          : []),
    ],
    extra,
  );
}
