// SPDX-License-Identifier: Apache-2.0
// Item 13ea93bf: repo-wide guard tests that import selection never picks fail most landing checks.
// The server learns them from the project's check failures (p x C / r - t) and Lane starts deliver
// the candidates; every preflight runs the picked set first, inside its budget.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { addGuardFailure, guardCandidates, ranEvidence, ranKey } from '../dist/preflight-guard-learning.js';
import { guardGateFields, learnGuardSet, recordPreflightRun } from '../dist/preflight-guard-set.js';
import {
  cachedGuardRevision,
  guardCachePath,
  guardRevisionToAsk,
  storeGuardCandidates,
} from '../dist/preflight-guard-cache.js';
import {
  landGateGuardEvidence,
  landGatesSchema,
  mergeRan,
  RAN_MAX_FILES,
} from '../dist/hosted-land-gates.js';
import { hostedStartResultSchema } from '../dist/hosted-lane.js';
import { preflightPlan } from '../dist/agent-preflight.js';

const laneId = '22222222-2222-4222-8222-222222222222';
const GUARD = 'tests/schema-guard.test.mjs';
const now = Date.parse('2026-11-19T12:00:00.000Z');
let next = 0;
const check = (...files) => ({
  id: `failed-${next++}`,
  timing: { submittedAt: '2026-11-19T10:00:00.000Z', ciEndedAt: '2026-11-19T10:14:00.000Z' },
  counts: { runnerSeconds: 3600 },
  testFiles: { failed: files.map(file => ({ file, report: { durationMs: 2000 } })) },
});
/** The server document after these check failures, each with what its preflight ran. */
function failures(...items) {
  let doc;
  items.forEach(
    ([state, evidence], i) =>
      (doc = addGuardFailure(doc, state, evidence, now - 1000 * (items.length - i)) ?? doc),
  );
  return doc;
}

test('a failed check records only failing test files its preflight did not run, once, bounded', () => {
  const skipped = check(GUARD, 'tests/ran.test.mjs');
  const doc = addGuardFailure(undefined, skipped, { ran: ranEvidence(['tests/ran.test.mjs']), runs: 3 }, now);
  const [[id, at, wait, runner, runs, files]] = JSON.parse(doc).failures;
  assert.deepEqual(
    { id, at, wait, runner, runs, files },
    {
      id: skipped.id,
      at: now,
      wait: 840,
      runner: 3600,
      runs: 3,
      files: [[GUARD, 2000]],
    },
  );
  // The same settled landing seen again (a later settle of the same operation) changes nothing.
  assert.equal(addGuardFailure(doc, skipped, { ran: '' }, now + 1), null);
  // A landing that did not say what ran (an older CLI, or over the cap) still counts as a failed
  // outcome, but teaches no file.
  const unknown = JSON.parse(addGuardFailure(doc, check(GUARD), {}, now + 2)).failures.at(-1);
  assert.deepEqual(unknown[5], []);
  // Bounded: the last 50 failures, at most 8 files each and 4 KB in all; older than 7 days drops.
  let big;
  for (let i = 0; i < 60; i++)
    big = addGuardFailure(
      big,
      check(...Array.from({ length: 12 }, (_, k) => `tests/long-name-${k}-${'x'.repeat(40)}.test.mjs`)),
      { ran: '' },
      now + i,
    );
  const kept = JSON.parse(big).failures;
  assert.ok(big.length <= 4 * 1024 && kept.length < 50 && kept.every(f => f[5].length === 8));
  const aged = addGuardFailure(doc, check(GUARD), { ran: '' }, now + 8 * 24 * 3600 * 1000);
  assert.equal(JSON.parse(aged).failures.length, 1, 'a week-old failure leaves');
});

test('the ran evidence is compact and only ever hides a failure', () => {
  assert.equal(ranKey(GUARD).length, 4);
  assert.equal(ranEvidence(['b', 'a', 'a']), [ranKey('a'), ranKey('b')].sort().join(''));
  assert.equal(ranEvidence(Array.from({ length: RAN_MAX_FILES + 1 }, (_, i) => `t/${i}.mjs`)), undefined);
  assert.equal(mergeRan([ranEvidence(['a']), ranEvidence(['b'])]), ranEvidence(['a', 'b']));
  assert.equal(mergeRan([ranEvidence(['a']), undefined]), undefined, 'one unknown Lane: unknown');
  // The land gate carries it beside the preflight result; a malformed value is refused.
  const entry = { laneId, head: 'a'.repeat(64), preflight: 'passed', ran: ranEvidence([GUARD]), runs: 2 };
  assert.ok(landGatesSchema.safeParse({ lanes: [entry] }).success);
  assert.ok(!landGatesSchema.safeParse({ lanes: [{ ...entry, ran: 'abc' }] }).success);
  assert.deepEqual(landGateGuardEvidence(JSON.stringify({ lanes: [entry] })), {
    preflightRan: ranEvidence([GUARD]),
    preflightRuns: 2,
  });
  const { ran: _ran, runs: _runs, ...older } = entry;
  assert.deepEqual(landGateGuardEvidence(JSON.stringify({ lanes: [older] })), {}, 'older CLI: nothing kept');
  assert.deepEqual(landGateGuardEvidence(undefined), {});
});

