// SPDX-License-Identifier: Apache-2.0
// Issue 85801d6f: the first-check proof ran about 9 s of CPU in a 512 MiB Node action (live capture
// 2026-11-06). Its cost must stay linear in the manifest size and its answers must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { analyzeCrossHeadReuse } from '../dist/hosted-cross-head-analysis.js';
import { pathsOverlap, validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const naive = (a, b) => a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

test('pathsOverlap answers exactly as the all-pairs definition did', () => {
  let seed = 7;
  const next = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const names = ['a', 'b', 'ab', 'a b', '', 'src', 'src2'];
  const path = () => Array.from({ length: 1 + next(4) }, () => names[next(names.length)]).join('/');
  for (let round = 0; round < 3000; round++) {
    const a = Array.from({ length: next(6) }, path),
      b = Array.from({ length: next(6) }, path);
    assert.equal(pathsOverlap(a, b), naive(a, b), JSON.stringify([a, b]));
  }
  assert.equal(pathsOverlap(['src/a.ts'], ['src/a.tsx']), false, 'a longer name is not a child');
  assert.equal(pathsOverlap(['src'], ['src/a.ts']), true);
  assert.equal(pathsOverlap(['src/a.ts'], ['src']), true);
  assert.equal(pathsOverlap([], ['src']), false);
});

function manifests(files, candidate, main, common = 0) {
  const entry = (path, blob, mode = 'file') => ({ path, blob: sha(blob), mode });
  const state = changes => {
    const map = new Map();
    for (let i = 0; i < files; i++)
      map.set(
        `dir${i % 40}/sub${i % 7}/file-${i}.ts`,
        entry(`dir${i % 40}/sub${i % 7}/file-${i}.ts`, `b${i}`),
      );
    for (const [path, blob, mode] of changes) map.set(path, entry(path, blob, mode));
    return new TextEncoder().encode(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [...map.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
        message: 'm',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  };
  const shared = Array.from({ length: common }, (_, i) => [`shared/f${i}.ts`, `s${i}`]);
  const mine = [...shared, ...Array.from({ length: candidate }, (_, i) => [`mine/f${i}.ts`, `c${i}`])],
    theirs = [...shared, ...Array.from({ length: main }, (_, i) => [`theirs/f${i}.ts`, `m${i}`])];
  return [state([]), state(mine), state(theirs), state([...mine, ...theirs])];
}
function scenario(files, candidate, main, tamper, common = 0) {
  const bytes = manifests(files, candidate, main, common);
  if (tamper) bytes[3] = manifests(files, candidate, main + 1, common)[3];
  const heads = bytes.map(b => sha(b));
  const selection = new TextEncoder().encode(JSON.stringify({ scope: 'full', tests: [] }));
  const pins = new Map([...heads.map((h, i) => [h, bytes[i]]), [sha(selection), selection]]);
  const zero = 'a'.repeat(64),
    run = randomUUID();
  const basis = {
    checkedBase: { head: heads[0], receiptId: 'r0' },
    checked: { id: run, head: heads[1], digest: zero },
    main: { head: heads[2], receiptId: 'r2' },
    head: heads[3],
    runId: run,
    terminalDigest: zero,
    planDigest: zero,
    audit: {
      source: 'audit',
      head: zero,
      runId: run,
      terminalDigest: zero,
      planDigest: zero,
      selection: sha(selection),
      sequence: 1,
      coverage: 'main-audit-debt',
    },
  };
  let reads = 0;
  return {
    reads: () => reads,
    run: () =>
      analyzeCrossHeadReuse(basis, sha(selection), async digests => (reads++, digests.map(d => pins.get(d)))),
  };
}

test('the first-check proof reads the same six pins and decides as before on large manifests', async () => {
  const clean = scenario(4000, 40, 40);
  const decision = await clean.run();
  assert.equal(clean.reads(), 2, 'four manifests, then the two selection pins');
  assert.equal(decision.proof.algorithm, 'clean-disjoint-v2');
  assert.equal(decision.proof.candidatePaths.length, 40);
  assert.equal(decision.proof.mainPaths.length, 40);
  assert.deepEqual(decision.proof.docsOverlap, []);
  // Issue 1018d0f8: hundreds of identical shared changes need no extra object/graph reads.
  const shared = scenario(4000, 40, 40, false, 400);
  const identical = await shared.run();
  assert.equal(shared.reads(), 2);
  assert.equal(identical.proof.identicalPaths.length, 400);
  assert(validCrossHeadProof(identical.proof));
  // A recomposition that differs from the union of both deltas never produces a proof.
  assert.deepEqual(await scenario(4000, 40, 40, true).run(), { reason: 'composition-not-exact' });
});

test('canonicalPayload builds its JSON schema once, not per call', () => {
  const source = readFileSync(new URL('../src/hosted-source-operation.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function canonicalPayload'));
  assert(!/z\.json\(\)/.test(body.slice(0, body.indexOf('\n}\n'))), 'z.json() inside canonicalPayload');
});
