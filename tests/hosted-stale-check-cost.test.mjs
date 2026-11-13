// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { seedTicket, ticketState } from './landing-ticket-fixture.mjs';
import { fixture, drain, assertProgressOwners } from './hosted-stale-check-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
for (const history of [0, 575, 1150])
  test(`stale-check look-ahead reads bounded metadata with ${history} retained entries`, async t => {
    const f = await fixture(t, { count: 9, memberPaths: Array(9).fill('src/shared.ts') });
    const first = [...f.tables.projectHostedLandingRequests.values()][0];
    const state = ticketState(f, first);
    for (let i = 0; i < history; i++) {
      const id = randomUUID(),
        operationId = randomUUID();
      const { _id, _creationTime, ...fields } = first;
      void [_id, _creationTime];
      seedTicket(f, {
        ...fields,
        submissionId: id,
        operationId,
        sequence: -i - 1,
        phase: 'terminal-failed',
        runnable: false,
        batchable: false,
        admitting: undefined,
        admission: undefined,
        orderLive: undefined,
        runId: null,
        value: JSON.stringify({
          ...state,
          id,
          operationId,
          sequence: -i - 1,
          phase: 'terminal-failed',
          observation: { state: 'terminal-failed', pendingReason: null, cause: 'rejected' },
        }),
      });
    }
    await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
    await drain(f, () => f.runs().some(r => r.status === 'cancelled'));
    const cost = f.counts.filter(c => c.name === 'acceptanceComplete').at(-1);
    assert.equal(f.runs().filter(r => r.status === 'cancelled').length, 8);
    assert(cost.readBytes < 1024 * 1024, JSON.stringify(cost));
    assert(cost.writeBytes < 512 * 1024, JSON.stringify(cost));
    assert(cost.documents < 640, JSON.stringify(cost));
    assertProgressOwners(f);
    t.diagnostic(
      JSON.stringify({
        history,
        lookAhead: 8,
        readBytes: cost.readBytes,
        writeBytes: cost.writeBytes,
        documents: cost.documents,
        writes: cost.writes,
      }),
    );
  });