test('candidates read p over the last 50 outcomes, never before the speed record, and shrink as landings pass', () => {
  const doc = failures(
    [check(GUARD), { ran: '', runs: 1 }],
    [check(GUARD, 'tests/once.test.mjs'), { ran: '', runs: 3 }],
    [check(), { ran: '' }],
  );
  const landed = Array.from({ length: 5 }, (_, i) => now - 9000 + i);
  const set = guardCandidates(doc, landed, now);
  assert.deepEqual(
    { outcomes: set.outcomes, failed: set.failed, C: set.C, r: set.r, runnerMinutes: set.runnerMinutes },
    { outcomes: 8, failed: 3, C: 840, r: 2, runnerMinutes: 60 },
  );
  assert.deepEqual(set.files, [{ file: GUARD, failures: 2, checkSeconds: 2 }], 'one failure may be a flake');
  assert.equal(guardCandidates(doc, landed, now).rev, set.rev, 'stable revision');
  // Too few landings to divide by (a new project): p does not count yet.
  assert.deepEqual(guardCandidates(doc, landed.slice(1), now).files, []);
  // A reset or capped record: failures older than its oldest landing are outside what it can count,
  // so they never inflate p (a reset record holding one landing would otherwise read p = 2/3).
  const reset = guardCandidates(doc, [now - 500], now);
  assert.deepEqual([reset.outcomes, reset.files], [1, []]);
  assert.notEqual(reset.rev, set.rev);
  // Fifty passing landings after the failures push them out of the window: the set empties.
  const later = Array.from({ length: 50 }, (_, i) => now + 1 + i);
  assert.deepEqual(guardCandidates(doc, [...landed, ...later], now + 100).files, []);
  // A project with no record yet, or a garbage document: an empty set, still with a revision.
  assert.deepEqual(guardCandidates(undefined, [], now).files, []);
  assert.deepEqual(guardCandidates('{not json', landed, now).files, []);
  assert.ok(JSON.parse(addGuardFailure('{not json', check(GUARD), { ran: '' }, now)).failures.length === 1);
});

test('the gate sends ran only when this head was preflighted and its evidence is readable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-guard-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(root, { recursive: true });
  const cache = join(`${root}.forge-client`, 'agent', 'preflight');
  mkdirSync(join(cache, 'evidence'), { recursive: true });
  const evidence = gzipSync(JSON.stringify({ definition: 'x', files: [], inventory: [], covered: [GUARD] }));
  const write = digestOf =>
    writeFileSync(join(cache, `${laneId}.json`), JSON.stringify({ evidence: digestOf }));
  const receipt = {};
  // No preflight receipt, or one for another head: unknown, so `ran` is left out (never '').
  assert.deepEqual(guardGateFields(root, laneId, null, false), { runs: 0 });
  assert.deepEqual(guardGateFields(root, laneId, receipt, false), { runs: 0 });
  // This head's preflight with evidence missing, unreadable or not matching its digest: unknown.
  assert.deepEqual(guardGateFields(root, laneId, receipt, true), { runs: 0 });
  write(digest(evidence));
  assert.deepEqual(guardGateFields(root, laneId, receipt, true), { runs: 0 }, 'no evidence file yet');
  writeFileSync(join(cache, 'evidence', `${digest(evidence)}.gz`), Buffer.from('corrupt'));
  assert.deepEqual(guardGateFields(root, laneId, receipt, true), { runs: 0 });
  writeFileSync(join(cache, 'evidence', `${digest(evidence)}.gz`), evidence);
  recordPreflightRun(root, laneId);
  recordPreflightRun(root, laneId);
  // Readable evidence of this head: the files it covered, and this Lane's local runs.
  assert.deepEqual(guardGateFields(root, laneId, receipt, true), { ran: ranEvidence([GUARD]), runs: 2 });
  // A preflight of this head that ran static checks only ran no tests: '' (every failing test skipped).
  assert.deepEqual(guardGateFields(root, laneId, { staticOnly: true }, true), { ran: '', runs: 2 });
  // Several Lanes in one landing: unknown if any one's is unknown, else the union.
  const lane = (id, ran) => ({
    laneId: id,
    head: 'a'.repeat(64),
    preflight: 'passed',
    ...(ran === undefined ? {} : { ran }),
    runs: 1,
  });
  const other = '33333333-3333-4333-8333-333333333333';
  assert.equal(
    landGateGuardEvidence(JSON.stringify({ lanes: [lane(laneId, ranEvidence([GUARD])), lane(other)] }))
      .preflightRan,
    undefined,
  );
  assert.equal(
    landGateGuardEvidence(JSON.stringify({ lanes: [lane(laneId, ranEvidence([GUARD])), lane(other, '')] }))
      .preflightRan,
    ranEvidence([GUARD]),
  );
});

