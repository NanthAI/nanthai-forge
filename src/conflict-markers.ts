// SPDX-License-Identifier: Apache-2.0
import { TEXT_SNIFF_BYTES } from './text-bytes.js';
/** Serializable, bounded line-prefix scanner shared by local and hosted recovery.
 * A separator alone is ordinary source; only an ordered three-marker hunk counts.
 * Binary is Git's rule, as the merge decides it (Issue 113bc7b3): a NUL byte in the first
 * 8,000 bytes. Text in any ASCII-compatible encoding, valid UTF-8 or not, is scanned. */
export type ConflictMarkerScan = {
  prefix: string;
  skip: boolean;
  found: boolean;
  stage?: number;
  binary?: boolean;
  /** Bytes scanned so far, up to the binary sniff window. */
  seen?: number;
  /** Retired field of the UTF-8 gate; ignored when a persisted scan still carries it. */
  utf8Tail?: string;
};
export const conflictMarkerScan = (): ConflictMarkerScan => ({
  prefix: '',
  skip: false,
  found: false,
  stage: 0,
});
function line(scan: ConflictMarkerScan) {
  if (/^<<<<<<<(?: |\r?$)/.test(scan.prefix)) scan.stage = 1;
  else if (/^=======\r?$/.test(scan.prefix) && scan.stage === 1) scan.stage = 2;
  else if (/^>>>>>>>(?: |\r?$)/.test(scan.prefix) && scan.stage === 2) scan.found = true;
}
export function scanConflictMarkers(scan: ConflictMarkerScan, bytes: Uint8Array) {
  const seen = scan.seen ?? 0;
  if (seen < TEXT_SNIFF_BYTES) {
    if (bytes.subarray(0, TEXT_SNIFF_BYTES - seen).includes(0)) scan.binary = true;
    scan.seen = Math.min(TEXT_SNIFF_BYTES, seen + bytes.length);
  }
  if (scan.binary) return;
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    if (!scan.skip) {
      const prefix = bytes.subarray(start, Math.min(end, start + 9 - scan.prefix.length));
      scan.prefix += String.fromCharCode(...prefix);
      if (scan.prefix.length === 9) scan.skip = true;
    }
    if (newline === -1) break;
    line(scan);
    scan.prefix = '';
    scan.skip = false;
    start = newline + 1;
  }
}
export function conflictMarkersFound(scan: ConflictMarkerScan) {
  line(scan);
  return scan.found && !scan.binary;
}
export function hasConflictMarkers(bytes: Uint8Array) {
  const scan = conflictMarkerScan();
  scanConflictMarkers(scan, bytes);
  return conflictMarkersFound(scan);
}
