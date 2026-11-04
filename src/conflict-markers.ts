// SPDX-License-Identifier: Apache-2.0
/** Serializable, bounded line-prefix scanner shared by local and hosted recovery.
 * A separator alone is ordinary source; only an ordered three-marker hunk counts. */
export type ConflictMarkerScan = {
  prefix: string;
  skip: boolean;
  found: boolean;
  stage?: number;
  binary?: boolean;
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
  if (bytes.includes(0)) scan.binary = true;
  if (!scan.binary) {
    let textBytes = bytes;
    if (scan.utf8Tail) {
      textBytes = new Uint8Array(scan.utf8Tail.length + bytes.length);
      for (let i = 0; i < scan.utf8Tail.length; i++) textBytes[i] = scan.utf8Tail.charCodeAt(i);
      textBytes.set(bytes, scan.utf8Tail.length);
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(textBytes, { stream: true });
    } catch {
      scan.binary = true;
    }
    scan.utf8Tail = '';
    // Retain at most three incomplete UTF-8 bytes across physical chunks and
    // persisted worker steps; decoding never retains a whole file.
    for (let i = textBytes.length - 1; i >= Math.max(0, textBytes.length - 4); i--) {
      const byte = textBytes[i]!;
      if ((byte & 0xc0) === 0x80) continue;
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (length > textBytes.length - i) scan.utf8Tail = String.fromCharCode(...textBytes.subarray(i));
      break;
    }
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
  return scan.found && !scan.binary && !scan.utf8Tail;
}
export function hasConflictMarkers(bytes: Uint8Array) {
  const scan = conflictMarkerScan();
  scanConflictMarkers(scan, bytes);
  return conflictMarkersFound(scan);
}