const candidates = (files, extra = {}) => ({
  rev: 'r1',
  outcomes: 5,
  failed: 2,
  C: 840,
  r: 1,
  runnerMinutes: 60,
  files,
  ...extra,
});
function lane(t, bytes = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-guard-set-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    'package.json': '{"type":"module","scripts":{}}',
    'scripts/forge-check.mjs': '',
    'src/a.ts': 'export const n = 1;',
    'tests/a.test.mjs': "import '../src/a.ts';",
    // Reads the repository by path, so no import edge reaches it from src/a.ts.
    [GUARD]: "import test from 'node:test'; test('schema', () => {});",
    ...bytes,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = Object.entries(all).map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = (options = {}, paths = ['src/a.ts']) =>
    preflightPlan(root, { paths, complete: true }, { laneId, files }, options);
  return { root, plan };
}

test("learned guards get only what declared guards and the change's own tests leave of the budget", t => {
  const { root, plan } = lane(t);
  storeGuardCandidates(root, candidates([{ file: GUARD, failures: 2, checkSeconds: 2 }]));
  const changed = ['src/a.ts', 'tests/a.test.mjs'];
  const full = plan({}, changed).local.guardSet;
  // The changed test's seconds are reserved first.
  const reserved = 180 - full.capSeconds;
  assert.ok(reserved > 0 && full.tests.includes(GUARD));
  // A budget the change's own test fills: the guard stays out and the changed test still runs.
  const tight = plan({ budgetSeconds: reserved + 1 }, changed);
  assert.deepEqual(tight.local.guardSet.tests, []);
  assert.ok(tight.tests.includes('tests/a.test.mjs'));
  assert.ok(plan({ budgetSeconds: reserved + 3 }, changed).local.guardSet.tests.includes(GUARD));
  // What is left is shown to a tenth of a second, never as a long fraction (seen live 2026-11-19).
  const odd = plan({ budgetSeconds: reserved + 2.123456789 }, changed).local.guardSet;
  assert.equal(odd.capSeconds, Math.round(odd.capSeconds * 10) / 10);
  assert.doesNotMatch(odd.reason, /\d\.\d{2,} s budget/);
});

test('every checkout of a project finds its set: the clone, its Lanes and a Lane at a custom path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-guard-cache-'));
  const state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dir, 'state');
  t.after(() => {
    if (state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = state;
    rmSync(dir, { recursive: true, force: true });
  });
  const projectId = `p${process.pid}x${Date.now()}`;
  const checkout = (path, marker, selection) => {
    mkdirSync(join(dir, path, '.forge'), { recursive: true });
    writeFileSync(join(dir, path, '.forge', marker), JSON.stringify({ selection }));
    return join(dir, path);
  };
  const clone = checkout('clone', 'hosted-main.json', { projectId, channel: 'main' });
  const custom = checkout('elsewhere/my-lane', 'hosted-lane.json', { projectId, laneId: 'l' });
  const other = checkout('other', 'hosted-main.json', { projectId: `${projectId}y` });
  storeGuardCandidates(clone, candidates([{ file: GUARD, failures: 2, checkSeconds: 2 }]));
  assert.equal(cachedGuardRevision(custom), 'r1', 'a Lane outside <clone>.forge-client/lanes finds it');
  assert.equal(guardCachePath(custom), guardCachePath(clone));
  assert.equal(cachedGuardRevision(other), '', 'another project never reads it');
  // No marker names a project: beside the checkout, as before.
  assert.match(guardCachePath(join(dir, 'bare')), /bare\.forge-client/);
  // A Lane folder open has no marker yet: the command's project names the same copy.
  assert.equal(guardCachePath(join(dir, 'bare'), projectId), guardCachePath(clone));
  // open, preflight and land ask only when this machine's copy is over an hour old; a reply saying
  // it is current marks it fresh again. No copy at all: ask with the empty revision.
  assert.equal(guardRevisionToAsk(clone, projectId), undefined, 'just written: fresh');
  const old = new Date(Date.now() - 2 * 3600_000);
  utimesSync(guardCachePath(clone), old, old);
  assert.equal(guardRevisionToAsk(clone, projectId), 'r1');
  storeGuardCandidates(clone, null, projectId);
  assert.equal(guardRevisionToAsk(clone, projectId), undefined);
  assert.equal(guardRevisionToAsk(join(dir, 'bare'), `${projectId}z`), '');
});

