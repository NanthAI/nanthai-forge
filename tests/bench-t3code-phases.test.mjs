// SPDX-License-Identifier: Apache-2.0
// Rework tokens per landing (Issue bf130503): the phase classifier, its join with the relay's
// call log, per-landing aggregation, the convoy rule and the coordination cells. Fixtures are
// synthetic, in the exact shapes of recorded sessions: Claude session jsonl, `claude -p
// --output-format stream-json`, Codex rollouts (code-mode exec, write_stdin, wait, sleep) and
// relay rows (broker.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, sessionTurns, sessionPhases, callKinds } from '../scripts/bench-t3code/phases.mjs';
import {
  cellRework,
  compareArms,
  checkWalls,
  convoyVerdict,
  medianInterval,
  orderWaits,
  reworkSummary,
  taskLine,
} from '../scripts/bench-t3code/rework.mjs';
import { waitsOf } from '../scripts/bench-t3code/broker.mjs';
import {
  coordinationBatch,
  coordinationBatches,
  coordinationTasks,
  parseCoordinationKey,
  scopeGrade,
  workspacePackages,
} from '../scripts/bench-t3code/cells.mjs';
import { dryGroup } from '../scripts/bench-t3code/scripted.mjs';

const usage = (cached, output) => ({
  input_tokens: 3,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: 10,
  output_tokens: output,
});
let seq = 0;
/** One Claude response: a text block and a tool_use block, as two entries sharing the message
 * id and repeating its usage (output grows to its final value on the last block). */
function claudeTurn(command, result, { cached = 1000, output = 50, tool = 'Bash', isError = false } = {}) {
  const id = `msg_${++seq}`,
    toolId = `toolu_${seq}`;
  const at = new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString();
  const input = tool === 'Bash' ? { command } : { file_path: 'src/x.ts', content: command };
  return [
    {
      type: 'assistant',
      timestamp: at,
      message: { id, content: [{ type: 'text', text: 'ok' }], usage: usage(cached, 1) },
    },
    {
      type: 'assistant',
      timestamp: at,
      message: {
        id,
        content: [{ type: 'tool_use', id: toolId, name: tool, input }],
        usage: usage(cached, output),
      },
    },
    {
      type: 'user',
      timestamp: at,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolId, content: result, is_error: isError }],
      },
    },
  ];
}
const finalText = () => [
  {
    type: 'assistant',
    message: { id: `msg_${++seq}`, content: [{ type: 'text', text: 'done' }], usage: usage(500, 20) },
  },
];
const land = `nforge agent . land --save '{"message":"x"}'`;

/** A Forge session: code, land (check fails), fix, land, poll, landed, summary. */
function forgeSession() {
  return [
    ...claudeTurn('ls src', 'a.ts'),
    ...claudeTurn('export const x = 1;', 'written', { tool: 'Write' }),
    ...claudeTurn('vp test run src/a.test.ts', 'FAIL src/a.test.ts\n1 failed'),
    ...claudeTurn(land, '{"error":{"code":"CHECK_FAILED","message":"1 test failed"}}', {
      cached: 2000,
      output: 70,
    }),
    ...claudeTurn('export const x = 2;', 'written', { tool: 'Write', cached: 3000, output: 80 }),
    ...claudeTurn('vp test run src/a.test.ts', 'ok', { cached: 3100, output: 30 }),
    ...claudeTurn(land, 'CHECK PASSED; queued to land, not landed yet (waiting for acceptance)'),
    ...claudeTurn(`nforge agent . status '{}' | tail -5; sleep 20`, '{"phase":"ready"}'),
    ...claudeTurn(`nforge agent . wait '{"operationIds":["o"]}'`, 'LANDED receipt r1'),
    ...finalText(),
  ];
}

test('Claude session: phases follow the landing, usage merges per response', () => {
  const entries = forgeSession();
  const turns = sessionTurns(entries);
  assert.equal(turns.length, 10);
  assert.deepEqual(turns[3].usage, { input: 3, cachedInput: 2000, cacheWrite: 10, output: 70 });
  const r = classify(turns);
  assert.deepEqual(r.phases, [
    'coding',
    'coding',
    'coding', // a failing local test before landing is coding, not rework
    'landing',
    'rework',
    'rework',
    'landing',
    'waiting',
    'waiting',
    'done',
  ]);
  assert.equal(r.totals.rework.turns, 2);
  assert.equal(r.totals.rework.cachedInput, 6100);
  assert.equal(r.totals.rework.output, 110);
  assert.equal(r.events.reworkEpisodes, 1);
  assert.deepEqual(r.events.triggers, [{ turn: 3, kinds: ['check-failed'] }]);
  assert.equal(r.events.attempts, 2);
  assert.equal(r.landedAtTurn, 8);
});

