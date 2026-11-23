// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 13ea93bf (lead 2026-11-23 19:20Z, option b): the landing check runs its cheap contract pins on
// the composed Candidate first, in the planning job, and a failing pin ends the check there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landingPinsFirst, LANDING_PIN_MAX_MS, LANDING_PINS_BUDGET_MS } from '../dist/landing-pins-first.js';
import { pinsPart, PINS_FILE_TIMEOUT_MS } from '../scripts/github-actions-check.mjs';
import { candidateStepFindings } from '../scripts/check-candidate-steps.mjs';

test('Item 13ea93bf: pins are contract-named, recorded at most 10 s, registrations first, inside 20 s', () => {
  assert.equal(LANDING_PIN_MAX_MS, 10_000);
  assert.equal(LANDING_PINS_BUDGET_MS, 20_000);
  const groups = [
    ['tests/hosted-agent-help.test.mjs', 'tests/landing-cost-guard.test.mjs', 'tests/zz-budget.test.mjs'],
    [
      'tests/table-registrations.test.mjs',
      'tests/project-purge-inventory.test.mjs',
      'tests/web-budget-browser.test.mjs',
    ],
    [
      'tests/hosted-response-contract.test.mjs',
      'tests/unrecorded-cost.test.mjs',
      'tests/slow-contract.test.mjs',
    ],
  ];
  const timings = {
    'tests/hosted-agent-help.test.mjs': 1_000, // not contract-named
    'tests/landing-cost-guard.test.mjs': 8_000,
    'tests/zz-budget.test.mjs': 9_000, // does not fit after the others
    'tests/table-registrations.test.mjs': 900,
    'tests/project-purge-inventory.test.mjs': 3_000,
    'tests/web-budget-browser.test.mjs': 500, // browser tests need the browser shard
    'tests/hosted-response-contract.test.mjs': 2_000,
    'tests/slow-contract.test.mjs': 10_001, // over the per-file bar
  };
  const picked = landingPinsFirst(groups, timings);
  assert.deepEqual(picked, {
    files: [
      'tests/table-registrations.test.mjs',
      'tests/project-purge-inventory.test.mjs',
      'tests/landing-cost-guard.test.mjs',
      'tests/hosted-response-contract.test.mjs',
    ],
    carrier: 1,
    plannedMs: 13_900,
  });
  // No record, no pin: a cost Forge has never measured is not "cheap".
  assert.equal(landingPinsFirst([['tests/unrecorded-cost.test.mjs']], {}), null);
  assert.equal(landingPinsFirst([], timings), null);
});

test('Item 13ea93bf: the executor runs only pins that are planned files of this check, each under a 60 s timeout', () => {
  assert.equal(PINS_FILE_TIMEOUT_MS, 60_000);
  const plan = {
    groups: [['tests/a-cost.test.mjs'], ['tests/b-registrations.test.mjs', 'tests/c.test.mjs']],
  };
  assert.deepEqual(
    pinsPart(plan, JSON.stringify(['tests/b-registrations.test.mjs', 'tests/a-cost.test.mjs'])),
    ['tests/b-registrations.test.mjs', 'tests/a-cost.test.mjs'],
  );
  for (const value of [undefined, '', '[]', '{"x":1}', JSON.stringify(['tests/not-planned.test.mjs'])])
    assert.throws(() => pinsPart(plan, value), /Pins first: the pin list is missing or names a file outside/);
});

test('Item 13ea93bf: the pins step is the planning job’s last step and a failure starts no shard', () => {
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  assert.deepEqual(candidateStepFindings('forge-check.yml', workflow), []);
  const plan = workflow.slice(workflow.indexOf('\n  hosted-plan:'), workflow.indexOf('\n  hosted-check:'));
  const steps = plan.split(/\n {6}- /).slice(1);
  const last = steps.at(-1);
  assert.match(last, /^if: steps\.plan\.outputs\.pins_first == 'true'/);
  assert.match(last, /run: node control\/scripts\/hosted-actions-job\.mjs pins/);
  assert.doesNotMatch(last, /secrets\.|github\.token|\bid:/);
  // After the Candidate artifact upload, so the shards get the bytes the plan pinned.
  assert(plan.indexOf('upload-artifact@') < plan.indexOf('hosted-actions-job.mjs pins'));
  // The shards depend on the planning job: a failed pins step (non-zero exit) skips them.
  const check = workflow.slice(workflow.indexOf('\n  hosted-check:'), workflow.indexOf('\n  hosted-pack:'));
  assert.match(check, /needs: hosted-plan/);
  assert.doesNotMatch(check, /always\(\)/);
  // The pins step installs from the same npm download cache as the single-shard check.
  assert.match(
    plan,
    /\(steps\.plan\.outputs\.single_shard != '' \|\| steps\.plan\.outputs\.pins_first == 'true'\) && steps\.plan\.outputs\.npm_cache == 'true'/,
  );
});
