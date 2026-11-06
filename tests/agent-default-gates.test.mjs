// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceTree } from '../dist/source-tree.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { ackAnswers, checkpointNudge, finishGates, unsavedMinutes } from '../dist/agent-default-gates.js';
import { liveLanding, ownsLiveLanding } from '../dist/landing-freeze.js';
import { digest } from '../dist/hash.js';
import { recordTurnWork, settleTurnWork } from '../dist/agent-turn-work.js';
import {
  preflightPlan,
  readPreflightReceipt,
  runPreflight,
  preflightRuntime,
} from '../dist/agent-preflight.js';

const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

const lane = {
  laneId: '11111111-1111-4111-8111-111111111111',
  head: 'a'.repeat(64),
};
const defaults = overrides => effectiveAgentDefaults(overrides);
const notice = (file, noticeId = `n-${file}`) => ({
  noticeId,
  file,
  class: 'blocking',
});
const advice = ({ notices = [], paths = ['tests/b.test.mjs'], complete = true } = {}) => ({
  unacknowledgedOverlaps: { items: notices },
  changedPaths: { paths, complete },
});
function repo(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gates-')),
    root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    'package.json': '{"type":"module"}',
    'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => {});\n",
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
const code = value => error => error.code === value || error.data?.code === value;

test('overlapGate: block refuses with the ack command, warn advises, off ignores; nothing without notices', t => {
  const root = repo(t);
  const pending = advice({ notices: [notice('src/x.ts')] });
  const off = { preflight: 'off' };
  assert.throws(
    () => finishGates(root, defaults({ ...off }), lane, pending),
    error =>
      code('OVERLAP_UNANSWERED')(error) &&
      error.message.includes('src/x.ts') &&
      error.message.includes(`ack '{"laneId":"${lane.laneId}"}'`),
  );
  const warned = finishGates(root, defaults({ ...off, overlapGate: 'warn' }), lane, pending);
  assert.equal(warned.overlap.status, 'unanswered');
  assert.deepEqual(warned.overlap.files, ['src/x.ts']);
  assert.deepEqual(finishGates(root, defaults({ ...off, overlapGate: 'off' }), lane, pending), {});
  assert.deepEqual(finishGates(root, defaults(off), lane, advice()), {});
  assert.deepEqual(finishGates(root, undefined, lane, pending), {}, 'older server: no defaults, no gate');
});

test('preflight: require refuses with the set and estimate; a passing run for this head lets finish through', t => {
  const root = repo(t);
  const gates = d => finishGates(root, defaults(d), lane, advice());
  assert.throws(
    () => gates({}),
    error =>
      code('PREFLIGHT_REQUIRED')(error) &&
      /Run the 1 affected test file\(s\) for saved head a{12} first \(about 1 min\)/.test(error.message) &&
      error.message.includes(`preflight '{"laneId":"${lane.laneId}"}'`),
  );
  const advised = gates({ preflight: 'advise' });
  assert.equal(advised.preflight.status, 'advised');
  assert.deepEqual(advised.preflight.selected, ['tests/b.test.mjs']);
  const over = gates({ preflightMaxMinutes: 0 });
  assert.equal(over.preflight.status, 'advised');
  assert.equal(over.preflight.reason, 'over 0 min');
  assert.deepEqual(gates({ preflight: 'off' }), {});
  // Missing data never blocks: unknown changed paths become an advisory.
  const unknown = finishGates(root, defaults({}), lane, advice({ complete: false }));
  assert.equal(unknown.preflight.status, 'unavailable');
  assert.deepEqual(finishGates(root, defaults({}), lane, advice({ paths: [] })), {}, 'empty selection');
  // Run it: the receipt is recorded for this saved head only.
  const plan = preflightPlan(root, advice().changedPaths);
  assert.equal(plan.status, 'planned');
  assert.match(plan.command, /^node --test --test-concurrency=1 tests\/b\.test\.mjs$/);
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, true);
  assert.deepEqual(readPreflightReceipt(root, lane.laneId), receipt);
  assert.equal(gates({}).preflight.status, 'passed');
  assert.throws(
    () => finishGates(root, defaults({}), { ...lane, head: 'b'.repeat(64) }, advice()),
    code('PREFLIGHT_REQUIRED'),
    'a new saved head needs a new run',
  );
});

test('preflight: a failing run is recorded, and finish says the last run failed', t => {
  const root = repo(t, {
    'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => { throw new Error('red'); });\n",
  });
  const plan = preflightPlan(root, advice().changedPaths);
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.throws(
    () => finishGates(root, defaults({}), lane, advice()),
    error => code('PREFLIGHT_REQUIRED')(error) && error.message.includes('Its last run failed.'),
  );
});

