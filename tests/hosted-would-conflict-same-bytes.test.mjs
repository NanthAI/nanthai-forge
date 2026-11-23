// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 36fd3295 (incident 5e3c3a3c, section B): an early-resolution Lane carries its predecessor's
// files; when that predecessor lands, the same bytes on main are not SYNC_REQUIRED. The land --save
// half: hosted-land-sync-once.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/state/hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import * as advice from '../dist/hosted-would-conflict.js';

const wouldConflict = await import(moduleUrl('../convex/projectHostedLandingWouldConflict.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const blob = name => digest(Buffer.from(name));
const file = name => ({ blob: blob(name), mode: 'file' });
const stripSystem = row => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));
/** A Candidate that changes `paths`, with (optionally) its stored file listing: path -> after bytes. */
function candidate(f, paths, after) {
  const base = f.request().candidateId;
  const records = [...f.tables.projectHostedRecords.values()];
  const source = records.find(r => r.kind === 'candidate' && r.key === base);
  const body = f.tables.projectHostedRecordBodies.get(source.bodyId);
  const id = randomUUID();
  const value = canonicalPayload({
    ...JSON.parse(body.value),
    id,
    governance: { version: 1, paths, ownerInputs: false },
  });
  const bodyId = f.insert('projectHostedRecordBodies', { ...stripSystem(body), value });
  let candidateFiles;
  if (after) {
    const listing = Buffer.from(
      canonicalPayload({
        schema: 1,
        kind: 'forge-candidate-files',
        base: '0'.repeat(64),
        head: '1'.repeat(64),
        files: Object.entries(after).map(([path, next]) => ({
          path,
          status: next ? 'modified' : 'deleted',
          before: { path, blob: blob(`${path}@base`), mode: 'file' },
          after: next ? { path, ...file(next) } : null,
        })),
      }),
    );
    candidateFiles = { sha256: digest(listing), size: listing.length };
    f.insert('projectObjects', {
      projectId: f.projectId,
      digest: candidateFiles.sha256,
      size: candidateFiles.size,
      location: 'r2',
      r2Key: `objects/${candidateFiles.sha256}`,
      r2Committed: true,
      nonce: 'listing',
      removed: false,
    });
    f.listings ??= new Map();
    f.listings.set(candidateFiles.sha256, JSON.parse(listing.toString('utf8')));
  }
  const { _id, _creationTime, ...record } = source;
  void _id;
  void _creationTime;
  const recordId = f.insert('projectHostedRecords', {
    ...record,
    key: id,
    bodyId,
    digest: digest(value),
    bytes: Buffer.byteLength(value),
    ...(candidateFiles ? { candidateFiles } : {}),
  });
  const head = [...f.tables.projectHostedRecordHeads.values()].find(
    r => r.kind === 'candidate' && r.key === base,
  );
  f.insert('projectHostedRecordHeads', { ...stripSystem(head), key: id, recordId });
  return id;
}
const rowOf = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
const pass = (f, input) =>
  f.run('wouldConflict', (ctx, args) => wouldConflict.markWouldConflict(ctx, args), {
    projectId: f.projectId,
    ...input,
  });
const handoffs = f =>
  f.pendingTasks().filter(t => t.name === 'projectHostedConflictMerge:wouldConflictConfig');
/** The config action's comparison, as it runs on main's State and each listing (no R2 here). */
function actionAnswer(f, checks, mainFiles) {
  const main = new Map(Object.entries(mainFiles).map(([path, name]) => [path, file(name)]));
  return checks.flatMap(check => {
    const paths = advice.sameBytesPaths(check.paths, main, f.listings.get(check.listing.digest));
    return paths.length ? [{ candidateId: check.candidateId, paths }] : [];
  });
}
const declared = { union: [], fragments: [] };

/** Incident t22302: the predecessor t26563 lands its two files; the follower's early resolution
 * carries both with the same bytes, plus its own file. Another follower changed one of them for real. */
async function incident() {
  const f = await landingFixture();
  const landedPaths = ['.bench/dry/group-same-package-shared.md', '.bench/dry/t26563.md'];
  const predecessor = await f.enqueue(f.request({ candidateId: candidate(f, landedPaths) }));
  const carried = await f.enqueue(
    f.request({
      candidateId: candidate(f, [...landedPaths, '.bench/dry/t22302.md'], {
        '.bench/dry/group-same-package-shared.md': 'shared@t26563',
        '.bench/dry/t26563.md': 't26563',
        '.bench/dry/t22302.md': 't22302',
      }),
    }),
  );
  const different = await f.enqueue(
    f.request({
      candidateId: candidate(f, ['.bench/dry/group-same-package-shared.md'], {
        '.bench/dry/group-same-package-shared.md': 'shared@other',
      }),
    }),
  );
  const main = {
    '.bench/dry/group-same-package-shared.md': 'shared@t26563',
    '.bench/dry/t26563.md': 't26563',
  };
  return { f, landedPaths, predecessor, carried, different, main };
}

