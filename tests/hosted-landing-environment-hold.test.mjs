// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0d14c456 (from bf111983 line 4): under isolation=user every scoped check exited 126 with the same
// environment error (the packages runner was not runnable for the Candidate user), and the queue kept
// dispatching new runs of it. The CI-down hold (switch FORGE_QUEUE_HOLD_ON_CI_DOWN) now counts identical
// environment ends of one check command: after three, the next entry with that check parks before any
// run, under one reason that names the failing line and the resume step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { landingHold, holdLines } = await import(moduleUrl('../src/hosted-landing-hold.ts'));
const { environmentEnd, checkCommandKey, normalizeFailureLine } = await import(
  moduleUrl('../src/check-environment-failure.ts')
);
const { ENVIRONMENT_STREAK } = await import(moduleUrl('../convex/projectHostedLandingCiDown.ts'));
const { heldCommand } = await import(moduleUrl('../convex/projectHostedLandingEnvironmentHold.ts'));
const SWITCH = 'FORGE_QUEUE_HOLD_ON_CI_DOWN';
const PROBE = 'projectHostedLandingCiDown:probe';
const prior = Object.fromEntries([...Object.keys(synthetic), SWITCH].map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.afterEach(() => delete process.env[SWITCH]);
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** mkdtemp appends six random [A-Za-z0-9] characters: about 35% of real folders hold no digit (the review
 * of 0d14c456 found a digit-free name kept its own identity, so the hold missed a third of real failures,
 * and random test names made this file fail now and then). Fixed seeds, digit-free names first. */
const folders = ['xQzTbR', 'abcdef', 'k9Lm2p', 'WWWWWW', '123456', 'a1B2c3'];
let folderTurn = 0;
const nextFolder = () => folders[folderTurn++ % folders.length];

/** What the bf111983 job printed: bash's own 126 line, then the sandbox's access note. The temp folder
 * name differs per run (mkdtemp), so identity must not depend on it. */
const denied = folder =>
  `forge packages: js: npm run test --workspace=packages/a\nbash: line 1: $RUNNER_TEMP/forge-packages-${folder}/run: Permission denied\nForge: $RUNNER_TEMP/forge-packages-${folder} is a check input Forge wrote for the Candidate user forge-check to read and run, not change; if it could not be read or run, that is a Forge fault, not the project's.`;

async function fixture(t, options) {
  folderTurn = 0;
  const f = await batchesFixture(t, { batching: false, ...options });
  f.rows = () => [...f.tables.projectHostedLandingRequests.values()].filter(r => r.projectId === f.projectId);
  f.queue = () => [...f.tables.projectHostedLandingQueues.values()].find(q => q.projectId === f.projectId);
  f.queued = () => f.runs().filter(r => r.status === 'queued');
  f.probes = () => f.pending().filter(task => task.name === PROBE);
  f.settle = async () => {
    for (let tick = 0; tick < 300; tick++) {
      const task = f.pending().find(item => item.name !== PROBE);
      if (!task) return;
      await f.execute(task);
    }
    assert.fail('the queue never settled');
  };
  /** One job exits with `summary` as its sealed failure tail, no test file failing. */
  f.failJob = async (run, summary, exitCode = 126) => {
    const active = await f.rawChecks.activate(run.id);
    f.tables.projectHostedOutputStreams.set(`stream-${run.id}`, {
      _id: `stream-${run.id}`,
      _creationTime: 1,
      projectId: f.projectId,
      runId: run.id,
      streamId: randomUUID(),
      descriptor: JSON.stringify({
        shard: 0,
        attempt: 0,
        executionId: 'synthetic',
        stream: 'stdout',
        name: '',
      }),
      chunks: 1,
      bytes: summary.length,
      maxSequence: 0,
      seal: JSON.stringify({ failureSummary: summary }),
    });
    await f.rawChecks.callback(f.rawChecks.shard(active, 0, 'failed', { exitCode }));
    await f.rawChecks.callback(f.rawChecks.complete(active, 'failed', { exitCode: 1 }));
  };
  /** Every queued check ends with the same environment error, one at a time. */
  f.brokenEnvironment = async () => {
    for (let round = 0; round < 20 && f.queued().length; round++) {
      const [run] = f.queued();
      await f.failJob(run, denied(nextFolder()));
      await f.settle();
    }
  };
  f.passAll = async () => {
    for (let round = 0; round < 20 && f.queued().length; round++) {
      for (const run of f.queued()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await f.settle();
    }
  };
  f.fireProbe = async () => {
    const [probe] = f.probes();
    assert(probe, 'a probe wake is armed');
    await f.execute(probe);
    await f.settle();
  };
  return f;
}
const held = f => f.rows().filter(r => r.hold === 'ci-down' && r.phase === 'queued' && r.runnable === false);
const phases = f => JSON.stringify(states(f).map(s => [s.phase, s.error?.code]));

test('incident replay bf111983 line 4 (Item 0d14c456): the fourth identical environment failure is not dispatched; the hold names the cause and the resume step', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  assert.equal(f.runs().length, ENVIRONMENT_STREAK, `one run per change ${phases(f)}`);
  assert(
    f.counts.some(c => c.readRangesByTable?.projectHostedOutputStreams),
    'the failure path reads the sealed streams (the healthy-path guard below is not vacuous)',
  );
  const ciDown = f.queue().ciDown;
  assert.equal(ciDown.cause, 'environment');
  assert.equal(ciDown.streak, ENVIRONMENT_STREAK);
  assert.equal(f.probes().length, 1, 'one slow probe wake keeps the held entries live');
  // The first two were judged before the pattern showed; the third is not this change's failure.
  assert.deepEqual(
    states(f).map(s => s.error?.code),
    ['CHECK_FAILED', 'CHECK_FAILED', 'CI_DOWN'],
  );

  // A fourth landing with the same check arrives: before, it dispatched its own run and failed the same way.
  await f.add(3);
  await f.settle();
  assert.equal(f.runs().length, ENVIRONMENT_STREAK, 'no fourth run');
  assert.equal(f.queued().length, 0);
  assert.equal(held(f).length, 2, phases(f));
  const state = states(f)[3];
  assert.equal(state.error.code, 'CI_DOWN');
  assert.match(state.error.message, /^The check environment is failing: the last 3 landing checks/);
  assert.match(
    state.error.message,
    /is a check input Forge wrote for the Candidate user/,
    'names the failing line',
  );
  assert.match(
    state.error.message,
    /Next: fix the runner or environment, then change the check or runner configuration/,
  );
  const hold = landingHold(state);
  assert.equal(hold.kind, 'ci-down');
  assert.match(holdLines(hold)[0], /^HELD: CHECK ENVIRONMENT IS FAILING; not landed yet/);
  assert.match(hold.next, /fixes the runner or its environment/);
});

test('incident replay bf111983 line 4 (Item 0d14c456): a cohort whose check environment fails waits under the hold instead of splitting into re-checks that fail the same way', async t => {
  const outage = async on => {
    if (on) process.env[SWITCH] = '1';
    else delete process.env[SWITCH];
    const f = await fixture(t, { count: 4, batching: true });
    await f.settle();
    await f.brokenEnvironment();
    return f;
  };
  // Before: the shared run failed, the cohort split and every child re-ran the same failing check.
  const before = await outage(false);
  assert(
    states(before).every(s => s.phase === 'terminal-failed'),
    phases(before),
  );
  const f = await outage(true);
  assert.equal(f.queue().ciDown.cause, 'environment');
  assert.equal(f.queued().length, 0, 'nothing left dispatched');
  assert(
    states(f).every(s => s.phase === 'queued' && s.error?.code === 'CI_DOWN'),
    `every change waits, none is judged on the environment ${phases(f)}`,
  );
  // Only checks already in flight when the third identical end tripped the hold still ran.
  assert(
    f.runs().length < before.runs().length,
    `${f.runs().length} runs with the hold, ${before.runs().length} without`,
  );
});

test('Item 0d14c456: a different failure on the probe clears the environment hold and the held changes check again', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  await f.add(3);
  await f.settle();
  assert.equal(held(f).length, 2);
  // The slow probe lets one held entry past the hold: one run, not two.
  await f.fireProbe();
  assert.equal(f.queued().length, 1, 'the probe dispatched one held entry');
  // The runner was fixed: this time a test fails (a verdict), so the hold ends.
  await f.fail(f.queued()[0].id);
  await f.settle();
  assert.equal(f.queue().ciDown, undefined, 'a different failure cleared the hold');
  assert.equal(f.probes().length, 0, 'nothing is left armed');
  assert.equal(f.queued().length, 1, 'the other held change checks again');
  await f.passAll();
  assert.equal(held(f).length, 0, phases(f));
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 1, phases(f));
});