test('ack answers every pending notice with ids that replay exactly', () => {
  const pending = advice({
    notices: [notice('a.ts', 'n1'), notice('b.ts', 'n2')],
  });
  const first = ackAnswers(lane.laneId, pending, 'accept-order');
  assert.deepEqual(
    first.map(answer => [answer.noticeId, answer.choice]),
    [
      ['n1', 'accept-order'],
      ['n2', 'accept-order'],
    ],
  );
  assert.deepEqual(ackAnswers(lane.laneId, pending, 'accept-order'), first, 'stable operation ids');
  assert.notEqual(first[0].operationId, first[1].operationId);
  assert.equal(
    ackAnswers(lane.laneId, pending, 'split', 'moved to its own Lane')[0].text,
    'moved to its own Lane',
  );
});

test('checkpoint nudge: unsavedFor from local file times, nudge past the threshold, none when off', t => {
  const root = repo(t, {
    '.forge/hosted-lane.json': '{}',
    'node_modules/x/index.js': '',
  });
  const saved = Date.parse('2026-10-30T20:00:00.000Z') / 1000;
  utimesSync(join(root, '.forge/hosted-lane.json'), saved, saved);
  for (const path of ['package.json', 'tests/b.test.mjs'])
    utimesSync(join(root, path), saved - 60, saved - 60);
  utimesSync(join(root, 'node_modules/x/index.js'), saved + 10, saved + 10);
  const now = (saved + 45 * 60) * 1000;
  assert.equal(unsavedMinutes(root, now), null, 'ignored directories never count');
  utimesSync(join(root, 'tests/b.test.mjs'), saved + 5 * 60, saved + 5 * 60);
  const minutes = unsavedMinutes(root, now);
  assert.equal(minutes, 40);
  const nudged = checkpointNudge(root, lane.laneId, defaults({}), minutes);
  assert.equal(nudged.unsavedFor, 40);
  assert.match(nudged.nudge, /^Unsaved edits for 40 min; save now: nforge agent .* save '\{"laneId":/);
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({}), 10), {
    unsavedFor: 10,
  });
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({ checkpointNudgeMinutes: 0 }), 400), {
    unsavedFor: 400,
  });
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({}), null), {});
  assert.equal(unsavedMinutes(join(root, 'missing')), null, 'no checkout marker: nothing to say');
});

test('build outputs and other ignored files written after a save are never unsaved edits (c338ef0d)', t => {
  // A first build:core after a save writes the gitignored convex/_generated/api.d.ts (and tsc may
  // write *.tsbuildinfo). Preflight then refused with LANE_DIRTY until a no-op save moved the marker.
  const root = repo(t, {
    '.forge/hosted-lane.json': '{}',
    '.gitignore': 'convex/_generated/api.d.ts\n*.tsbuildinfo\nbuild/\n',
    'convex/_generated/api.d.ts': 'generated',
    'tsconfig.tsbuildinfo': '{}',
    'build/out.js': '',
    'dist/cli.js': '',
  });
  const saved = Date.parse('2026-11-06T06:00:00.000Z') / 1000,
    now = (saved + 10 * 60) * 1000;
  utimesSync(join(root, '.forge/hosted-lane.json'), saved, saved);
  for (const path of ['package.json', 'tests/b.test.mjs', '.gitignore'])
    utimesSync(join(root, path), saved - 60, saved - 60);
  for (const path of ['convex/_generated/api.d.ts', 'tsconfig.tsbuildinfo', 'build/out.js', 'dist/cli.js'])
    utimesSync(join(root, path), saved + 60, saved + 60);
  assert.equal(unsavedMinutes(root, now), null, 'ignored and generated files are not edits');
  // A real new source file still is.
  writeFileSync(join(root, 'tests/new.test.mjs'), 'new');
  utimesSync(join(root, 'tests/new.test.mjs'), saved + 2 * 60, saved + 2 * 60);
  assert.equal(unsavedMinutes(root, now), 8);
});

