// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionsFoldDecision, parseActionsCapacity } from '../dist/hosted-actions-job-fold.js';

const base = {
  env: { FORGE_ACTIONS_FOLD: '1' },
  singleShard: 'static',
  toolchains: {},
  depsCache: {},
  npmCache: false,
  packRefresh: false,
};

test('plan and run share one process only when the workflow opts in and nothing runs between them', () => {
  assert.deepEqual(actionsFoldDecision(base), { fold: true });
  const refused = [
    [{ env: {} }, 'workflow did not opt in'],
    [{ env: { FORGE_ACTIONS_FOLD: '1', GITHUB_TOKEN: 'synthetic' } }, 'GitHub token'],
    [{ singleShard: '' }, 'test shards'],
    [{ packRefresh: true }, 'source pack refresh'],
    [{ toolchains: { go: { version: '1.25', versionFile: '' } } }, 'declared setup'],
    [{ depsCache: { key: 'k', paths: 'p', save: false } }, 'declared setup'],
    [{ npmCache: true }, 'npm download cache'],
  ];
  for (const [change, reason] of refused) {
    const decision = actionsFoldDecision({ ...base, ...change });
    assert.equal(decision.fold, false);
    assert.match(decision.reason, new RegExp(reason));
  }
  // Forge's own suite folds once its npm download cache is in place.
  assert.deepEqual(
    actionsFoldDecision({
      ...base,
      npmCache: true,
      env: { FORGE_ACTIONS_FOLD: '1', FORGE_ACTIONS_NPM_CACHE: 'ready' },
    }),
    { fold: true },
  );
});

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

test('the job script folds only through the decision and hides the single shard it ran', () => {
  const script = readFileSync('scripts/hosted-actions-job.mjs', 'utf8');
  // The capacity step is the only one that reads the token; it exits before the Forge client loads.
  const capacity = script.indexOf("process.argv[2] === 'capacity'"),
    client = script.indexOf('new ActionsJobClient(');
  assert.ok(capacity > 0 && capacity < client);
  assert.match(script, /single_shard=\$\{fold\.fold \? '' : result\.singleShard\}/);
  assert.match(script, /npm_cache=\$\{npmCache\}\\nfolded=\$\{fold\.fold\}/);
  assert.match(script, /if \(fold\.fold\) \{[\s\S]+executeActionsJob\(/);
});