const isolationRefused =
  'CANDIDATE_ISOLATION_UNAVAILABLE: project code cannot run as its own Candidate user here (no passwordless sudo), so the check fails before it runs.';

test('Item 0d14c456: a probe that fails on another environment line restarts the count and releases the other held change', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  await f.add(3);
  await f.settle();
  assert.equal(held(f).length, 2, 'two changes wait');
  await f.fireProbe();
  const [probed] = f.queued();
  assert(probed, 'the probe dispatched one held entry');
  await f.failJob(probed, isolationRefused);
  await f.settle();
  assert.equal(f.queue().ciDown.streak, 1, 'a new streak on the new line');
  assert.equal(held(f).length, 0, 'the old hold released what it held');
  assert.equal(f.queued().length, 1, 'the other held change dispatched');
});

test('Item 0d14c456: the probe permit belongs to the entry it released; a matching arrival still parks', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  const [probe] = f.probes();
  await f.execute(probe);
  const permit = f.queue().ciDown.probeOpen;
  assert.equal(permit, states(f)[2].id, 'the permit names the released submission');
  // Before the released entry is claimed, a new landing with the same check arrives.
  await f.add(3);
  await f.settle();
  assert.equal(f.queued().length, 1, 'one probe run, not two');
  assert.equal(states(f)[2].phase, 'checking', 'the released entry runs its probe check');
  assert.equal(states(f)[3].phase, 'queued', 'the arrival waits; it did not take the permit');
  const runs = f.runs().length;
  // The probe fails the same way: the arrival parks under the hold instead of running.
  await f.failJob(f.queued()[0], denied('probe1'));
  await f.settle();
  assert.equal(f.runs().length, runs, `no run for the arrival ${phases(f)}`);
  assert.equal(states(f)[3].error?.code, 'CI_DOWN', phases(f));
  assert.equal(f.queue().ciDown.probeOpen, undefined, 'the spent permit is closed');
});