test('preflight survives a different saved head with identical content; content, path and mode changes refuse', t => {
  const root = repo(t);
  const files = [
    { path: 'tests/b.test.mjs', blob: '1'.repeat(64), mode: 'file' },
    { path: 'src/value.ts', blob: '2'.repeat(64), mode: 'file' },
  ];
  const tree = sourceTree(files);
  const receipt = runPreflight(
    root,
    lane.laneId,
    lane.head,
    preflightPlan(root, advice().changedPaths),
    tree,
  );
  const saved = {
    ...lane,
    head: 'b'.repeat(64),
    tree: sourceTree([...files].reverse()),
  };
  assert.equal(readPreflightReceipt(root, lane.laneId).tree, tree);
  assert.equal(finishGates(root, defaults({}), saved, advice()).preflight.status, 'passed');
  assert.equal(receipt.passed, true);
  for (const changed of [
    [{ ...files[0], blob: '3'.repeat(64) }, files[1]],
    [{ ...files[0], mode: 'executable' }, files[1]],
    [{ ...files[0], path: 'tests/renamed.test.mjs' }, files[1]],
    files.slice(1),
    [...files, { path: 'added', blob: '4'.repeat(64), mode: 'symlink' }],
  ]) {
    assert.throws(
      () => finishGates(root, defaults({}), { ...saved, tree: sourceTree(changed) }, advice()),
      code('PREFLIGHT_REQUIRED'),
    );
  }
  assert.throws(
    () => finishGates(root, defaults({}), { ...saved, tree: undefined }, advice()),
    code('PREFLIGHT_REQUIRED'),
  );
  assert.throws(
    () => finishGates(root, defaults({}), { ...saved, laneId: 'another-lane' }, advice()),
    code('PREFLIGHT_REQUIRED'),
  );
});

test('failed preflight still refuses after a same-content save', t => {
  const root = repo(t, {
    'tests/b.test.mjs': "import test from 'node:test'; test('fails', () => { throw Error('red'); });",
  });
  const tree = sourceTree([]);
  runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths), tree);
  assert.throws(
    () => finishGates(root, defaults({}), { ...lane, head: 'b'.repeat(64), tree }, advice()),
    error => code('PREFLIGHT_REQUIRED')(error) && error.message.includes('Its last run failed.'),
  );
});

test('land accepts the overlap answer in the same call and retains observed notices', t => {
  const root = repo(t);
  const pending = advice({
    notices: [{ noticeId: 'f'.repeat(64), file: 'src/a.ts', class: 'blocking' }],
  });
  const result = finishGates(root, defaults({ preflight: 'off' }), lane, pending, 'accept-order');
  assert.equal(result.overlap.status, 'answered');
  assert.equal(result.overlap.choice, 'accept-order');
  assert.deepEqual(result.overlap.notices, ['f'.repeat(64)]);
});

test('faster learned estimates never turn an advisory test set into a new mandatory run', t => {
  const files = Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [
      `tests/extra-${i}.test.mjs`,
      "import test from 'node:test'; test('fast',()=>{});\n",
    ]),
  );
  const root = repo(t, files),
    cache = root + '.forge-client';
  mkdirSync(join(cache, 'agent'), { recursive: true });
  writeFileSync(
    join(cache, 'agent/preflight-estimate.json'),
    JSON.stringify({
      schema: 1,
      laneId: lane.laneId,
      head: lane.head,
      tests: 80,
      selection: 'test-only',
      exitCode: 0,
      passed: true,
      durationMs: 100,
      at: new Date(0).toISOString(),
    }),
  );
  const result = finishGates(
    root,
    defaults({ preflightMaxMinutes: 5 }),
    lane,
    advice({ paths: Object.keys(files) }),
  );
  assert.equal(result.preflight.estimateMinutes, 1);
  assert.equal(result.preflight.status, 'advised');
  assert(result.preflight.tests >= 80);
});

test('fast learned timings fit every direct consumer in the local budget; the gate stays advisory', t => {
  const files = {
    'src/hub.ts': 'export const n = 1;',
    ...Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`tests/consumer-${i}.test.mjs`, "import '../dist/hub.js';\n"]),
    ),
  };
  const root = repo(t, files),
    cache = root + '.forge-client';
  mkdirSync(join(cache, 'agent'), { recursive: true });
  writeFileSync(
    join(cache, 'agent/preflight-estimate.json'),
    JSON.stringify({
      schema: 1,
      laneId: lane.laneId,
      head: lane.head,
      tests: 80,
      selection: 'test-only',
      exitCode: 0,
      passed: true,
      durationMs: 100,
      at: new Date(0).toISOString(),
    }),
  );
  const result = finishGates(
    root,
    defaults({ preflightMaxMinutes: 5 }),
    lane,
    advice({ paths: ['src/hub.ts'] }),
  );
  assert.equal(result.preflight.status, 'advised');
  assert.equal(result.preflight.tests, 80);
  assert.equal(result.preflight.deferredTests, 0);
  assert.equal(result.preflight.estimateMinutes, 1);
  assert.equal(result.preflight.totalEstimateMinutes, 1);
});

