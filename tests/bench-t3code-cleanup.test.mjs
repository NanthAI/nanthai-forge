// SPDX-License-Identifier: Apache-2.0
// Bench harness cleanup: oracle branches that survive a network blip (02ee5788) and cleanup
// diagnostics from the CLI's stderr (108a4883). No network, no bench data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reset, rulesetName } from '../scripts/bench-t3code/github-arm.mjs';
import { runOracle } from '../scripts/bench-t3code/oracle.mjs';
import {
  cellFinished,
  DELETE_BACKOFF_MS,
  MAX_DELETE_TRIES,
  deleteRefWithBackoff,
  oracleBranchCell,
  oracleBranchRecord,
} from '../scripts/bench-t3code/oracle-branches.mjs';
import { nextBatch, SETUP_ONLY } from '../scripts/bench-t3code/plan.mjs';
import { forgeArm } from '../scripts/bench-t3code/forge-arm.mjs';

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const GITHUB_CELL = 'github-n3-r1-a1-20261104T015045';
const FORGE_CELL = 'forge-n3-r1-a1-20261104T015045';
const blip = Object.assign(Error('gh failed'), { stderr: 'error connecting to api.github.com' });

test('oracle branch names map to cell ids only for the harness’s exact pattern', () => {
  assert.equal(oracleBranchCell(`oracle/${GITHUB_CELL}`), GITHUB_CELL);
  assert.equal(
    oracleBranchCell(`oracle/forge-n10-r2-dry-a3-20261104T015045`),
    'forge-n10-r2-dry-a3-20261104T015045',
  );
  for (const other of [
    'oracle/anything',
    `oracle/${GITHUB_CELL}-extra`,
    `x/oracle/${GITHUB_CELL}`,
    `oracle/../${GITHUB_CELL}`,
    `agent-1/${GITHUB_CELL}`,
    'main',
    'q/27514-ref',
  ])
    assert.equal(oracleBranchCell(other), null, other);
});

test('branch delete never exceeds 5 tries with the default backoff', async () => {
  assert.equal(MAX_DELETE_TRIES, 5);
  let calls = 0;
  const slept = [];
  const r = await deleteRefWithBackoff(
    async () => {
      calls++;
      throw blip;
    },
    'p',
    { pause: async ms => slept.push(ms) },
  );
  assert.equal(calls, 5);
  assert.equal(r.attempts, 5);
  assert.equal(r.deleted, false);
  assert.deepEqual(slept, DELETE_BACKOFF_MS);
});

test('branch delete retries every failure with backoff and records a final failure', async () => {
  let calls = 0;
  const delays = [];
  const ok = await deleteRefWithBackoff(
    async () => {
      if (++calls < 4) throw blip;
    },
    'repos/x/y/git/refs/heads/oracle/c',
    { pause: async ms => delays.push(ms) },
  );
  assert.deepEqual(ok, { deleted: true, attempts: 4 });
  assert.deepEqual(delays, [5000, 15_000, 45_000]);
  calls = 0;
  const failed = await deleteRefWithBackoff(
    async () => {
      calls++;
      throw blip;
    },
    'p',
    { pause: async () => {}, delays: [1, 1] },
  );
  assert.equal(calls, 3);
  assert.deepEqual(failed, { deleted: false, attempts: 3, error: 'error connecting to api.github.com' });
  // Already gone is success, not a failure to record.
  assert.deepEqual(
    await deleteRefWithBackoff(
      async () => {
        throw Object.assign(Error('x'), { stderr: 'gh: Reference does not exist (HTTP 422)' });
      },
      'p',
      { pause: async () => {} },
    ),
    { deleted: true, attempts: 1 },
  );
});

test(
  'a grading run that fails mid-way still records its branch cleanup outcome',
  async () => {
    const calls = [];
    const report = {};
    await assert.rejects(
      // meta is not a git directory, so the push fails like a dropped connection would.
      runOracle(
        { meta: '/nonexistent/bench-meta', branch: `oracle/${GITHUB_CELL}`, commit: 'abc' },
        '/dev/null',
        report,
        {
          request: async args => {
            calls.push(args);
            throw blip;
          },
          deleteBackoff: { pause: async () => {}, delays: [1, 1] },
        },
      ),
    );
    assert.equal(report.branch.name, `oracle/${GITHUB_CELL}`);
    assert.equal(report.branch.deleted, false, 'a delete that kept failing is recorded');
    assert.match(report.branch.error, /api\.github\.com/);
    assert.equal(calls.length, 3);
    assert.equal(report.branch.attempts, 3);
    assert.ok(calls.every(a => a.includes('DELETE')));
  },
  4 * 60_000,
);

