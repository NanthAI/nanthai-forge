// SPDX-License-Identifier: Apache-2.0
export const nodeRequirement = 'Forge requires Node 22.23.4+ (22.x) or 24.22.1+ (24.x).';

/** Match the supported stable release lines in package.json engines. */
export function supportedNode(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return (
    (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))) ||
    (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)))
  );
}
