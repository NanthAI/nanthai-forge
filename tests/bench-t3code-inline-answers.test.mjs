// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinationOf } from '../scripts/bench-t3code/broker.mjs';
import { forgeTask } from '../scripts/bench-t3code/coordination.mjs';

const choice = 'accept-order';
const taskOf = calls =>
  forgeTask({
    task: 'synthetic',
    calls,
    landing: { landed: true, operations: [] },
    session: { source: 'none', seen: [], actions: [] },
    laneTask: new Map(),
  });
const call = (verb, endedAt, result) => ({ verb, endedAt, ...result });
const receipt = overlap => JSON.stringify({ result: { defaults: { overlap } } });

test('inline answers: land and finish retain exact notice IDs, dedupe replayed receipts and reach R3', () => {
  const overlap = { status: 'answered', choice, notices: ['n1', 'n2'], files: ['a.ts', 'b.ts'] };
  for (const verb of ['land', 'finish']) {
    const args = [
      'agent',
      '.',
      verb,
      ...(verb === 'land' ? ['--save'] : []),
      JSON.stringify({ overlapAnswer: choice }),
    ];
    const result = coordinationOf(args, receipt(overlap) + '\n' + receipt(overlap));
    assert.deepEqual(result.answers, [
      { noticeId: 'n1', choice },
      { noticeId: 'n2', choice },
    ]);
    const metric = taskOf([call(`agent ${verb}`, '2026-01-01T00:00:00Z', result)]);
    assert.equal(
      metric.notices.length,
      2,
      'inline receipt still delivers notices after the pending inbox is cleared',
    );
    assert.ok(metric.notices.every(n => n.acknowledged && n.choice === choice && n.ackSeconds === 0));
    assert.equal(metric.gateRefusals, 0, 'answering inline does not invent an overlap refusal');
    assert.equal(metric.extraLandAttempts, 0);
  }
});

test('inline answers: old file-only receipt acknowledges only its files, leaving other notices unanswered', () => {
  const earlier = coordinationOf(
    ['agent', '.', 'status', '{}'],
    JSON.stringify({
      overlapNotice: {
        items: [
          { noticeId: 'n1', file: 'a.ts' },
          { noticeId: 'n2', file: 'b.ts' },
        ],
      },
    }),
  );
  const inline = coordinationOf(
    ['agent', '.', 'land', '--save', JSON.stringify({ overlapAnswer: choice })],
    receipt({ status: 'answered', choice, files: ['a.ts'] }),
  );
  assert.deepEqual(inline.answers, [{ noticeId: null, files: ['a.ts'], choice }]);
  const metric = taskOf([
    call('agent status', '2026-01-01T00:00:00Z', earlier),
    call('agent land --save', '2026-01-01T00:00:01Z', inline),
  ]);
  assert.deepEqual(
    metric.notices.map(n => [n.file, n.acknowledged]),
    [
      ['a.ts', true],
      ['b.ts', false],
    ],
  );
});

test('inline answers: unpinned request is recorded without acknowledging any earlier notice', () => {
  const inline = coordinationOf(
    ['agent', '.', 'finish', JSON.stringify({ overlapAnswer: choice }), '--no-wait'],
    '{}',
  );
  assert.deepEqual(inline.answers, [{ noticeId: null, files: [], choice }]);
  const earlier = { notices: [{ noticeId: 'n1', file: 'a.ts', with: [] }], answers: [] };
  const metric = taskOf([
    call('agent status', '2026-01-01T00:00:00Z', earlier),
    call('agent finish', '2026-01-01T00:00:01Z', inline),
  ]);
  assert.equal(metric.notices[0].acknowledged, false);
});

test('inline answers: defaults at top level and delivered-notice file fallback are read', () => {
  const top = coordinationOf(
    ['agent', '.', 'finish', JSON.stringify({ overlapAnswer: choice })],
    JSON.stringify({ defaults: { overlap: { status: 'answered', notices: ['n1'], files: ['a.ts'] } } }),
  );
  assert.deepEqual(top.answers, [{ noticeId: 'n1', choice }]);
  const fallback = coordinationOf(
    ['agent', '.', 'land', '--save', JSON.stringify({ overlapAnswer: choice })],
    JSON.stringify({ overlapNotice: { items: [{ noticeId: 'n1', file: 'a.ts' }] } }),
  );
  assert.deepEqual(fallback.answers, [{ noticeId: null, files: ['a.ts'], choice }]);
});

test('explicit ack and overlap-acks stay compatible; other verbs and unsupported choices add no inline answers', () => {
  assert.deepEqual(coordinationOf(['agent', '.', 'ack', '{}'], '').answers, [{ noticeId: null, choice }]);
  assert.deepEqual(
    coordinationOf(
      ['agent', '.', 'overlap-acks', JSON.stringify({ answers: [{ noticeId: 'n1', choice: 'split' }] })],
      '',
    ).answers,
    [{ noticeId: 'n1', choice: 'split' }],
  );
  const evidence = receipt({ status: 'answered', notices: ['n1'], files: ['a.ts'] });
  for (const args of [
    ['agent', '.', 'status', JSON.stringify({ overlapAnswer: choice })],
    ['agent', '.', 'land', '--save', '{}'],
    ['agent', '.', 'finish', JSON.stringify({ overlapAnswer: 'split' })],
    ['agent', '.', 'finish', '{invalid'],
  ])
    assert.deepEqual(coordinationOf(args, evidence).answers, []);
  assert.deepEqual(
    coordinationOf(
      ['agent', '.', 'finish', JSON.stringify({ overlapAnswer: choice })],
      receipt({ status: 'unanswered', notices: ['n1'], files: ['a.ts'] }) +
        '\n' +
        JSON.stringify({ overlapNotice: { items: [{ noticeId: 'n1', file: 'a.ts' }] } }),
    ).answers,
    [],
  );
  // Legacy ack without a file selection retains its existing wildcard behavior.
  const metric = taskOf([
    call('agent status', '2026-01-01T00:00:00Z', {
      notices: [{ noticeId: 'n1', file: 'a.ts' }],
      answers: [],
    }),
    call('agent ack', '2026-01-01T00:00:01Z', coordinationOf(['agent', '.', 'ack', '{}'], '')),
  ]);
  assert.equal(metric.notices[0].acknowledged, true);
});

test('inline answers: 600 notices are collected locally, with no additional transport or Convex calls', t => {
  const notices = Array.from({ length: 600 }, (_, i) => String(i).padStart(64, '0'));
  const files = notices.map((_, i) => `src/${i}.ts`);
  const output = receipt({ status: 'answered', choice, notices, files });
  const result = coordinationOf(
    ['agent', '.', 'land', '--save', JSON.stringify({ overlapAnswer: choice })],
    output,
  );
  assert.equal(result.answers.length, 600);
  assert.equal(
    taskOf([call('agent land --save', '2026-01-01T00:00:00Z', result)]).notices.filter(n => n.acknowledged)
      .length,
    600,
  );
  t.diagnostic(
    `600 inline answers parsed from ${Buffer.byteLength(output)} receipt bytes; zero added transport/Convex calls`,
  );
});
