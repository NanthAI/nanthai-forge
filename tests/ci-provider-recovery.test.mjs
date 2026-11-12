// SPDX-License-Identifier: Apache-2.0
// BYOCI recovery contract: normalize provider-owned records, never job self-reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  delayedProviderVerdict,
  providerStartupUnavailable,
  providerAckMs,
  providerVerdictReadsMs,
} from '../dist/ci-provider-recovery.js';

const adapters = {
  'github-actions': jobs => jobs,
  'gitlab-ci': jobs =>
    jobs.map(job => {
      // GitLab's jobs API uses success/failed/canceled as status, rather than a conclusion.
      const raw = { ...job, status: job.status === 'completed' ? job.conclusion : job.status };
      return {
        ...raw,
        status: ['success', 'failed', 'canceled', 'skipped'].includes(raw.status) ? 'completed' : raw.status,
        conclusion:
          raw.status === 'failed' ? 'failure' : raw.status === 'canceled' ? 'cancelled' : raw.conclusion,
      };
    }),
};
const steps = [
  { status: 'completed', conclusion: 'success' },
  { status: 'completed', conclusion: 'skipped' },
];
for (const [adapter, normalize] of Object.entries(adapters)) {
  test(`${adapter}: incident 238b3573 recovery contract settles failed startup without an event and passes completed steps with signed shards`, () => {
    assert.equal(providerAckMs, 5 * 60_000);
    for (const conclusion of ['startup_failure', 'cancelled', 'canceled'])
      assert.equal(providerStartupUnavailable(true, conclusion), true);
    assert.equal(providerStartupUnavailable(false, null), true);
    assert.equal(providerStartupUnavailable(true, null), false, 'queued work is not lost work');
    const jobs = normalize([{ status: 'in_progress', conclusion: null, steps }]);
    const decide = (changes = {}) =>
      delayedProviderVerdict({ signedShardsPassed: true, complete: true, jobs, ...changes });
    assert.equal(decide(), 'passed');
    assert.equal(decide({ signedShardsPassed: false }), 'provider-delayed');
    assert.equal(decide({ complete: false }), 'provider-delayed');
    assert.equal(decide({ jobs: [] }), 'provider-delayed');
    assert.equal(
      decide({ jobs: normalize([{ status: 'completed', conclusion: 'cancelled' }]) }),
      'provider-delayed',
      'the lag shortcut never labels cancellation as a failing test; the ordinary provider conclusion decides',
    );
    assert.equal(
      decide({
        jobs: normalize([
          {
            status: 'in_progress',
            conclusion: null,
            steps: [{ status: 'completed', conclusion: 'cancelled' }],
          },
        ]),
      }),
      'provider-delayed',
    );
    assert.equal(
      decide({
        jobs: normalize([
          { status: 'completed', conclusion: 'success' },
          { status: 'in_progress', conclusion: null, steps },
        ]),
      }),
      'provider-delayed',
      'the lag shortcut needs every executed job step, including completed jobs',
    );
    assert.equal(
      decide({ jobs: normalize([{ status: 'in_progress', conclusion: null }]) }),
      'provider-delayed',
    );
    assert.equal(decide({ jobs: normalize([{ status: 'in_progress', steps: [] }]) }), 'provider-delayed');
    assert.equal(
      decide({
        jobs: normalize([{ status: 'in_progress', steps: [{ status: 'completed', conclusion: 'failure' }] }]),
      }),
      'failed',
    );
    assert.equal(
      decide({
        jobs: normalize([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }]),
      }),
      'failed',
    );
    assert.deepEqual(providerVerdictReadsMs, [300_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000]);
  });
}
