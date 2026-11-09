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

test('incident 113bc7b3: binary is a NUL in the first 8,000 bytes; non-UTF-8 text is scanned; multibyte text survives one-byte chunks', () => {
  // Windows-1252 bytes and a cut UTF-8 sequence are text: markers written into them must be found.
  assert.equal(hasConflictMarkers(Buffer.concat([Buffer.from([255, 10]), Buffer.from(hunk)])), true);
  assert.equal(hasConflictMarkers(Buffer.concat([Buffer.from(hunk), Buffer.from([0xe2])])), true);
  assert.equal(hasConflictMarkers(Buffer.from(`caf\xe9\n${hunk}`, 'latin1')), true);
  assert.equal(
    hasConflictMarkers(
      Buffer.concat([Buffer.from('x'.repeat(7999)), Buffer.from([0]), Buffer.from(`\n${hunk}`)]),
    ),
    false,
  );
  const late = Buffer.concat([Buffer.from('x'.repeat(8000)), Buffer.from([0]), Buffer.from(`\n${hunk}`)]);
  assert.equal(hasConflictMarkers(late), true, 'a NUL after the window does not hide markers');
  for (const width of [1, 7, 4096]) {
    let scan = conflictMarkerScan();
    for (let i = 0; i < late.length; i += width) {
      scanConflictMarkers(scan, late.subarray(i, i + width));
      scan = JSON.parse(JSON.stringify(scan));
    }
    assert.equal(conflictMarkersFound(scan), true, `chunks of ${width}`);
  }
  const scan = conflictMarkerScan();
  for (const byte of Buffer.from(`文\n${hunk}文`)) scanConflictMarkers(scan, Uint8Array.of(byte));
  assert.equal(conflictMarkersFound(scan), true);
});
