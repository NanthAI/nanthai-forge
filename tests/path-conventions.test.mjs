// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathConventionFindings } from '../scripts/check-path-conventions.mjs';

test('an idle observer cannot add a periodic or chained refresh timer', () => {
  assert.deepEqual(
    pathConventionFindings(
      'web/src/import-watch.idle.tsx',
      // test-signal: allow timer syntax is parsed as a negative fixture and never executed.
      'setInterval(refresh, 1000);\nwindow["setTimeout"](() => refresh(), 1000);',
    ),
    [
      'web/src/import-watch.idle.tsx:1: Idle paths must observe events without a refresh timer.',
      'web/src/import-watch.idle.tsx:2: Idle paths must observe events without a refresh timer.',
    ],
  );
});

test('a tagged idle observer cannot defer a poll to the Convex scheduler', () => {
  assert.deepEqual(
    pathConventionFindings(
      'convex/mirror.idle.ts',
      'await ctx.scheduler.runAfter(500, poll);\nawait ctx["scheduler"]?.["runAt"](at, poll);',
    ),
    [
      'convex/mirror.idle.ts:1: Idle paths must observe events without scheduling a refresh.',
      'convex/mirror.idle.ts:2: Idle paths must observe events without scheduling a refresh.',
    ],
  );
});

test('idle event registration and cleanup pass, and lifecycle timers stay in mixed modules', () => {
  assert.deepEqual(
    pathConventionFindings(
      'web/src/import-watch.idle.ts',
      // test-signal: allow this source comment is parsed to check that timer mentions pass.
      `// A stale implementation used setTimeout(refresh, 500).
window.addEventListener('online', refresh);
const close = watch.onUpdate(refresh);
return () => {
  close();
  window.removeEventListener('online', refresh);
};`,
    ),
    [],
  );
  // test-signal: allow detach timer syntax only checks whether the mixed-module scope applies.
  assert.deepEqual(pathConventionFindings('web/src/live-reads.ts', 'setTimeout(detach, graceMs);'), []);
});

test('tagged binary loops reject object, array, constructor and copy scratch work', () => {
  assert.deepEqual(
    pathConventionFindings(
      'src/physical-manifest-binary.ts',
      `// hot-loop: decode each integer byte.
do {
  const scratch = { byte };
  const pair = [byte, byte];
  const bytes = new Uint8Array(2);
  use(input.slice(at, at + 2));
  const [first, ...rest] = bytes;
  const { head, ...fields } = input;
  use(input.toReversed());
} while (hasMore);
`,
    ),
    [3, 4, 5, 6, 7, 8, 9].map(
      line =>
        `src/physical-manifest-binary.ts:${line}: Move scratch allocation or copying outside the hot-loop body.`,
    ),
  );
});

test('hot loops can update scalars and a buffer reserved before the loop', () => {
  assert.deepEqual(
    pathConventionFindings(
      'src/binary.hot.ts',
      `const output = new Uint8Array(length);
for (let at = 0; at < length; at++) {
  output[at] = input[at];
  sum += output[at];
}
return output.slice(0, length);`,
    ),
    [],
  );
  assert.deepEqual(pathConventionFindings('src/binary.hot.ts', 'while (hasMore) use(Array.from(input));'), [
    'src/binary.hot.ts:1: Move scratch allocation or copying outside the hot-loop body.',
  ]);
});

test('a mixed codec can allocate returned entries in untagged loops', () => {
  assert.deepEqual(
    pathConventionFindings(
      'src/physical-manifest-binary.ts',
      `// hot-loop: decode a varint.
while (byte >= 128) byte = input[at++];
for (const record of records) decoded.push({ record });`,
    ),
    [],
  );
});