test('slow learned timings trim by time, and the advisory names the rule, the cut and the pre-queue check', t => {
  const files = {
    'src/hub.ts': 'export const n = 1;',
    ...Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`tests/consumer-${i}.test.mjs`, "import '../dist/hub.js';\n"]),
    ),
  };
  const root = repo(t, files),
    cache = root + '.forge-client';
  mkdirSync(join(cache, 'agent'), { recursive: true });
  writeFileSync(
    join(cache, 'agent/preflight-estimate.json'),
    JSON.stringify({
      schema: 1,
      laneId: lane.laneId,
      head: lane.head,
      tests: 80,
      selection: 'test-only',
      exitCode: 0,
      passed: true,
      durationMs: 800000,
      at: new Date(0).toISOString(),
    }),
  );
  const result = finishGates(
    root,
    defaults({ preflightMaxMinutes: 5 }),
    lane,
    advice({ paths: ['src/hub.ts'] }),
  );
  assert.equal(result.preflight.status, 'advised');
  // 10 s per file against the 180 s local budget: 18 files run here, the rest are scheduled.
  assert.equal(result.preflight.tests, 18);
  assert.equal(result.preflight.deferredTests, 62);
  assert.equal(result.preflight.estimateMinutes, 3);
  assert.equal(result.preflight.totalEstimateMinutes, 14);
  assert.match(result.preflight.local, /direct consumers/);
  assert.match(result.preflight.local, /Trimmed wide 18 of 80/);
  assert.match(
    result.preflight.local,
    /62 test file\(s\) deferred; they run in the pre-queue Lane check \(on by default/,
  );
});

for (const reason of [
  'no filesystem event within 1000 ms',
  'watcher process timed out',
  'watcher close did not acknowledge within 250 ms',
])
  test(`environment receipt keeps landing available for ${reason} and is pinned to source`, t => {
    const root = repo(t, {
      'tests/b.test.mjs': "throw Error('local test must not run while environment is unavailable');",
    });
    t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
      ...healthy,
      ok: false,
      reason,
    }));
    const receipt = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths));
    assert.equal(receipt.passed, false);
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.environment.category, 'ENVIRONMENT');
    assert.equal(receipt.environment.code, 'FILESYSTEM_EVENTS_UNHEALTHY');
    assert.match(receipt.environment.message, /fseventsd.*sudo killall fseventsd/);
    assert.match(receipt.environment.next, /nforge agent .* land --save/);
    assert.ok(receipt.environment.next.includes(lane.laneId));
    assert.equal(finishGates(root, defaults({}), lane, advice()).preflight.status, 'environment');
    assert.throws(
      () => finishGates(root, defaults({}), { ...lane, head: 'c'.repeat(64) }, advice()),
      code('PREFLIGHT_REQUIRED'),
    );
    // Recovery replaces the environment receipt; ordinary failures still refuse landing.
    t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy);
    writeFileSync(
      join(root, 'tests/b.test.mjs'),
      "import test from 'node:test'; test('recovered', () => {});",
    );
    const recovered = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths));
    assert.equal(recovered.passed, true);
    assert.equal(recovered.environment, undefined);
    assert.equal(finishGates(root, defaults({}), lane, advice()).preflight.status, 'passed');
  });

test('event delivery lost during a failed local run is classified separately from healthy-environment test failures', t => {
  const root = repo(t, {
    'tests/b.test.mjs': "throw Error('synthetic watcher failure');",
  });
  let probes = 0;
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () =>
    ++probes === 1 ? healthy : { ...healthy, ok: false, reason: 'no events' },
  );
  const receipt = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths));
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.environment.category, 'ENVIRONMENT');
  assert.equal(probes, 2);
});

test('an unhealthy diagnostic never converts a build failure into an environment advisory', t => {
  const root = repo(t, {
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { 'build:core': 'node -e "process.exit(1)"' },
    }),
  });
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => {
    throw Error('must not probe after a build failure');
  });
  const receipt = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths));
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.environment, undefined);
  assert.throws(() => finishGates(root, defaults({}), lane, advice()), code('PREFLIGHT_REQUIRED'));
});

test('environment advisories preserve tree identity and overlap gates', t => {
  const root = repo(t);
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ...healthy,
    ok: false,
    reason: 'no events',
  }));
  const tree = sourceTree([]);
  runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice().changedPaths), tree);
  const saved = { ...lane, head: 'b'.repeat(64), tree };
  assert.equal(finishGates(root, defaults({}), saved, advice()).preflight.status, 'environment');
  assert.throws(
    () => finishGates(root, defaults({}), { ...saved, tree: 'c'.repeat(64) }, advice()),
    code('PREFLIGHT_REQUIRED'),
  );
  assert.throws(
    () => finishGates(root, defaults({}), saved, advice({ notices: [notice('src/x.ts')] })),
    code('OVERLAP_UNANSWERED'),
  );
});

