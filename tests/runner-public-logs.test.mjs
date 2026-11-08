// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  checkLogsField,
  publicLogsNotice,
  requirePrivateRunner,
  runnerPublicCode,
  runnerPublicReason,
} from '../dist/runner-visibility.js';
import { summarizeCheckRun } from '../dist/hosted-check-summary.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { checkLogsKey, checkSelection } from '../dist/hosted-agent-actions.js';

const hash = 'a'.repeat(64);
const actions = (extra = {}) => ({
  provider: 'github-actions',
  repository: 'Acme/runner',
  runsOn: 'ubuntu-latest',
  runtime: hash,
  environmentFingerprint: hash,
  ...extra,
});
const run = configuration => ({
  id: randomUUID(),
  at: '2026-11-08T10:00:00.000Z',
  endedAt: '2026-11-08T10:01:00.000Z',
  status: 'passed',
  request: { candidateId: randomUUID(), expectedHead: hash },
  counts: { completed: 1, passed: 1, failed: 0 },
  exitCode: 0,
  cost: { status: 'unknown' },
  configuration,
});

test('public logs: the run summary says so only for a runner whose owner accepted them', () => {
  const opted = summarizeCheckRun(run(actions({ publicLogs: true })));
  assert.equal(opted.checkLogs, publicLogsNotice('Acme/runner'));
  assert.match(opted.checkLogs, /^Check logs are public: this runner runs in Acme\/runner/);
  assert.equal(summarizeCheckRun(run(actions())).checkLogs, undefined);
  const mac = { provider: 'mac', machineId: randomUUID(), runtime: hash, environmentFingerprint: hash };
  assert.equal(summarizeCheckRun(run(mac)).checkLogs, undefined);
  assert.deepEqual(checkLogsField(null), {});
  assert.deepEqual(checkLogsField({ publicLogs: 'yes', repository: 'Acme/runner' }), {});
});

test('public logs: the land summary ends with the notice on every outcome line set', () => {
  const notice = publicLogsNotice('Acme/runner');
  const landed = landSummary({
    result: {
      submission: { phase: 'landed', acceptance: { receiptId: randomUUID(), head: hash } },
      checkLogs: notice,
    },
  });
  assert.match(landed[0], /^LANDED/);
  assert.equal(landed.at(-1), notice);
  const failed = landSummary({
    result: {
      submission: { phase: 'terminal-failed', error: { code: 'CHECK_FAILED', message: 'tests failed' } },
      checkLogs: notice,
    },
  });
  assert.match(failed[0], /^FAILED CHECK_FAILED/);
  assert.equal(failed.at(-1), notice);
  assert.deepEqual(landSummary({ result: { submission: { phase: 'landed' } } }), ['LANDED']);
});

test('public logs: the check selection keeps the notice from the settings row it already reads', async () => {
  const values = new Map();
  const calls = [];
  const session = (configuration, map = values) => ({
    query: async (name, args) => {
      calls.push(name);
      assert.equal(name, 'projectHostedCheckDefinitions:current');
      assert.deepEqual(args, { checkId: 'c1' });
      return { check: { definition: hash }, configuration, configurationDigest: hash };
    },
    journal: {
      get: key => map.get(key),
      retain: async (key, prepare) =>
        map.has(key) ? map.get(key) : (map.set(key, await prepare()), map.get(key)),
    },
  });
  const selected = await checkSelection(session(actions({ publicLogs: true })), { checkId: 'c1' });
  assert.deepEqual(Object.keys(selected).sort(), [
    'checkId',
    'expectedConfiguration',
    'expectedDefinition',
    'expectedEnvironment',
    'kind',
  ]); // the request sent to the server is unchanged
  assert.equal(values.get(checkLogsKey), publicLogsNotice('Acme/runner'));
  assert.deepEqual(calls, ['projectHostedCheckDefinitions:current']); // no extra read
  const plain = new Map();
  await checkSelection(session(actions(), plain), { checkId: 'c1' });
  assert.equal(plain.has(checkLogsKey), false);
});

test('public logs: the refusal names both fixes, and an owner opt-in allows a public runner', () => {
  const reason = runnerPublicReason('Acme/runner', 'public');
  assert.match(reason, /private runner repository/);
  assert.match(reason, /"repository":"Acme\/runner","publicLogs":true/);
  assert.throws(
    () => requirePrivateRunner('private', 'Acme/runner', 'public'),
    error => error.code === runnerPublicCode && error.message === reason,
  );
  assert.throws(() => requirePrivateRunner(undefined, 'Acme/runner', 'internal'), { code: runnerPublicCode });
  assert.throws(() => requirePrivateRunner('private', 'Acme/runner', 'unknown'), { code: runnerPublicCode });
  requirePrivateRunner('private', 'Acme/runner', 'public', true);
  requirePrivateRunner('private', 'Acme/runner', 'private');
  requirePrivateRunner('public', 'Acme/runner', 'public');
});