test('stream-json output classifies the same as the session transcript', () => {
  const stream = forgeSession().map(({ timestamp, ...e }) => ({ ...e, session_id: 's' }));
  stream.unshift({ type: 'system', subtype: 'init', tools: ['Bash'] });
  stream.push({ type: 'result', subtype: 'success', num_turns: 10, modelUsage: {} });
  assert.deepEqual(classify(sessionTurns(stream)).phases, classify(sessionTurns(forgeSession())).phases);
});

test('help text and file reads never trigger rework', () => {
  const r = classify(
    sessionTurns([
      ...claudeTurn(land, 'CHECK PASSED; queued'),
      ...claudeTurn(
        `nforge agent . land --save --help`,
        'Errors: CHECK_FAILED, CHANNEL_CHANGED, COMPOSITION_CONFLICT',
      ),
      ...claudeTurn('cat notes.md', 'CONFLICT (content): old notes'),
      ...claudeTurn(`nforge agent . status '{}'`, '{"phase":"landed"}'),
    ]),
  );
  assert.equal(r.events.reworkEpisodes, 0);
  assert.deepEqual(r.phases, ['landing', 'landing', 'landing', 'waiting']);
  assert.equal(r.landedAtTurn, 3);
});

test('relay rows join by verb and order: structured codes trigger rework', () => {
  const turns = sessionTurns([
    ...claudeTurn(land, 'FAILED'), // the text names no code; the relay row does
    ...claudeTurn(`nforge agent . land --save --help`, 'usage'),
    ...claudeTurn('git status', 'clean'),
    ...claudeTurn(land, 'LANDED receipt r2'),
  ]);
  const rows = [
    { task: 't', startedAt: '1', args: ['land', '--save', '{}'], errorCodes: ['CHANNEL_CHANGED'] },
    { task: 't', startedAt: '2', args: ['land', '--save', '--help'], errorCodes: ['CHECK_FAILED'] },
    { task: 't', startedAt: '3', args: ['land', '--save', '{}'], errorCodes: [] },
  ];
  const r = classify(turns, { rows });
  assert.deepEqual(r.joined, { commands: 3, matched: 3, rows: 3 });
  assert.deepEqual(r.phases, ['landing', 'rework', 'rework', 'landing']);
  assert.deepEqual(r.events.triggers, [{ turn: 0, kinds: ['channel-changed'] }]);
});

test('GitHub session: polls wait, a queue removal counts once, a rejected push is rework', () => {
  const removed =
    '{"nodes":[{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-11-08T12:00:00Z"}]}';
  const r = classify(
    sessionTurns([
      ...claudeTurn('git commit -qm x && git push -u origin b', 'branch set up'),
      ...claudeTurn(
        'gh pr create --base main --fill && gh pr merge --squash --auto',
        'https://github.com/o/r/pull/7',
      ),
      ...claudeTurn('gh pr checks 7; sleep 30', 'bench-check\tpending\t0'),
      ...claudeTurn(`gh api graphql -f query='{ repository { pullRequest { timelineItems } } }'`, removed),
      ...claudeTurn('git pull --no-rebase origin main', 'Merge made by the ort strategy.'),
      ...claudeTurn('git push origin b', '! [rejected] b -> b (fetch first)'),
      ...claudeTurn('git pull --no-rebase origin main && git push origin b', 'ok'),
      ...claudeTurn('gh pr merge --squash --auto', 'queued'),
      ...claudeTurn(`gh api graphql -f query='{ repository { pullRequest { timelineItems } } }'`, removed),
      ...claudeTurn('gh pr view 7 --json state --jq .state', 'MERGED'),
    ]),
  );
  assert.deepEqual(r.phases, [
    'landing',
    'landing',
    'waiting',
    'waiting',
    'rework',
    'landing', // the push is the next landing attempt; its rejection starts rework again
    'landing',
    'landing',
    'waiting',
    'waiting',
  ]);
  assert.equal(r.events.reworkEpisodes, 2);
  assert.deepEqual(
    r.events.triggers.map(t => t.kinds),
    [['queue-removed'], ['push-rejected']],
  );
  assert.equal(r.events.resyncs, 2);
  assert.equal(r.landedAtTurn, 9);
});

