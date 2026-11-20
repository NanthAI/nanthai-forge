// SPDX-License-Identifier: Apache-2.0
// Agent-reported tokens at landing (Item a61d3c91, measured side): an agent may send `tokens` with land, on the call it
// already makes. The CLI sends it only to a server that records it (feature landing-tokens); the server refuses anything
// but a whole number in range before it writes; the landing row keeps it as one column; the Stats day close sums it
// as "measured from N of M landings", and nothing is stored for a day without reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { finishFixture, desired, landingApi } from './hosted-finish-fixture.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const { utcDay } = await import(moduleUrl('../convex/projectStatsClose.ts'));
const { statsDay, statsWindow } = await import(moduleUrl('../src/stats-estimate.ts'));
const { statsMonth, statsMonthSchema, statsAllReply } = await import(moduleUrl('../src/stats-period.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const refused = expected => error => (error.data?.code ?? error.code) === expected;
const SUBMITS = ['projectHostedLandingDesired:submit', 'projectHostedLanding:enqueue'];

test('land sends reported tokens on its existing submit call, only to a server that records them', async t => {
  const names = [];
  for (const records of [false, true]) {
    const s = agentFixture(t);
    if (records) s.caps.features = [...(s.caps.features ?? []), 'landing-tokens'];
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const before = s.calls.length;
    await s.transport().dispatch('finish', { laneId: s.lane.laneId, tokens: 1_234_567 });
    names.push(s.calls.slice(before).map(call => call.name));
    const submit = s.calls.find(call => SUBMITS.includes(call.name));
    assert.equal(
      submit.args.tokens,
      records ? 1_234_567 : undefined,
      'an older server receives no new argument',
    );
    assert.equal(
      'tokens' in JSON.parse(submit.args.request),
      false,
      'tokens stay outside the replayed request',
    );
  }
  assert.deepEqual(names[1], names[0], 'reporting tokens adds no call');
});

test('land refuses tokens that are not a whole number from 0 to 1e9 before any server call', async t => {
  const s = agentFixture(t);
  s.caps.features = [...(s.caps.features ?? []), 'landing-tokens'];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  for (const tokens of [-1, 1.5, 1_000_000_001, '12']) {
    const before = s.calls.length;
    await assert.rejects(s.transport().dispatch('finish', { laneId: s.lane.laneId, tokens }));
    assert.equal(
      s.calls.slice(before).filter(call => SUBMITS.includes(call.name)).length,
      0,
      `no submission for ${JSON.stringify(tokens)}`,
    );
  }
});

const request = f => ({
  operationId: randomUUID(),
  authorityEpoch: 1,
  composeOperationId: f.selection.request.operationId,
  after: null,
  check: f.request().check,
});

test('the server keeps reported tokens on the landing row from submit to landed, and refuses bad ones before writing', async t => {
  const f = await finishFixture(t);
  const submit = (command, tokens) =>
    f
      .tx('desiredSubmit', desired.submit, {
        projectId: f.projectId,
        request: JSON.stringify(command),
        ...(tokens === undefined ? {} : { tokens }),
      })
      .then(JSON.parse);
  for (const bad of [-1, 2.5, 1_000_000_001, Number.NaN])
    await assert.rejects(submit(request(f), bad), refused('BAD_ARGUMENT'), `refuses ${bad}`);
  assert.equal(f.tables.projectHostedLandingDesired.size, 0, 'a refusal writes nothing');
  const command = request(f);
  const state = await submit(command, 4_200_000);
  assert.equal(JSON.stringify(state).includes('4200000'), false, 'the reply and state body do not carry it');
  assert.equal([...f.tables.projectHostedLandingDesired.values()][0].agentTokens, 4_200_000);
  // A replay of the same operation keeps the first report.
  assert.equal((await submit(command, 9)).id, state.id);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.operationId === command.operationId,
  );
  assert.equal(JSON.parse(row.value).phase, 'landed');
  assert.equal(row.agentTokens, 4_200_000, 'the landing row the close reads holds the report');
});

test('a direct enqueue takes tokens the same way, and a landing without them stores no column', async t => {
  const f = await finishFixture(t);
  const enqueue = (value, tokens) =>
    f
      .tx('finishEnqueue', landingApi.enqueue, {
        projectId: f.projectId,
        request: JSON.stringify(value),
        ...(tokens === undefined ? {} : { tokens }),
      })
      .then(JSON.parse);
  await assert.rejects(enqueue(f.request({ agent: true }), 0.5), refused('BAD_ARGUMENT'));
  assert.equal(f.tables.projectHostedLandingRequests.size, 0, 'a refusal writes nothing');
  const first = f.request({ agent: true });
  await enqueue(first, 0);
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.operationId === first.operationId,
  );
  assert.equal(row.agentTokens, 0, 'zero is a real report');
  const plain = await finishFixture(t);
  await plain.tx('finishEnqueue', landingApi.enqueue, {
    projectId: plain.projectId,
    request: JSON.stringify(plain.request({ agent: true })),
  });
  assert.equal(
    Object.hasOwn([...plain.tables.projectHostedLandingRequests.values()][0], 'agentTokens'),
    false,
  );
});