// Issue cd503b40 (friction 294f86bf): observe emitted unsavedFor:33 and a save-now nudge on a
// clean saved Lane while its source-frozen finish was live.
test('save advice reflects real unsaved bytes and never nudges a live landing', t => {
  const body = "import test from 'node:test';\ntest('b', () => {});\n";
  const root = repo(t, { '.forge/hosted-lane.json': '{}' });
  const marker = {
    schema: 1,
    kind: 'forge-hosted-lane-checkout',
    url: 'https://fixture.invalid',
    operationId: '22222222-2222-4222-8222-222222222222',
    selection: {
      schema: 2,
      projectId: 'p',
      laneId: lane.laneId,
      intentId: '33333333-3333-4333-8333-333333333333',
      head: lane.head,
      version: 1,
      sourceVersion: 1,
      lifecycleVersion: 0,
      state: 'active',
      base: { head: 'b'.repeat(64), receiptId: '44444444-4444-4444-8444-444444444444' },
      authority: { mode: 'server', epoch: 1 },
    },
    state: {
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [
        { path: 'package.json', blob: digest('{"type":"module"}'), mode: 'file' },
        { path: 'tests/b.test.mjs', blob: digest(body), mode: 'file' },
      ],
      message: 'saved',
      at: '2026-11-05T12:00:00.000Z',
    },
    scope: null,
    materialized: [],
  };
  writeFileSync(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
  const saved = Date.parse('2026-11-05T12:00:00.000Z') / 1000,
    now = (saved + 45 * 60) * 1000;
  utimesSync(join(root, '.forge/hosted-lane.json'), saved, saved);
  utimesSync(join(root, 'package.json'), saved - 60, saved - 60);
  // Clean saved Lane: the file was rewritten after the save (materialized, formatter) with the
  // same bytes. Not an edit.
  writeFileSync(join(root, 'tests/b.test.mjs'), body);
  utimesSync(join(root, 'tests/b.test.mjs'), saved + 12 * 60, saved + 12 * 60);
  assert.equal(unsavedMinutes(root, now), null, 'identical bytes are saved source');
  // Dirty work: a real edit counts from its own time.
  writeFileSync(join(root, 'package.json'), '{"type":"module","x":1}');
  utimesSync(join(root, 'package.json'), saved + 5 * 60, saved + 5 * 60);
  assert.equal(unsavedMinutes(root, now), 40);
  // A new file is unsaved work too.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'tests/new.test.mjs'), 'new');
  utimesSync(join(root, 'tests/new.test.mjs'), saved + 15 * 60, saved + 15 * 60);
  assert.equal(unsavedMinutes(root, now), 30);
  // Live finish: report the time, never advise a checkpoint that would supersede the landing.
  const live = {
    phase: 'finish',
    submission: { phase: 'ready' },
    inProgress: true,
    next: { action: 'wait', operationIds: ['55555555-5555-4555-8555-555555555555'], until: 'acceptance' },
  };
  assert.equal(liveLanding(live), true);
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({}), 40, liveLanding(live)), {
    unsavedFor: 40,
  });
  // Terminal finish (no wait left) or a non-landing reply: the nudge returns.
  const landed = { phase: 'finish', submission: { phase: 'landed' } };
  assert.equal(liveLanding(landed), false);
  assert.equal(liveLanding({ inProgress: true, next: { action: 'wait', runId: 'r' } }), false);
  assert.match(checkpointNudge(root, lane.laneId, defaults({}), 40, liveLanding(landed)).nudge, /save now/);
  // This session's own recorded landing from this checkout also freezes advice (ledger read only).
  assert.equal(ownsLiveLanding(root, ''), false, 'no session: nothing recorded');
  const state = mkdtempSync(join(tmpdir(), 'forge-gates-state-')),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  const id = '66666666-6666-4666-8666-666666666666';
  assert.equal(ownsLiveLanding(root, 'session-a'), false);
  recordTurnWork({ id, kind: 'landing', root, input: { operationIds: [id] }, pid: null }, 'session-a');
  assert.equal(ownsLiveLanding(root, 'session-a'), true);
  assert.equal(ownsLiveLanding(root, 'session-b'), false, 'another session owns nothing here');
  settleTurnWork([id], 'session-a');
  assert.equal(ownsLiveLanding(root, 'session-a'), false, 'terminal landing clears the freeze');
});