test('a delivered guard runs first in every preflight, inside the budget, with why', t => {
  const { root, plan } = lane(t);
  assert.ok(!plan().tests.includes(GUARD), 'the import graph never selects it');
  // Before any start delivered the project set (a fresh sandbox's very first plan): empty.
  assert.deepEqual(plan().local.guardSet.tests, []);
  assert.match(
    plan().local.guardSet.reason,
    /no start, open, preflight or land on this machine has fetched .*\(looked in /,
  );
  assert.equal(cachedGuardRevision(root), '');
  storeGuardCandidates(root, candidates([{ file: GUARD, failures: 2, checkSeconds: 2 }]));
  assert.equal(cachedGuardRevision(root), 'r1');
  const after = plan();
  assert.equal(after.tests[0], GUARD);
  assert.deepEqual(
    after.local.guards.map(guard => [guard.name, guard.tests]),
    [['learned guard set', [GUARD]]],
  );
  const [why] = after.local.guardSet.files;
  // p = 2 of 5 outcomes; C = 840 s submit to verdict; r = 1; t = the check's 2 s.
  assert.deepEqual(
    { file: why.file, failures: why.failures, p: why.p, C: why.C, r: why.r, t: why.t, basis: why.tBasis },
    { file: GUARD, failures: 2, p: 0.4, C: 840, r: 1, t: 2, basis: 'check' },
  );
  assert.equal(why.saving, 334);
  assert.deepEqual(after.local.guardSet.window, {
    revision: 'r1',
    outcomes: 5,
    failed: 2,
    runnerMinutes: 60,
  });
  // An adaptive setting declares its signal, formula, bounds, override, reason, judge and interactions.
  const setting = after.local.guardSet.setting;
  assert.equal(setting.default, 'automatic');
  for (const field of ['signal', 'formula', 'bounds', 'override', 'reason', 'judgedOn'])
    assert.ok(setting[field].length > 20, field);
  assert.match(setting.signal, /held on the server/);
  assert.ok(setting.touches.some(item => /180 s/.test(item)));
  assert.match(after.local.summary, /Guard set Automatic from the project's last 5 landing outcome\(s\)/);
  // 593fc2d7: the project-wide failure count reads as history, never as this run's result.
  assert.match(
    after.local.summary,
    /\(project history, not this run: 2 of them failed their landing check\)/,
  );
  assert.match(
    after.local.summary,
    /schema-guard\.test\.mjs \(2 landing failures, p 0\.4 x C 840 s \/ r 1 - t 2 s = \+334 s\)/,
  );
  // Guards count inside the budget: a 1 s budget leaves the guard out rather than overrunning it.
  assert.deepEqual(plan({ budgetSeconds: 1 }).local.guardSet.tests, []);
  // A rerun of stopped files runs exactly those, with no guard added.
  assert.equal(plan({ only: ['tests/a.test.mjs'] }).local.guardSet, undefined);
  // The start reply that carried them parses on this CLI; a malformed one is dropped, never fatal.
  const guardSetField = hostedStartResultSchema.shape.guardSet;
  assert.deepEqual(guardSetField.parse(candidates([])), candidates([]));
  assert.equal(guardSetField.parse({ rev: 'r1', files: 'garbage' }), undefined);
  assert.equal(guardSetField.parse(undefined), undefined);
});

test('the set shrinks as runs and slower files make a guard cost more than it saves', () => {
  const options = { isTest: () => true, localSeconds: () => undefined, defaultSeconds: 5, capSeconds: 180 };
  const set = candidates(
    [
      { file: 'tests/x.test.mjs', failures: 2, checkSeconds: 20 },
      { file: 'tests/y.test.mjs', failures: 2, checkSeconds: 170 },
    ],
    { outcomes: 10 },
  );
  // p 0.2 x C 840 = 168 s: x (20 s) and y (170 s) both save, but only x fits the 180 s budget first.
  assert.deepEqual(
    learnGuardSet(set, options).picked.map(row => [row.file, row.saving]),
    [['tests/x.test.mjs', 148]],
  );
  // Ten preflight runs per landing: 16.8 s saved per run no longer pays for a 20 s file.
  assert.deepEqual(learnGuardSet({ ...set, r: 10 }, options).picked, []);
  // Measured slower here: the file leaves.
  assert.deepEqual(learnGuardSet(set, { ...options, localSeconds: () => 200 }).picked, []);
  assert.deepEqual(learnGuardSet(null, options).picked, []);
});

test('manual pins only pinned files and names what Automatic would pick; off runs none; unpin never learns', t => {
  const config = guardSet =>
    JSON.stringify({ type: 'module', scripts: {}, forge: { preflight: { guardSet } } });
  const pinned = 'tests/pinned.test.mjs';
  const body = "import test from 'node:test'; test('p', () => {});";
  const make = guardSet => {
    const made = lane(t, { 'package.json': config(guardSet), [pinned]: body });
    storeGuardCandidates(made.root, candidates([{ file: GUARD, failures: 2, checkSeconds: 2 }]));
    return made;
  };
  const plan = make({ mode: 'manual', pin: [pinned] }).plan();
  assert.deepEqual(plan.local.guardSet.tests, [pinned]);
  assert.deepEqual(plan.local.guardSet.automatic, [GUARD]);
  assert.equal(plan.tests[0], pinned);
  assert.match(
    plan.local.summary,
    /Guard set manual \(forge\.preflight\.guardSet\): 1 pinned file\(s\); Automatic would pick tests\/schema-guard/,
  );
  const off = make({ mode: 'off' });
  assert.deepEqual(off.plan().local.guardSet.tests, []);
  assert.ok(!off.plan().tests.includes(GUARD));
  assert.deepEqual(make({ unpin: [GUARD], pin: [pinned] }).plan().local.guardSet.tests, [pinned]);
  // A malformed setting or a pin the project lacks fails the plan loudly, naming the setting.
  for (const bad of [{ mode: 'sometimes' }, { pin: ['tests/gone.test.mjs'] }, { extra: true }, []])
    assert.match(make(bad).plan().reason, /forge\.preflight\.guardSet/);
  // One environment's override (the bench pins comparison cells off) wins over the file, names
  // itself and keeps the declared pins; a value it does not know fails the plan the same way.
  const prior = process.env.FORGE_PREFLIGHT_GUARD_SET;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_PREFLIGHT_GUARD_SET;
    else process.env.FORGE_PREFLIGHT_GUARD_SET = prior;
  });
  process.env.FORGE_PREFLIGHT_GUARD_SET = 'off';
  const forced = make({ pin: [pinned] }).plan();
  assert.deepEqual(forced.local.guardSet.tests, []);
  assert.ok(!forced.tests.includes(GUARD));
  assert.match(
    forced.local.guardSet.reason,
    /Guard set off \(FORGE_PREFLIGHT_GUARD_SET\); Automatic would pick tests\/schema-guard/,
  );
  process.env.FORGE_PREFLIGHT_GUARD_SET = 'manual';
  assert.deepEqual(make({ pin: [pinned] }).plan().local.guardSet.tests, [pinned]);
  process.env.FORGE_PREFLIGHT_GUARD_SET = 'sometimes';
  assert.match(make({}).plan().reason, /FORGE_PREFLIGHT_GUARD_SET must be automatic, manual or off/);
  delete process.env.FORGE_PREFLIGHT_GUARD_SET;
});