test('Codex rollout: exec sessions resumed by write_stdin, cells resumed by wait, sleep polls', () => {
  const at = i => new Date(Date.UTC(2026, 10, 8, 12, 0, i)).toISOString();
  let i = 0;
  const item = payload => ({ timestamp: at(++i), type: 'response_item', payload });
  const record = (cached, output) => ({
    timestamp: at(++i),
    type: 'token_usage_record',
    payload: { usage: { input_tokens: cached + 100, cached_input_tokens: cached, output_tokens: output } },
  });
  const exec = (id, cmd) =>
    item({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: id,
      input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));`,
    });
  const out = (id, text) =>
    item({
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        { type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text },
      ],
    });
  const entries = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 's' } },
    exec('c1', 'nforge agent . land --save \'{"message":"x"}\''),
    record(1000, 10),
    out('c1', JSON.stringify({ session_id: 42, output: '' })),
    item({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'c2',
      input: 'text(await tools.write_stdin({session_id:42,chars:""}));',
    }),
    record(2000, 20),
    out('c2', JSON.stringify({ session_id: 42, output: '{"error":{"code":"COMPOSITION_CONFLICT"}}' })),
    exec('c3', 'git diff'),
    record(3000, 30),
    out('c3', 'diff'),
    exec('c4', 'nforge agent . land --save \'{"message":"x"}\''),
    record(4000, 40),
    item({
      type: 'custom_tool_call_output',
      call_id: 'c4',
      output: 'Script running with cell ID 7\nOutput:\n',
    }),
    item({ type: 'function_call', name: 'sleep', call_id: 'c5', arguments: '{"duration_ms":20000}' }),
    record(5000, 50),
    item({ type: 'function_call_output', call_id: 'c5', output: '' }),
    item({ type: 'function_call', name: 'wait', call_id: 'c6', arguments: '{"cell_id":"7"}' }),
    record(6000, 60),
    item({ type: 'function_call_output', call_id: 'c6', output: 'LANDED receipt r3' }),
    record(7000, 5),
  ];
  const turns = sessionTurns(entries);
  assert.equal(turns.length, 7);
  assert.deepEqual(turns[1].usage, { input: 100, cachedInput: 2000, cacheWrite: 0, output: 20 });
  assert.ok(callKinds(turns[1].calls[0]).polls === 1 && turns[1].calls[0].owner === turns[0].calls[0]);
  const r = classify(turns);
  assert.deepEqual(r.phases, ['landing', 'waiting', 'rework', 'landing', 'waiting', 'waiting', 'done']);
  assert.equal(r.totals.rework.cachedInput, 3000);
  assert.equal(r.landedAtTurn, 5);
});

test("a long command's relay codes count when the agent reads its end, not at its start (30845e65)", () => {
  // Codex starts `land`, then polls its exec session; the relay row (the command's final outcome)
  // joins to the starting call. Polls before the conflict is shown are waiting, not rework.
  const at = i => new Date(Date.UTC(2026, 10, 8, 13, 0, i)).toISOString();
  let i = 0;
  const item = payload => ({ timestamp: at(++i), type: 'response_item', payload });
  const record = cached => ({
    timestamp: at(++i),
    type: 'token_usage_record',
    payload: { usage: { input_tokens: cached + 1, cached_input_tokens: cached, output_tokens: 1 } },
  });
  const call = (id, input) => item({ type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const out = (id, output) => item({ type: 'custom_tool_call_output', call_id: id, output });
  const poll = id => call(id, 'text(await tools.write_stdin({session_id:7,chars:""}));');
  const entries = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 's' } },
    call('c1', `text(await tools.exec_command({cmd:${JSON.stringify("nforge agent . land --save '{}'")}}));`),
    record(100),
    out('c1', JSON.stringify({ session_id: 7, output: '' })),
    poll('c2'),
    record(200),
    out('c2', 'Queued, position 2 of 2'),
    poll('c3'),
    record(300),
    out('c3', 'terminal-failed COMPOSITION_CONFLICT'),
    call('c4', `text(await tools.exec_command({cmd:${JSON.stringify("nforge agent . sync '{}'")}}));`),
    record(400),
    out('c4', 'synced'),
  ];
  const rows = [
    { task: 't', startedAt: '1', args: ['land', '--save', '{}'], errorCodes: ['COMPOSITION_CONFLICT'] },
    { task: 't', startedAt: '2', args: ['sync', '{}'], errorCodes: [] },
  ];
  const r = classify(sessionTurns(entries), { rows });
  assert.deepEqual(r.phases, ['landing', 'waiting', 'waiting', 'rework']);
  assert.deepEqual(r.events.triggers, [{ turn: 2, kinds: ['conflict'] }]);
  assert.equal(r.totals.rework.cachedInput, 400);
});

test('a self-cancelled or conflicted landing is not a failed check; docs pages are not results', () => {
  const cancelled =
    '{"phase":"terminal-failed","error":{"code":"LANDING_CANCELLED","message":"The hosted landing request was cancelled."}}';
  const r = classify(
    sessionTurns([
      ...claudeTurn(land, 'SUBMITTED'),
      ...claudeTurn(`nforge agent . cancel '{}'`, cancelled),
      ...claudeTurn(
        'nforge docs agents/workflow',
        'Failure cause is `check-failed`; CHECK_FAILED, <<<<<<< lane',
      ),
      ...claudeTurn(land, 'LANDED receipt r1'),
    ]),
  );
  assert.equal(r.events.reworkEpisodes, 0, 'a self-cancel and a docs page are not triggers');
  assert.equal(r.landedAtTurn, 3);
  const conflicted = classify(
    sessionTurns([
      ...claudeTurn(land, '{"phase":"terminal-failed","error":{"code":"COMPOSITION_CONFLICT"}}'),
      ...claudeTurn('git diff', 'diff'),
    ]),
  );
  assert.deepEqual(
    conflicted.events.triggers,
    [{ turn: 0, kinds: ['conflict'] }],
    'a conflict, not a failed check',
  );
});

test('sessionPhases reads a retained transcript or stream-json output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phases-'));
  try {
    writeFileSync(
      join(dir, 'a.stdout.json'),
      forgeSession()
        .map(e => JSON.stringify(e))
        .join('\n'),
    );
    const p = sessionPhases(join(dir, 'a'));
    assert.equal(p.source, 'stream-json');
    assert.equal(p.totals.rework.turns, 2);
    assert.equal(sessionPhases(join(dir, 'missing')).source, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-landing medians carry bootstrap intervals; arms compare by rep', () => {
  const line = (task, landed, turns, cached) =>
    taskLine(task, landed, {
      source: 'transcript',
      totals: {
        coding: { turns: 1, cachedInput: 1, output: 1, input: 1, cacheWrite: 0 },
        landing: { turns: 1, cachedInput: 1, output: 1, input: 1, cacheWrite: 0 },
        rework: { turns, cachedInput: cached, output: turns * 10, input: 0, cacheWrite: 0 },
        waiting: { turns: 2, cachedInput: 5, output: 1, input: 0, cacheWrite: 0 },
        done: { turns: 0, cachedInput: 0, output: 0, input: 0, cacheWrite: 0 },
      },
      events: { reworkEpisodes: turns ? 1 : 0, triggers: [], resyncs: 0, attempts: 1 },
    });
  const c = cellRework([line('a', true, 0, 0), line('b', true, 4, 400), line('c', false, 6, 600)]);
  assert.equal(c.landings, 2);
  assert.equal(c.sums.reworkCachedInput, 1000);
  assert.equal(c.meanPerLanding.reworkCachedInput, 500); // a task that never landed still counts
  assert.equal(c.perLanding.reworkTurns.median, 2);
  assert.deepEqual(c.perLanding.reworkTurns.ci95, [0, 4]);
  assert.deepEqual(medianInterval([]), { n: 0, median: null, ci95: null });
  const cmp = compareArms(
    [1, 2, 3].map(rep => ({
      rep,
      github: { meanPerLanding: { reworkCachedInput: 1000 + rep } },
      forge: { meanPerLanding: { reworkCachedInput: 400 } },
    })),
  );
  assert.ok(cmp.forgeLower && cmp.medianDifference === -602 && cmp.label.startsWith('observation'));
  assert.equal(compareArms([{ rep: 1, forge: null, github: null }]).n, 0);
});

test('convoy rule: every landing within 1.3 x median check wall + 2 min, no order wait', () => {
  const t = (
    task,
    ttm,
    timing = { checkReservedAt: '2026-11-08T12:00:00Z', ciEndedAt: '2026-11-08T12:05:00Z' },
  ) => ({
    task,
    timeToMainSeconds: ttm,
    landing: { landed: ttm != null, operations: [{ phase: 'landed', timing }], prs: [Number(task.slice(1))] },
  });
  const records = [t('c1', 400), t('c2', 500), t('c3', 510)];
  const walls = checkWalls('forge', records);
  assert.deepEqual([...walls.values()], [300, 300, 300]);
  assert.equal(convoyVerdict(records, walls, []).pass, true); // limit 1.3 * 300 + 120 = 510
  const late = convoyVerdict([...records, t('c4', 511)], walls, []);
  assert.deepEqual(
    late.late.map(x => x.task),
    ['c4'],
  );
  assert.equal(late.pass, false);
  assert.equal(convoyVerdict([...records, t('c5', null)], walls, []).pass, false);
  const sub = 'aaaaaaaa-0000-4000-8000-000000000001';
  const calls = [
    { task: 'c1', submissionIds: [sub], ids: [sub] },
    { task: 'c2', orderWaits: [sub], ids: [sub], endedAt: 'x' },
    { task: 'c2', orderWaits: [sub], ids: [sub], endedAt: 'y' },
    { task: 'c3', orderWaits: ['bbbbbbbb-0000-4000-8000-000000000002'] },
  ];
  const waits = orderWaits(calls);
  assert.deepEqual(
    waits.map(w => [w.task, w.peer]),
    [
      ['c2', 'c1'],
      ['c3', null],
    ],
  );
  const v = convoyVerdict(records, walls, waits);
  assert.ok(!v.pass && v.orderWaitsAgainstIndependent === 1 && v.orderWaitsUnattributed === 1);
  const runs = [
    {
      pr: 1,
      event: 'pull_request',
      conclusion: 'failure',
      created_at: '2026-11-08T12:00:00Z',
      updated_at: '2026-11-08T12:01:00Z',
    },
    {
      pr: 1,
      event: 'pull_request',
      conclusion: 'success',
      created_at: '2026-11-08T12:02:00Z',
      updated_at: '2026-11-08T12:06:00Z',
    },
    {
      pr: 1,
      event: 'merge_group',
      conclusion: 'success',
      created_at: '2026-11-08T12:07:00Z',
      updated_at: '2026-11-08T12:20:00Z',
    },
  ];
  assert.deepEqual([...checkWalls('github', [t('c1', 400)], runs).values()], [240]);
});

test("relay rows name order waits apart from the call's own submissions", () => {
  const a = '11111111-2222-4333-8444-555555555555',
    b = '99999999-2222-4333-8444-555555555555';
  assert.deepEqual(
    waitsOf(
      `CHECK PASSED; not landed yet: waiting for older submission ${a} to take main first\n{"result":{"submission":{"submissionId":"${b}"},"orderWait":{"submissionId":"${a}"}}}`,
    ),
    { orderWaits: [a], submissionIds: [b] },
  );
  assert.deepEqual(waitsOf('LANDED receipt r'), { orderWaits: [], submissionIds: [] });
});

test('coordination cells: packages from the workspace manifest, seeded tasks, rotating arms', () => {
  const root = mkdtempSync(join(tmpdir(), 'cells-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['tools/cli'] }));
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - packages/*\n  - '!packages/skip'\nother:\n  - x/*\n",
    );
    for (const d of [
      'apps/web',
      'apps/server',
      'packages/a',
      'packages/b',
      'packages/c',
      'tools/cli',
      'x/y',
    ]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, 'package.json'), '{}');
    }
    mkdirSync(join(root, 'packages/no-manifest'), { recursive: true });
    const pkgs = workspacePackages(root);
    assert.deepEqual(pkgs, [
      'apps/server',
      'apps/web',
      'packages/a',
      'packages/b',
      'packages/c',
      'tools/cli',
    ]);
    const convoy = coordinationTasks('convoy', 4, pkgs);
    assert.deepEqual(convoy, coordinationTasks('convoy', 4, pkgs)); // same seed, same tasks
    assert.equal(new Set(convoy.map(t => t.package)).size, 4);
    assert.deepEqual(
      convoy.map(t => t.id),
      ['c01', 'c02', 'c03', 'c04'],
    );
    assert.ok(convoy.every(t => dryGroup(t) === '' && !t.prompt.includes('README.md')));
    const overlap = coordinationTasks('overlap', 4, pkgs);
    assert.ok(
      overlap.every(
        t => t.prompt.includes('README.md') && dryGroup(t) === dryGroup(overlap[0]) && dryGroup(t),
      ),
    );
    assert.throws(() => coordinationTasks('convoy', 8, pkgs), /BENCH_CELL_PACKAGES/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const b1 = coordinationBatch('overlap', 8, 1),
    b2 = coordinationBatch('overlap', 8, 2);
  assert.deepEqual(
    b1.cells.map(c => c.slot),
    ['github', 'forge-offer', 'forge-auto'],
  );
  assert.deepEqual(
    b2.cells.map(c => c.slot),
    ['forge-offer', 'forge-auto', 'github'],
  );
  assert.equal(b2.cells[0].stack, 'offer');
  assert.equal(b1.order.length, 8);
  assert.deepEqual(
    coordinationBatch('convoy', 16, 2).cells.map(c => c.key),
    ['forge-convoy-n16-r2', 'github-convoy-n16-r2'],
  );
  assert.deepEqual(
    coordinationBatches().map(b => b.key),
    [
      'convoy-n16-r1',
      'convoy-n8-r1',
      'convoy-n4-r1',
      'overlap-n8-r1',
      'overlap-n4-r1',
      'convoy-n16-r2',
      'convoy-n8-r2',
      'convoy-n4-r2',
      'overlap-n8-r2',
      'overlap-n4-r2',
    ],
  );
  assert.deepEqual(parseCoordinationKey('forge-auto-overlap-n4-r2'), {
    slot: 'forge-auto',
    kind: 'overlap',
    N: 4,
    rep: 2,
  });
  assert.equal(parseCoordinationKey('n3-r1'), null);
});

test('scope grade: landed, inside its package (and the hot file), names its function', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-'));
  try {
    mkdirSync(join(dir, 'packages/a/src'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/a/src/t.ts'),
      'export function overlapTask1() { return "overlapTask1"; }',
    );
    const task = { id: 'o01', scope: { package: 'packages/a', hotFile: 'README.md', fn: 'overlapTask1' } };
    const record = files => ({ task: 'o01', landing: { landed: true }, changes: { dir, files } });
    const ok = record([
      { path: 'packages/a/src/t.ts', saved: true },
      { path: 'README.md', saved: true },
    ]);
    assert.equal(scopeGrade([task], [ok]).strictSuccess, 1);
    const outside = record([
      { path: 'packages/a/src/t.ts', saved: true },
      { path: 'packages/b/x.ts', saved: true },
    ]);
    assert.deepEqual(scopeGrade([task], [outside]).cases[0].outside, ['packages/b/x.ts']);
    assert.equal(scopeGrade([task], [record([{ path: 'README.md', saved: true }])]).strictSuccess, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary: main cells per N and the stacking A/B per coordination cell', () => {
  const cell = (arm, N, rep, cached, coordinationCell) => ({
    cellId: `${arm}-${N}-${rep}`,
    arm,
    N,
    rep,
    ...(coordinationCell ? { coordinationCell } : {}),
    rework: {
      landings: 4,
      meanPerLanding: { reworkCachedInput: cached, reworkOutput: 1, reworkTurns: 1, waitingTurns: 1 },
      ...(coordinationCell?.kind === 'convoy' ? { convoy: { pass: true, late: [], limitSeconds: 500 } } : {}),
    },
  });
  const s = reworkSummary(
    [
      cell('github', 3, 1, 900),
      cell('forge', 3, 1, 300),
      cell('github', 3, 2, 800),
      cell('forge', 3, 2, 200),
    ],
    [
      cell('github', 4, 1, 900, { kind: 'overlap' }),
      cell('forge', 4, 1, 500, { kind: 'overlap', stack: 'offer' }),
      cell('forge', 4, 1, 100, { kind: 'overlap', stack: 'auto' }),
      cell('forge', 16, 1, 0, { kind: 'convoy' }),
    ],
  );
  assert.equal(s.main['N=3'].reworkCachedInput.medianDifference, -600);
  const o = s.coordination['overlap N=4'];
  assert.deepEqual(
    o.vsGithub.map(x => x.b),
    ['forge-auto', 'forge-offer'],
  );
  assert.equal(o.stackingAB.reworkCachedInput.medianDifference, -400);
  assert.equal(s.coordination['convoy N=16'].convoy[0].pass, true);
});