test('Item 0d14c456: changing the check configuration is the resume step: the hold ends and held changes go back to the queue', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  assert.equal(held(f).length, 1);
  f.rawChecks.definition = await f.rawChecks.configure(
    {
      kind: 'definition',
      checkId: f.rawChecks.checkId,
      command: { name: 'verify', environmentLabel: 'clean', executable: 'bash', args: ['ci/fixed.sh'] },
    },
    f.rawChecks.definition.digest,
  );
  await f.settle();
  assert.equal(f.queue().ciDown, undefined, 'the settings change ended the hold');
  assert.equal(f.probes().length, 0, 'its probe is cancelled');
  assert.equal(held(f).length, 0, `nothing is left held ${phases(f)}`);
});

test('Item 0d14c456: a direct check the hold covers is refused at submission with the cause, not dispatched', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3, requestCheck: true });
  await f.settle();
  await f.brokenEnvironment();
  assert.equal(f.queue().ciDown?.streak, ENVIRONMENT_STREAK, phases(f));
  const runs = f.runs().length;
  await assert.rejects(f.add(3), error => {
    assert.match(error.message, /The check environment is failing/);
    return true;
  });
  assert.equal(f.runs().length, runs, 'no fourth run');
});

test('Item 0d14c456 (review): an infrastructure end does not inherit the environment hold; held changes go back to the queue', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.settle();
  await f.brokenEnvironment();
  await f.add(3);
  await f.settle();
  assert.equal(held(f).length, 2);
  await f.fireProbe();
  const [probed] = f.queued();
  await f.rawChecks.callback(
    f.rawChecks.complete(await f.rawChecks.activate(probed.id), 'runner-unavailable'),
  );
  await f.settle();
  assert.notEqual(f.queue().ciDown?.cause, 'environment', 'one infrastructure end starts its own count');
  assert.equal(held(f).length, 0, `the environment hold released what it held ${phases(f)}`);
});

test("Item 0d14c456 (review): a Lane's own script that exits 126 is the change's failure and never holds the queue", async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 4 });
  await f.settle();
  for (let round = 0; round < 20 && f.queued().length; round++) {
    await f.failJob(f.queued()[0], 'bash: line 1: ./scripts/build.sh: Permission denied');
    await f.settle();
  }
  assert.equal(f.runs().length, 4, 'every change got its own check');
  assert.equal(f.queue().ciDown, undefined);
  assert(
    states(f).every(s => s.error?.code === 'CHECK_FAILED'),
    phases(f),
  );
});

