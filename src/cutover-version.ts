// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
export const CUTOVER_CLI_VERSION = '0.3.1';
export const CUTOVER_UPGRADE = `Upgrade nforge to ${CUTOVER_CLI_VERSION} or later: install the matching @nanthai/forge release package with npm install -g /path/to/nanthai-forge-${CUTOVER_CLI_VERSION}.tgz. Rediscover authority and resume the original operation through hosted CAS; preserve local edits and pending operation IDs.`;
export function requireCutoverVersion(version?: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  const parts = match?.slice(1).map(Number);
  invariant(
    parts && (parts[0]! > 0 || parts[1]! > 3 || (parts[1] === 3 && parts[2]! >= 1)),
    'CLI_UPGRADE_REQUIRED',
    CUTOVER_UPGRADE,
  );
}
