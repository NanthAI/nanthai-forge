// SPDX-License-Identifier: Apache-2.0
import { openSync, closeSync, fchmodSync, readFileSync, writeFileSync } from 'node:fs';

/** The plan artifact holds result-write capabilities. Restrict the open descriptor before
 * writing any new bytes, including when replacing an older, world-readable bundle. */
export function writeActionsRunBundle(path: string, value: unknown) {
  const fd = openSync(path, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(value));
  } finally {
    closeSync(fd);
  }
}
/** Artifact extraction can change mode bits. Restore supervisor-only access before running
 * Candidate code; the bundle is never among the Candidate user's readable paths. */
export function readActionsRunBundle(path: string): Record<string, unknown> {
  const fd = openSync(path, 'r');
  try {
    fchmodSync(fd, 0o600);
    return JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}