test('cellFinished: a result or a dead process; unknown or running cells are not finished', t => {
  const runs = temp(t);
  const cell = (id, files) => {
    mkdirSync(join(runs, id));
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(runs, id, name), JSON.stringify(body));
  };
  cell(GITHUB_CELL, { 'cell.json': { pid: 111 }, 'result.json': { voided: ['x'] } });
  cell('github-n3-r1-a2-20261104T030000', { 'cell.json': { pid: 222 } });
  cell('forge-n3-r1-a2-20261104T030000', { 'cell.json': { pid: 333 } });
  const alive = pid => pid === 222;
  assert.equal(cellFinished(runs, GITHUB_CELL, alive), true);
  assert.equal(cellFinished(runs, 'github-n3-r1-a2-20261104T030000', alive), false, 'still running');
  assert.equal(cellFinished(runs, 'forge-n3-r1-a2-20261104T030000', alive), true, 'died without a result');
  assert.equal(cellFinished(runs, 'github-n9-r9-a9-20261104T999999', alive), false, 'not in the ledger');
});

const resetRequest = (state, calls) => async args => {
  calls.push(args);
  if (args[0] === 'pr') return '[]';
  if (args.includes('--slurp')) return JSON.stringify([state.branches.map(name => ({ name }))]);
  if (args.at(-1).endsWith('/rulesets')) return JSON.stringify([{ id: 1, name: rulesetName }]);
  if (args.at(-1).endsWith('/branches/main')) return JSON.stringify({ commit: { sha: 'synthetic-base' } });
  const del = args.at(-1).match(/git\/refs\/heads\/(.+)$/);
  if (args.includes('DELETE') && del) state.branches = state.branches.filter(b => b !== del[1]);
  return '{}';
};

test('reset removes oracle branches of finished cells instead of refusing', async () => {
  const state = {
    branches: ['main', `oracle/${GITHUB_CELL}`, `oracle/${FORGE_CELL}`, 'agent-1/t1'],
  };
  const calls = [];
  const receipt = await reset('synthetic-base', {
    request: resetRequest(state, calls),
    pause: async () => {},
    finishedCell: id => id === GITHUB_CELL || id === FORGE_CELL,
  });
  assert.deepEqual(receipt.removedOracleBranches, [`oracle/${GITHUB_CELL}`, `oracle/${FORGE_CELL}`]);
  assert.deepEqual(state.branches, ['main']);
  const deleted = calls.filter(a => a.includes('DELETE')).map(a => a.at(-1).split('heads/')[1]);
  assert.deepEqual(deleted.sort(), ['agent-1/t1', `oracle/${FORGE_CELL}`, `oracle/${GITHUB_CELL}`].sort());
});

test('reset still refuses an oracle branch of a running or unknown cell, and any other branch', async () => {
  for (const branch of [`oracle/${GITHUB_CELL}`, 'oracle/hand-made', 'feature/x', 'q/27514-ref']) {
    const state = { branches: ['main', branch] };
    const calls = [];
    await assert.rejects(
      reset('synthetic-base', {
        request: resetRequest(state, calls),
        pause: async () => {},
        finishedCell: () => false,
      }),
      /BENCH_FORK_NOT_CLEAN/,
      branch,
    );
    assert.ok(!calls.some(a => a.includes('DELETE')), `${branch} must not be deleted`);
  }
});

