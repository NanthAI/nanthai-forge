// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cliBuildCommit, cliInstallation } from './cli-installation.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { ForgeError } from './errors.js';
import { hookHealth } from './agent-hook-health.js';
import { shellQuote } from './shell-quote.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { readHostedMainSelection } from './hosted-main-marker.js';

/** `nforge doctor ROOT` for a Forge clone or Lane checkout: no Git, no network, no writes.
 * Returns null for any other root so the Git-worktree doctor keeps its own path. */
export function hostedDoctor(root: string, home?: string): object | null {
  const selected = hostedAgentRoot(root);
  const laneMarker = existsSync(join(selected, '.forge', 'hosted-lane.json'));
  const mainMarker = existsSync(join(selected, '.forge', 'hosted-main.json'));
  if (!laneMarker && !mainMarker) return null;
  const problems: { code: string; message: string }[] = [];
  const attempt = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (error) {
      problems.push({
        code: error instanceof ForgeError ? error.code : 'CHECKOUT_UNREADABLE',
        message: error instanceof Error ? error.message : 'The checkout marker could not be read.',
      });
      return null;
    }
  };
  let checkout: Record<string, unknown> | null = null;
  if (laneMarker) {
    const marker = attempt(() => readHostedLaneCheckout(selected));
    if (marker)
      checkout = {
        projectId: marker.selection.projectId,
        laneId: marker.selection.laneId,
        intentId: marker.selection.intentId,
        head: marker.selection.head,
        base: marker.selection.base,
        version: marker.selection.version,
        sourceVersion: marker.selection.sourceVersion,
        lifecycleVersion: marker.selection.lifecycleVersion,
        files: marker.state.files.length,
        materialized: marker.materialized.length,
        scope: marker.scope === null ? 'full' : 'paths',
      };
  } else {
    const main = attempt(() => readHostedMainSelection(selected));
    if (main)
      checkout = {
        projectId: main.projectId,
        head: main.head,
        receiptId: main.receipt.id,
        ...(main.schema === 2 ? { sourceRevision: main.sourceRevision } : {}),
      };
  }
  // A marker that failed to read would fail the address read the same way; report it once.
  const address = problems.length ? null : attempt(() => hostedAgentAddress(selected, {}));
  const hooks = hookHealth(selected, home);
  const quoted = shellQuote(selected);
  return {
    ready: problems.length === 0 && hooks.status !== 'attention',
    kind: laneMarker ? 'forge-lane' : 'forge-clone',
    cli: {
      version: CUTOVER_CLI_VERSION,
      build: cliBuildCommit(),
      installed: cliInstallation() !== null,
      node: process.version,
    },
    hooks,
    checkout,
    address: address ? { url: address.url, projectId: address.projectId } : null,
    problems,
    networkRequired: false,
    freshness: laneMarker
      ? 'Not checked offline. Run nforge agent ROOT status {} for behindMain.'
      : 'Not checked offline. Run nforge agent ROOT status {} for clone freshness, then nforge pull ROOT.',
    next: problems.length
      ? `Fix the listed problems, or recreate the checkout (${laneMarker ? 'nforge agent ' + quoted + ' open {"laneId":"…"}' : 'nforge clone'}).`
      : hooks.status === 'attention'
        ? hooks.repair
        : null,
  };
}
