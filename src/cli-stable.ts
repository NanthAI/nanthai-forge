// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { cliBuildPackage, type StableSelection } from './cli-installation.js';
import { cliUpdateCommand } from './cli-update-source.js';
import { ForgeError, invariant } from './errors.js';
import { cliStableReleaseMetadataSchema, type HostedMainV2 } from './hosted-main.js';
import { durableReplace } from './state/durability.js';

const floorPath = (installation: string) => join(installation, 'stable-release.json');
type ReleaseMetadata = z.infer<typeof cliStableReleaseMetadataSchema>;
const cacheSchema = z.object({
  checkedAt: z.number().finite(),
  metadata: cliStableReleaseMetadataSchema.optional(),
});
const STABLE_CHECK_INTERVAL_MS = 10 * 60_000;

function readStableCache(installation: string) {
  try {
    return cacheSchema.parse(JSON.parse(readFileSync(floorPath(installation), 'utf8')));
  } catch {
    return undefined;
  }
}

export function stableCheckDue(installation: string, now = Date.now()) {
  const cache = readStableCache(installation);
  return !cache || now < cache.checkedAt || now - cache.checkedAt >= STABLE_CHECK_INTERVAL_MS;
}

/** Claim the interval before the request. A failed or legacy read keeps the last known floor. */
export function recordStableCheck(installation: string, metadata?: ReleaseMetadata) {
  const known = metadata ?? readStableCache(installation)?.metadata;
  durableReplace(floorPath(installation), JSON.stringify({ checkedAt: Date.now(), metadata: known }));
}

export function stableReleaseTarget(
  installation: string,
  observed: HostedMainV2 & { cliRelease?: ReleaseMetadata | undefined },
  selection: StableSelection,
) {
  const { cliRelease, ...main } = observed;
  recordStableCheck(installation, cliRelease);
  const head = selection.pin ?? cliRelease?.stableHead;
  invariant(head, 'CLI_UPDATE_REQUIRED', 'The configured Forge source has no stable release yet.');
  return { ...main, head };
}

function versionBelow(version: string, floor: string) {
  const installed = version.split(/[+-]/, 1)[0]!.split('.').map(BigInt);
  const minimum = floor.split('.').map(BigInt);
  const firstDifference = minimum.findIndex((part, index) => part !== installed[index]);
  if (firstDifference < 0) return version.split('+', 1)[0]!.includes('-');
  return installed[firstDifference]! < minimum[firstDifference]!;
}

export function requireStableCompatibility(installation: string, root: string, selection: StableSelection) {
  const floor = readStableCache(installation)?.metadata;
  if (!floor?.minimumCliVersion && !floor?.minimumProtocolVersion) return;
  const build = cliBuildPackage(root);
  const protocol = build.forge?.cliProtocolVersion ?? 0;
  const minimumCli = floor.minimumCliVersion;
  const minimumProtocol = floor.minimumProtocolVersion;
  if (
    !(minimumCli && versionBelow(build.version, minimumCli)) &&
    !(minimumProtocol && protocol < minimumProtocol)
  )
    return;
  const floorText = [
    ...(minimumCli ? [`CLI ${minimumCli}`] : []),
    ...(minimumProtocol ? [`protocol ${minimumProtocol}`] : []),
  ].join(' and ');
  const command = `${cliUpdateCommand(installation)}${selection.pin ? ' --unpin' : ''}`;
  throw new ForgeError(
    'CLI_UPGRADE_REQUIRED',
    `Forge requires at least ${floorText}. This build is below the compatibility floor. Next: ${command}`,
    undefined,
    { command },
  );
}

export function requireStableRuntime(installation: string, root: string, selection: StableSelection) {
  invariant(
    existsSync(join(root, 'dist', 'cli-stable.js')),
    'CLI_UPDATE_SOURCE_INVALID',
    'Select a signed Forge build that supports the stable release channel.',
  );
  requireStableCompatibility(installation, root, selection);
}