test('a batch whose cells all crashed before any agent ran is not a consumed attempt', () => {
  // [void, setup-only, setup-only] re-runs; two real void attempts stop; setup retries are bounded.
  assert.equal(nextBatch([[true, SETUP_ONLY]]), 0, 'one real void + one setup-only: one attempt left');
  assert.equal(nextBatch([[SETUP_ONLY, SETUP_ONLY], []]), 0, 'two setup-only crashes: still unconsumed');
  assert.equal(nextBatch([[SETUP_ONLY, SETUP_ONLY, SETUP_ONLY], []]), 1, 'setup retries are capped (2)');
  assert.equal(nextBatch([[true, true, SETUP_ONLY], []]), 1, 'two real voids still stop the batch');
  assert.equal(nextBatch([[SETUP_ONLY, false], []]), 1, 'a valid attempt ends it');
  assert.equal(nextBatch([[true], []]), 0, 'unchanged: one real void re-runs');
});

test('abandonById keeps the structured error the CLI wrote to stderr', async t => {
  const dir = temp(t);
  const cli = join(dir, 'cli.mjs');
  writeFileSync(
    cli,
    `console.log(JSON.stringify({event:'progress'}));
console.error(JSON.stringify({error:{code:'LANE_NOT_ABANDONABLE',message:'Lane has an active landing'}}));
process.exit(1);`,
  );
  const arm = forgeArm({ cli }, { callLog: join(dir, 'calls.jsonl'), ws: dir });
  const r = await arm.abandonById('11111111-1111-4111-8111-111111111111', 'bench cleanup', dir);
  assert.equal(r.code, 'LANE_NOT_ABANDONABLE');
  assert.equal(r.message, 'Lane has an active landing');
  assert.equal(r.error, 'LANE_NOT_ABANDONABLE: Lane has an active landing');
  // A CLI that dies without a structured error still reports something readable.
  writeFileSync(cli, `console.error('plain failure'); process.exit(2);`);
  const plain = await arm.abandonById('11111111-1111-4111-8111-111111111111', 'bench cleanup', dir);
  assert.match(plain.error, /^ERROR: /);
  assert.ok(plain.message.length > 0);
});

test('batch ledger keeps a failed oracle branch delete', () => {
  const branchCleanup = { name: `oracle/${GITHUB_CELL}`, deleted: false, attempts: 5, error: 'blip' };
  assert.deepEqual(oracleBranchRecord({ oracle: { error: 'x', branchCleanup } }), branchCleanup);
  assert.equal(oracleBranchRecord({ oracle: { error: 'x' } }), null);
  assert.equal(oracleBranchRecord(null), null);
});

test('replay of 2026-11-04: grading drops, deletes fail, the next cell still resets', async t => {
  const runs = temp(t);
  const calls = [];
  const state = { branches: ['main'] };
  // Cell a1: push fails like a dropped connection; every delete fails; the cell ends void.
  const report = {};
  await assert.rejects(
    runOracle(
      { meta: '/nonexistent/bench-meta', branch: `oracle/${GITHUB_CELL}`, commit: 'abc' },
      '/dev/null',
      report,
      {
        request: async args => {
          calls.push(args);
          throw blip;
        },
        deleteBackoff: { pause: async () => {} },
      },
    ),
  );
  assert.equal(report.branch.deleted, false);
  assert.equal(report.branch.attempts, 5);
  assert.equal(calls.length, 5, 'bounded by the retry cap');
  // The branch is still on the fork; the void cell wrote its result with the cleanup record.
  state.branches.push(`oracle/${GITHUB_CELL}`);
  mkdirSync(join(runs, GITHUB_CELL));
  writeFileSync(
    join(runs, GITHUB_CELL, 'result.json'),
    JSON.stringify({
      voided: ['oracle: error connecting to api.github.com'],
      oracle: { branchCleanup: report.branch },
    }),
  );
  assert.equal(
    oracleBranchRecord(JSON.parse(readFileSync(join(runs, GITHUB_CELL, 'result.json'), 'utf8'))).deleted,
    false,
  );
  // Cell a2 resets: the finished cell's branch is removed (real cellFinished over the ledger).
  const resetCalls = [];
  const receipt = await reset('synthetic-base', {
    request: resetRequest(state, resetCalls),
    pause: async () => {},
    finishedCell: id => cellFinished(runs, id),
  });
  assert.deepEqual(receipt.removedOracleBranches, [`oracle/${GITHUB_CELL}`]);
  assert.deepEqual(state.branches, ['main']);
});