test('incident 5e3c3a3c t22302: the follower carrying the landed bytes gets no SYNC_REQUIRED; different bytes still do', async () => {
  const { f, landedPaths, predecessor, carried, different, main } = await incident();
  const before = f.counts.length;
  // First pass: nothing marked yet; one handoff carrying both would-be-marked Candidates' listings.
  assert.equal(await pass(f, { paths: landedPaths, landedSubmissionId: predecessor.id }), 0);
  const [task] = handoffs(f);
  assert.ok(task, 'one config handoff');
  const checks = JSON.parse(task.args[0].checks);
  assert.deepEqual(
    checks.map(check => check.paths),
    [landedPaths, ['.bench/dry/group-same-package-shared.md']],
  );
  const first = f.counts.slice(before).find(c => c.name === 'wouldConflict');
  // Bounded: one queue range, three reads per Candidate plus one listing row each.
  assert(first.documents <= wouldConflict.WOULD_CONFLICT_SCAN + 4 * 2, `documents ${first.documents}`);
  // Second pass with main's lists and the byte answer.
  const same = actionAnswer(f, checks, main);
  assert.equal(await pass(f, { paths: landedPaths, landedSubmissionId: predecessor.id, declared, same }), 1);
  assert.equal(rowOf(f, carried.id).wouldConflict, undefined, 'same bytes: no SYNC_REQUIRED');
  assert.equal((await f.status(carried.id)).wouldConflict, undefined);
  const marked = JSON.parse(rowOf(f, different.id).wouldConflict);
  assert.deepEqual(marked.paths, ['.bench/dry/group-same-package-shared.md']);
  assert.match(marked.next, /^SYNC_REQUIRED/);
  assert.equal(handoffs(f).length, 1, 'the second pass hands off nothing more');
});

test('a Candidate without a listing keeps path advice; a partly equal Candidate is marked only for the differing file', async () => {
  const f = await landingFixture();
  const landing = await f.enqueue(f.request({ candidateId: candidate(f, ['a.ts', 'b.ts']) }));
  const unlisted = await f.enqueue(f.request({ candidateId: candidate(f, ['a.ts']) }));
  const partial = await f.enqueue(
    f.request({ candidateId: candidate(f, ['a.ts', 'b.ts'], { 'a.ts': 'a1', 'b.ts': 'b-mine' }) }),
  );
  await pass(f, { paths: ['a.ts', 'b.ts'], landedSubmissionId: landing.id });
  const checks = JSON.parse(handoffs(f)[0].args[0].checks);
  assert.equal(checks.length, 1, 'only the listed Candidate is compared');
  const same = actionAnswer(f, checks, { 'a.ts': 'a1', 'b.ts': 'b-main' });
  assert.equal(await pass(f, { paths: ['a.ts', 'b.ts'], landedSubmissionId: landing.id, declared, same }), 2);
  assert.deepEqual(JSON.parse(rowOf(f, unlisted.id).wouldConflict).paths, ['a.ts']);
  assert.deepEqual(JSON.parse(rowOf(f, partial.id).wouldConflict).paths, ['b.ts']);
});

test('byte comparison: equal blob and mode, or both deleted, is the same; anything unknown is not', () => {
  const main = new Map([
    ['same.ts', file('x')],
    ['mode.sh', file('y')],
    ['other.ts', file('z')],
  ]);
  const listing = {
    files: [
      { path: 'same.ts', after: file('x') },
      { path: 'mode.sh', after: { ...file('y'), mode: 'executable' } },
      { path: 'other.ts', after: file('w') },
      { path: 'gone.ts', after: null },
      { path: 'kept.ts', after: null },
    ],
  };
  main.set('kept.ts', file('k'));
  assert.deepEqual(
    advice.sameBytesPaths(
      ['same.ts', 'mode.sh', 'other.ts', 'gone.ts', 'kept.ts', 'unlisted.ts'],
      main,
      listing,
    ),
    ['same.ts', 'gone.ts'],
  );
});
