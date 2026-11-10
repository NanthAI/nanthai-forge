// SPDX-License-Identifier: Apache-2.0
import { clientCacheRoot } from './root-paths.js';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { ForgeError } from './errors.js';
import { hostedAgentActions } from './hosted-agent-contract.js';
import { durableReplace } from './state/durability.js';

/** CLI/server skew is reported as an upgrade step, never as a bare unsupported action. */
export const CLI_UPGRADE_STEP =
  'Upgrade nforge to the release that matches this deployment (reinstall @nanthai/forge from the same source), then retry the same command; retained operation IDs resume.';
export function hostedActionAlternative(action: string) {
  if (['land-ready', 'land'].includes(action))
    return 'Use land --save with the full original request to submit or resume (--no-wait returns after submission); use wait {operationIds:[ORIGINAL_UUID]} to wait.';
  if (action === 'log')
    return 'Use log {runId} for the retained tail of a check run, observe {runId} for check status and the returned CI provider link for the full log.';
  if (['records', 'candidates', 'candidate', 'views', 'view'].includes(action))
    return 'Use status {laneId} for a Lane or planning for the hosted backlog.';
  return 'Use capabilities for deployment actions and nforge agent ROOT --help in a hosted checkout for accepted parameters.';
}
const known = new Set<string>(hostedAgentActions);
const newerFile = (root: string) => join(clientCacheRoot(root), 'agent', 'server-actions.json');

/** A newer server may advertise actions this CLI does not know. Keep the known ones (the strict
 * contract parse still applies) and remember the rest locally, so a later refusal names the fix. */
export function knownCapabilities(root: string, discovery: unknown): unknown {
  if (!discovery || typeof discovery !== 'object') return discovery;
  const actions = (discovery as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return discovery;
  const newer = actions.filter(action => typeof action === 'string' && !known.has(action));
  if (!newer.length) return discovery;
  try {
    mkdirSync(dirname(newerFile(root)), { recursive: true, mode: 0o700 });
    durableReplace(newerFile(root), JSON.stringify(newer));
  } catch {
    /* Advisory only. */
  }
  return { ...discovery, actions: actions.filter(action => known.has(action as string)) };
}
function newerActions(root: string): string[] {
  try {
    const value = JSON.parse(readFileSync(newerFile(root), 'utf8')) as unknown;
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
/** The CLI does not know this action. No network call: private input never leaves the machine. */
export function unknownActionError(root: string, action: string): ForgeError {
  if (newerActions(root).includes(action))
    return new ForgeError(
      'CLI_UPGRADE_REQUIRED',
      `This deployment offers hosted action ${action}; nforge ${CUTOVER_CLI_VERSION} predates it. ${CLI_UPGRADE_STEP}`,
    );
  return new ForgeError(
    'HOSTED_ACTION_UNSUPPORTED',
    `nforge ${CUTOVER_CLI_VERSION} has no hosted action ${/^[a-z][a-z-]{0,40}$/.test(action) ? action : 'with that name'}. ${hostedActionAlternative(action)}`,
  );
}
/** The server does not advertise an action this CLI knows: the deployment is older than the CLI. */
export function unadvertisedActionError(action: string): ForgeError {
  return new ForgeError(
    'HOSTED_ACTION_UNSUPPORTED',
    `This deployment does not offer hosted action ${action} under its current source authority. ${hostedActionAlternative(action)}`,
  );
}
/** `paths`: the reply fields that failed (replyIssuePaths: paths only, never values). */
export function protocolMismatchError(paths: readonly string[] = []): ForgeError {
  return new ForgeError(
    'HOSTED_PROTOCOL_INVALID',
    `Hosted agent response does not match the contract of nforge ${CUTOVER_CLI_VERSION}${paths.length ? ` at ${paths.join(', ')}` : ''}; the CLI and deployment versions likely differ. ${CLI_UPGRADE_STEP}`,
  );
}
/** A contract failure that did not come from the reply boundary: this CLI's own request or a local
 * file, not the deployment. Upgrading cannot fix it, so say where it failed (paths only, no values). */
export function localShapeError(action: string, issues: readonly { path: PropertyKey[] }[]): ForgeError {
  const where = [...new Set(issues.map(issue => issue.path.map(String).join('.') || 'parameters'))]
    .slice(0, 5)
    .join(', ');
  return new ForgeError(
    'HOSTED_PROTOCOL_INVALID',
    `Hosted agent ${action} hit data that fails a shape check at ${where}, outside the reply boundary (not a recognised newer-deployment reply), so upgrading nforge is not known to help. Check the parameters (nforge agent ROOT ${action} --help); a replayed operation id changes nothing until they are valid.`,
  );
}