test('any declared runner gets the learned set too, and runs are counted per Lane for the gate', t => {
  const runnerJson = JSON.stringify({
    preflight: { tests: { glob: 'spec/**/*.spec.ts', command: ['vp', 'test', 'run', '{files}'] } },
  });
  const spec = 'spec/schema.spec.ts';
  const dir = mkdtempSync(join(tmpdir(), 'forge-guard-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  for (const [path, body] of Object.entries({
    'forge.json': runnerJson,
    'src/a.ts': 'export const a = 1;',
    'spec/a.spec.ts': "import '../src/a';",
    [spec]: 'export {};',
  })) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  storeGuardCandidates(root, candidates([{ file: spec, failures: 2, checkSeconds: null }]));
  const plan = preflightPlan(root, { paths: ['src/a.ts'], complete: true });
  assert.equal(plan.tests[0], spec);
  assert.deepEqual(plan.local.guardSet.tests, [spec]);
  assert.deepEqual(
    plan.local.guards.map(guard => guard.name),
    ['learned guard set'],
  );
  assert.equal(guardGateFields(root, laneId, null, false).runs, 0);
  recordPreflightRun(root, laneId);
  recordPreflightRun(root, laneId);
  assert.equal(guardGateFields(root, laneId, null, false).runs, 2);
});
