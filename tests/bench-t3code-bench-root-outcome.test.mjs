// SPDX-License-Identifier: Apache-2.0
// A recursive search or listing of the whole bench folder is judged by what it returned
// (d8cf81b4): a hit only when a tool result shows a bench path outside the agent's own
// workspace and tools. A specific path (another cell, tasks.json, the oracle) is a hit on the
// command alone. Synthetic text; the sandbox of a real run denies reading the bench root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTask } from '../scripts/bench-t3code/contamination.mjs';
import { readSession } from '../scripts/bench-t3code/transcripts.mjs';

const BENCH = '/b/forge-bench/b15d';
const CELL = `${BENCH}/ws/github-n3-r1-a1-20261104T015045`;
const ctx = {
  prNumbers: [27097],
  workspace: `${CELL}/t1`,
  ownRepo: 'NanthAI/forge-b15d-t3code',
  toolPaths: [`${CELL}/bin`, `${CELL}/vp`, `${CELL}/hub`, `${BENCH}/deps`],
  benchRoot: BENCH,
};
const codexExec = cmd =>
  `text(await tools.exec_command({cmd:${JSON.stringify(cmd)},yield_time_ms:1000,max_output_tokens:4000}));`;
const scan = (cmd, result, tool = 'exec') =>
  scanTask({
    session: { source: 'transcript', actions: [{ tool, input: codexExec(cmd), result }], seen: [] },
    ...ctx,
  }).hits.map(h => h.id);

const SEARCH = `command -v pi; rg --files ${BENCH} 2>/dev/null | rg '(rpc-types|rpc-mode)\\.(ts|js)$' | head -15`;

test('a search of the bench root that returns nothing of the bench is clean', () => {
  assert.deepEqual(scan(SEARCH, '/usr/local/bin/pi\n'), []);
  assert.deepEqual(scan(SEARCH, ''), []);
  // Only the agent's own workspace and tools: still nothing outside them.
  assert.deepEqual(
    scan(
      `find ${BENCH} -name '*.ts' | head`,
      `${CELL}/t1/src/a.ts\n${CELL}/bin/x.ts\n${BENCH}/deps/cache/y.ts\n${CELL}/hub/z.ts\n`,
    ),
    [],
  );
});

test('the same search is a hit when its result shows another bench path', () => {
  for (const shown of [
    `${CELL}/t2/packages/rpc-types.ts\n`,
    `${BENCH}/ws/other-cell/t1/rpc-mode.ts\n`,
    `${BENCH}/runs/github-n3-r1-a1/result.json\n`,
    `${BENCH}/tasks.json\n`,
    `${CELL}/bin2/x\n`, // a lookalike of the own bin
  ])
    assert.deepEqual(scan(SEARCH, shown), ['bench-data'], shown);
});

test('a listing of the bench root is judged by whether it listed anything', () => {
  assert.deepEqual(scan(`ls -la ${BENCH}`, `ls: ${BENCH}: Operation not permitted\n`), []);
  assert.deepEqual(scan(`ls ${BENCH}/`, 'ls: /b/forge-bench/b15d/: Permission denied'), []);
  assert.deepEqual(scan(`ls ${BENCH}`, ''), []);
  assert.deepEqual(scan(`ls ${BENCH}`, 'deps\nruns\ntasks.json\nws\n'), ['bench-data']);
  assert.deepEqual(scan(`cd ${BENCH} && ls`, 'runs\nws\n'), ['bench-data']);
});

test('an unknown outcome keeps the command’s meaning', () => {
  assert.deepEqual(scan(SEARCH, undefined), ['bench-data']);
});

test('a specific bench path is a hit whatever it returned', () => {
  for (const bad of [
    `cat ${BENCH}/tasks.json`,
    `ls ${BENCH}/runs`,
    `ls ${BENCH}/ws`,
    `cat ${BENCH}/ws/other-cell/t1/a.ts`,
    `rg -n x ${BENCH}/runs`,
    `rg --files ${BENCH}/forge-cache`,
    `cat /b/forge-bench/b15d-other/x`,
  ])
    assert.deepEqual(scan(bad, ''), ['bench-data'], bad);
});

test('readSession pairs each Codex action with what it returned, wait results included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-transcript-'));
  try {
    const prefix = join(dir, 't1');
    const call = (name, call_id, input) => ({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name, call_id, input },
    });
    const fn = (name, call_id, args) => ({
      type: 'response_item',
      payload: { type: 'function_call', name, call_id, arguments: JSON.stringify(args) },
    });
    const out = (type, call_id, parts) => ({
      type: 'response_item',
      payload: { type, call_id, output: parts.map(text => ({ type: 'input_text', text })) },
    });
    const wrapped = output =>
      JSON.stringify({ chunk_id: 'c', wall_time_seconds: 0.1, output, original_token_count: 3 });
    const lines = [
      { type: 'session_meta', payload: {} },
      call('exec', 'c1', codexExec(`rg --files ${BENCH}`)),
      out('custom_tool_call_output', 'c1', [
        'Script completed\nWall time 0.1 seconds\nOutput:\n',
        wrapped(`${BENCH}/runs/x.json\n`),
      ]),
      call('exec', 'c2', codexExec('sleep 5; ls')),
      out('custom_tool_call_output', 'c2', [
        'Script running with cell ID 31\nWall time 1.0 seconds\nOutput:\n',
      ]),
      fn('wait', 'w1', { cell_id: '31', yield_time_ms: 1000 }),
      out('function_call_output', 'w1', [
        'Script completed\nWall time 4.0 seconds\nOutput:\n',
        JSON.stringify([{ status: 'fulfilled', value: wrapped('file-a\nfile-b\n') }]),
      ]),
    ];
    writeFileSync(`${prefix}.transcript.jsonl`, lines.map(l => JSON.stringify(l)).join('\n'));
    const { actions } = readSession(prefix);
    assert.equal(actions.length, 3);
    assert.equal(actions[0].result, `${BENCH}/runs/x.json\n`);
    assert.match(actions[1].result, /file-a\nfile-b/);
    assert.equal(actions[0].id, 'c1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession pairs each Claude tool_use with its tool_result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-transcript-'));
  try {
    const prefix = join(dir, 't1');
    const lines = [
      {
        message: {
          content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: `ls ${BENCH}` } }],
        },
      },
      {
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'runs\nws' }] },
          ],
        },
      },
    ];
    writeFileSync(`${prefix}.transcript.jsonl`, lines.map(l => JSON.stringify(l)).join('\n'));
    const { actions } = readSession(prefix);
    assert.equal(actions[0].result, 'runs\nws');
    const hits = scanTask({ session: { source: 'transcript', actions, seen: [] }, ...ctx }).hits.map(
      h => h.id,
    );
    assert.deepEqual(hits, ['bench-data']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
