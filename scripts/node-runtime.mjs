// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const nodeRequirement = 'Forge requires Node 24.22.1+ (24.x).';

/** Match the supported stable release lines in package.json engines. */
export function supportedNode(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
}
