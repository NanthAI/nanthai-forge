// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseActionsCapacity } from '../dist/hosted-actions-capacity.js';

test('a capacity file is read strictly; anything else observes nothing', () => {
  assert.deepEqual(parseActionsCapacity('{"activeChecks":3,"jobCap":60}'), { activeChecks: 3, jobCap: 60 });
  for (const text of [
    undefined,
    '',
    'null',
    '{',
    '{"activeChecks":-1,"jobCap":60}',
    '{"activeChecks":1,"jobCap":0}',
    '{"activeChecks":"1","jobCap":60}',
  ])
    assert.equal(parseActionsCapacity(text), undefined);
});

test('the job script reads the token only in capacity, writes outputs only from planning and never runs the check there', () => {
  const script = readFileSync('scripts/hosted-actions-job.mjs', 'utf8');
  // The capacity step is the only one that reads the token; it exits before the Forge client loads.
  const capacity = script.indexOf("process.argv[2] === 'capacity'"),
    client = script.indexOf('new ActionsJobClient(');
  assert.ok(capacity > 0 && capacity < client);
  const plan = script.slice(
    script.indexOf("process.argv[2] === 'plan'"),
    script.indexOf("process.argv[2] === 'pack'"),
  );
  assert.match(plan, /appendFileSync\(\s*process\.env\.GITHUB_OUTPUT/);
  assert.match(plan, /single_shard=\$\{result\.singleShard\}/);
  // Planning reads the Candidate as data only: no execution, no fold (Issue 432164bf).
  assert.doesNotMatch(plan, /executeActionsJob|FORGE_ACTIONS_FOLD|fold/);
  // The run path writes no output and starts the Candidate user before any Candidate code.
  const run = script.slice(script.lastIndexOf('} else {'), script.indexOf('} catch (error) {'));
  assert.doesNotMatch(run, /GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH/);
  assert.ok(run.indexOf('isolateCandidates()') < run.indexOf('executeActionsJob('));
});