test('the day close sums reported tokens from the landing rows it already reads: N of M, no extra read', async t => {
  const closeOnce = async report => {
    const f = await batchesFixture(t);
    await f.drain();
    await f.passChecks();
    await f.drain();
    const receipts = [...f.tables.projectHostedAcceptances.values()];
    const rows = [...f.tables.projectHostedLandingRequests.values()].filter(r =>
      receipts.some(receipt => JSON.parse(receipt.value).submissionId === r.submissionId),
    );
    if (report) {
      f.patch('projectHostedLandingRequests', rows[0]._id, { agentTokens: 3_000_000 });
      f.patch('projectHostedLandingRequests', rows[1]._id, { agentTokens: 1_000_000 });
    }
    const day = utcDay(receipts[0]._creationTime);
    const before = f.counts.length;
    await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
    const close = f.counts.slice(before).find(c => c.name === 'statsClose');
    const row = [...f.tables.projectStatsDays.values()].find(r => r.day === day);
    return { close, value: JSON.parse(row.value), landings: receipts.length, bytes: row.value.length };
  };
  const plain = await closeOnce(false);
  assert.equal(Object.hasOwn(plain.value, 'tokens'), false, 'a day without reports stores nothing more');
  const reported = await closeOnce(true);
  assert.deepEqual(reported.value.tokens, { reported: 2, total: 4_000_000 });
  assert.equal(reported.close.documents, plain.close.documents, 'the same documents read');
  assert.equal(reported.close.writes, plain.close.writes, 'the same writes');
  // `,"tokens":{"reported":R,"total":T}`: at most about 55 B with a 1,000-landing day of 1e9 each.
  assert(reported.bytes - plain.bytes <= 60, `day row grows ${reported.bytes - plain.bytes} B`);
  const w = statsWindow([reported.value]);
  assert.deepEqual(w.measured.tokens, {
    reported: 2,
    landings: reported.landings,
    total: 4_000_000,
    perLanding: 2_000_000,
  });
  assert.equal(
    statsWindow([plain.value]).measured.tokens,
    null,
    'no report: no figure, so the tile stays hidden',
  );
});

const landing = (i, tokens) => ({
  id: `l${i}`,
  who: 'amber-fox',
  submittedAt: Date.UTC(2026, 10, 3, 8, i),
  landedAt: Date.UTC(2026, 10, 3, 9, i),
  checkStartedAt: null,
  checkEndedAt: null,
  runnerSeconds: 100,
  discardedRunnerSeconds: 0,
  attempts: 1,
  ranInFull: false,
  ...(tokens === undefined ? {} : { tokens }),
});

test('All time adds reported tokens through month rollups, and a rollup written before them still reads', () => {
  const days = [
    statsDay('2026-10-30', [landing(1), landing(2)]),
    statsDay('2026-11-03', [landing(3, 500), landing(4), landing(5, 1500)]),
  ];
  const october = statsMonth('2026-10', days);
  assert.equal(Object.hasOwn(october.totals, 'tokens'), false, 'a month without reports stores nothing more');
  assert.deepEqual(statsMonth('2026-11', days).totals.tokens, { reported: 2, total: 2000 });
  const legacy = statsMonthSchema.parse(october);
  const all = statsAllReply([legacy], [days[1]]);
  assert.deepEqual(all.window.measured.tokens, { reported: 2, landings: 5, total: 2000, perLanding: 1000 });
});
