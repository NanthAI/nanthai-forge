// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictMarkerScan,
  scanConflictMarkers,
  conflictMarkersFound,
  hasConflictMarkers,
} from '../dist/conflict-markers.js';

const hunk = '<<<<<<< lane\nleft\n=======\nright\n>>>>>>> main\n';
test('conflict detection requires a complete ordered three-marker text hunk', () => {
  for (const text of [
    '=======\n',
    '# Heading\n=======\n',
    '<<<<<<< lane\nonly\n',
    '>>>>>>> main\n=======\n<<<<<<< lane\n',
    '<<<<<<< lane\n========\n>>>>>>> main\n',
    `\0${hunk}`,
  ])
    assert.equal(hasConflictMarkers(Buffer.from(text)), false, text);
  for (const text of [
    hunk,
    hunk.trimEnd(),
    hunk.replaceAll('\n', '\r\n'),
    hunk.replace('left', '||||||| base\noriginal\nleft'),
  ]) {
    assert.equal(hasConflictMarkers(Buffer.from(text)), true);
    for (let width = 1; width <= 11; width++) {
      let scan = conflictMarkerScan();
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += width) {
        scanConflictMarkers(scan, bytes.subarray(i, i + width));
        scan = JSON.parse(JSON.stringify(scan));
        assert(scan.prefix.length <= 9);
      }
      assert.equal(conflictMarkersFound(scan), true);
    }
  }
});

test('binary and invalid UTF-8 are not text; multibyte text survives one-byte chunks', () => {
  assert.equal(hasConflictMarkers(Buffer.concat([Buffer.from([255]), Buffer.from(hunk)])), false);
  assert.equal(hasConflictMarkers(Buffer.concat([Buffer.from(hunk), Buffer.from([0xe2])])), false);
  const scan = conflictMarkerScan();
  for (const byte of Buffer.from(`文\n${hunk}文`)) scanConflictMarkers(scan, Uint8Array.of(byte));
  assert.equal(conflictMarkersFound(scan), true);
});