test('Item 0d14c456 (review): the identity ignores every mkdtemp suffix, including names with no digit', () => {
  const pins = {
    checkId: randomUUID(),
    expectedDefinition: 'a'.repeat(64),
    expectedConfiguration: 'b'.repeat(64),
    expectedEnvironment: 'c'.repeat(64),
  };
  const run = { status: 'failed', cancelRequested: false, request: pins };
  // mkdtemp suffixes are six [A-Za-z0-9] characters (digit-free in about 35% of cases); the rule that
  // strips ids by "has a letter and a digit" kept the digit-free ones as their own identity.
  const suffixes = ['xQzTbR', 'abcdef', 'WWWWWW', 'k9Lm2p', '123456', 'a1B2c3', 'ZZZZZ0'];
  const signatures = new Set(suffixes.map(suffix => environmentEnd(run, [denied(suffix)]).signature));
  assert.equal(signatures.size, 1, 'one identity for every folder name');
  // The same shape for every Forge-made temp folder name, whatever the prefix.
  for (const prefix of ['forge-packages-', 'forge-candidate-', 'forge-test-modules-'])
    assert.equal(
      normalizeFailureLine(`Forge: $RUNNER_TEMP/${prefix}xQzTbR/run is a check input`),
      normalizeFailureLine(`Forge: $RUNNER_TEMP/${prefix}k9Lm2p/run is a check input`),
      prefix,
    );
  // A hold stored before this rule (mixed suffix, generic rule only) keeps matching after an upgrade.
  const legacy = text =>
    text
      .replace(/\s+/g, ' ')
      .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{6,}\b/g, '#')
      .replace(/\d+/g, '0')
      .trim();
  for (const suffix of ['Ab12Cd', 'k9Lm2p', '123456']) {
    const line = denied(suffix).split('\n')[2];
    assert.equal(normalizeFailureLine(line), legacy(line), `stored form kept for ${suffix}`);
  }
  // Words around it stay: a different line is still a different identity.
  assert.notEqual(
    normalizeFailureLine('Forge: $RUNNER_TEMP/forge-packages-xQzTbR/run is a check input'),
    normalizeFailureLine('Forge: $RUNNER_TEMP/forge-other/run is a check input'),
  );
});

test('Item 0d14c456: identity is the check pins plus the normalized environment line', () => {
  const pins = {
    checkId: randomUUID(),
    expectedDefinition: 'a'.repeat(64),
    expectedConfiguration: 'b'.repeat(64),
    expectedEnvironment: 'c'.repeat(64),
  };
  const run = { status: 'failed', cancelRequested: false, request: pins };
  const first = environmentEnd(run, [denied('Ab12Cd')]);
  assert(first, "the sandbox's note on a Forge-written input is environment evidence");
  assert.deepEqual(environmentEnd(run, [denied('Zz98Yx')]), {
    ...first,
    excerpt: first.excerpt.replace('Ab12Cd', 'Zz98Yx'),
  });
  assert.notEqual(environmentEnd(run, [isolationRefused]).signature, first.signature);
  for (const shell of ['sh: 1: pnpm: not found', 'bash: line 1: ./run: Permission denied'])
    assert.equal(environmentEnd(run, [shell]), null, `a shell line alone is no Forge attribution: ${shell}`);
  assert.equal(
    environmentEnd(run, [
      'Forge: $HOME/.cache is not writable for the Candidate user forge-check: it belongs to the runner.',
    ]),
    null,
    'a project writing into a runner folder is the change, not the environment',
  );
  assert.equal(
    environmentEnd({ ...run, testFiles: { failed: [{ file: 'tests/a.test.mjs' }] } }, [denied('Ab12Cd')]),
    null,
    'a failing test is a verdict',
  );
  assert.equal(environmentEnd(run, ['Error: expected 1 to equal 2']), null);
  // A changed command or runner configuration is another check: the hold does not cover it.
  process.env[SWITCH] = '1';
  const hold = { cause: 'environment', streak: 3, since: 0, command: checkCommandKey(pins), signature: 'x' };
  const request = check => ({ check: { kind: 'request', ...check } });
  assert.equal(heldCommand(hold, request(pins)), true);
  assert.equal(heldCommand(hold, request({ ...pins, expectedDefinition: 'd'.repeat(64) })), false);
  assert.equal(heldCommand(hold, request({ ...pins, expectedConfiguration: 'e'.repeat(64) })), false);
  assert.equal(heldCommand({ ...hold, streak: 2 }, request(pins)), false, 'not tripped yet');
});
