// SPDX-License-Identifier: Apache-2.0
// Contamination audit replay (d8cf81b4): the false-positive classes of the B1.5d real run must
// scan clean, and the true reaches the audit exists for must still void the task. Fixtures are
// synthetic, written from the report's description of the hits (no private excerpts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTask } from '../scripts/bench-t3code/contamination.mjs';

const BENCH = '/b/forge-bench/b15d';
const CELL = `${BENCH}/ws/github-n3-r1-a1-20261104T015045`;
const ctx = {
  prNumbers: [27097, 27514],
  ownPrs: [12],
  workspace: `${CELL}/t1`,
  ownRepo: 'NanthAI/forge-b15d-t3code',
  ownBranches: ['agent-1/t1'],
  toolPaths: [`${CELL}/bin`, `${CELL}/vp`, `${BENCH}/deps`],
};
const ids = (inputs, extra = {}, tool = 'Bash') =>
  scanTask({
    session: { source: 'transcript', actions: inputs.map(input => ({ tool, input })), seen: [] },
    ...ctx,
    ...extra,
  }).hits.map(h => h.id);
const claudeBash = command => JSON.stringify({ command, description: 'x' });
const clean = (inputs, extra) => assert.deepEqual(ids(inputs, extra), [], inputs.join(' | '));
const voids = (input, id, extra) => {
  const found = ids([input], extra);
  assert.ok(found.includes(id), `${input} should hit ${id}, got ${found}`);
};

const FORK = 'repos/NanthAI/forge-b15d-t3code';

test('own-fork gh api reads are not github-history-api hits', () => {
  clean([
    `gh api ${FORK}/rules/branches/main`,
    `gh api ${FORK}/branches/main/protection`,
    `gh api ${FORK}/pulls/12 --jq .mergeable_state`,
    `gh api ${FORK}/pulls/12/comments`,
    `gh api ${FORK}/issues/12/events`,
    `gh api --paginate ${FORK}/branches`,
    `gh api "${FORK}/branches?per_page=100" --jq '.[].name'`,
    `gh api /${FORK}/git/ref/heads/agent-1/t1`,
    'gh api repos/{owner}/{repo}/pulls/12',
    claudeBash(`gh api ${FORK}/rules/branches/main | head`),
  ]);
});

test('github-history-api still catches PR lists, other PRs, compare, refs lists and other repos', () => {
  for (const bad of [
    `gh api ${FORK}/pulls`,
    `gh api "${FORK}/pulls?state=all"`,
    `gh api ${FORK}/pulls/comments`,
    `gh api ${FORK}/issues/7/events`,
    `gh api ${FORK}/events`,
    `gh api ${FORK}/compare/main...agent-2/t2`,
    `gh api ${FORK}/git/refs`,
    `gh api ${FORK}/git/matching-refs/heads/agent`,
    'gh api repos/someone/else/branches',
    'gh api repos/someone/else/issues/12/events',
    'gh api repos/{owner}/{repo}/pulls',
  ])
    voids(bad, 'github-history-api');
  voids('gh api repos/pingdotgg/t3code/pulls/27097', 'upstream');
});

test('the agent’s own cell bin, vp and the shared deps cache are not bench data', () => {
  clean([
    `ls ${CELL}/bin`,
    `cat ${CELL}/bin/nforge-client.mjs`,
    `PATH=${CELL}/bin:$PATH nforge status`,
    `ls ${BENCH}/deps/home`,
    claudeBash(`${BENCH}/deps/vp/bin/vp test run`),
    `${CELL}/vp/bin/vp --version`,
  ]);
});

test('other bench paths are still bench data', () => {
  for (const bad of [
    `cat ${BENCH}/ws/github-n3-r1-a1-20261104T015045/t2/src/a.ts`,
    `cat ${BENCH}/tasks.json`,
    `ls ${BENCH}/runs`,
    `ls ${BENCH}`,
    `cat ${CELL}/bin2/x`,
    `cat ${BENCH}/deps-old/x`,
    `ls ${BENCH}/ws/other-cell/bin`,
  ])
    voids(bad, 'bench-data');
});

test('an issue link in the agent’s own PR text is a mention, not an upstream read', () => {
  const body =
    'Fix the thing.\n\nCloses https://github.com/pingdotgg/t3code/issues/123\nRefs pingdotgg/t3code#123';
  clean([
    `gh pr create --title "Fix" --body "Closes https://github.com/pingdotgg/t3code/issues/123"`,
    claudeBash(`gh pr create --title "Fix" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`),
    'git commit -m "Refs pingdotgg/t3code#123"',
    claudeBash(`git add -A && git commit -m "Fix\n\nCloses https://github.com/pingdotgg/t3code/issues/123"`),
    'gh pr edit 12 --body "Closes https://github.com/pingdotgg/t3code/issues/123"',
    JSON.stringify({ command: ['bash', '-lc', 'gh pr comment 12 --body "see pingdotgg/t3code#123"'] }),
  ]);
  // A write tool carrying the link is no read either.
  assert.deepEqual(ids([JSON.stringify({ file_path: 'PR.md', content: body })], {}, 'Write'), []);
});

test('reads and fetches of upstream still void the task', () => {
  for (const bad of [
    'curl -s https://api.github.com/repos/pingdotgg/t3code/pulls/9',
    'gh pr view https://github.com/pingdotgg/t3code/pull/27097',
    'gh issue view https://github.com/pingdotgg/t3code/issues/123',
    'git fetch https://github.com/pingdotgg/t3code main',
    'git remote add upstream https://github.com/pingdotgg/t3code.git',
    'gh pr create --repo pingdotgg/t3code --title x',
    'gh pr create -R pingdotgg/t3code --title x',
    `node -e "fetch('https://api.github.com/repos/pingdotgg/t3code/pulls')"`,
    claudeBash('cd repo && gh issue view pingdotgg/t3code#123'),
    JSON.stringify({ command: ['bash', '-lc', 'gh pr diff 27097 -R pingdotgg/t3code'] }),
  ])
    voids(bad, 'upstream');
  assert.ok(
    ids([JSON.stringify({ url: 'https://github.com/pingdotgg/t3code/issues/1' })], {}, 'WebFetch').includes(
      'upstream',
    ),
  );
});

test('git ls-remote of the own branch and main is fine; anything wider is history', () => {
  clean([
    'git ls-remote --heads origin main agent-1/t1',
    'git ls-remote origin refs/heads/agent-1/t1',
    'git ls-remote --exit-code origin main',
    'git ls-remote origin gh-readonly-queue/main/pr-12-abcdef',
  ]);
  for (const bad of [
    'git ls-remote origin',
    'git ls-remote --heads origin',
    'git ls-remote origin agent-2/t9',
    'git ls-remote origin main agent-2/t9',
    'git ls-remote https://github.com/NanthAI/forge-b15d-oracle',
    'git log --all --oneline',
  ])
    voids(bad, 'git-history-all');
});

test('the exemptions do not weaken the other pre-registered rules', () => {
  for (const [bad, id] of [
    ['git fetch origin q/27514-ref', 'solution-or-oracle-ref'],
    ['git ls-remote origin oracle/github-n3-r1-a1-20261104T015045', 'solution-or-oracle-ref'],
    ['gh pr list --state merged', 'other-prs'],
    ['gh pr diff 7', 'other-fork-pr'],
    ['git show afb8619e', 'solution-merge-sha'],
  ])
    voids(bad, id, { mergeShas: ['afb8619e1ddcda94388e3cba89f2c1384e85d711'] });
  // A tool path exemption never hides a reach for the oracle under the same prefix.
  voids(`cat ${CELL}/bin/../../oracle/x`, 'solution-or-oracle-ref');
});

// e7e7428c: false positives of the P6 exit bench (n10-r1), from the hit excerpts.
const EXIT_ROOT = '/b/forge-bench/p6exit';
const EXIT_CELL = 'forge-n10-r1-a1-20261108T124112';
const exit = task => ({
  workspace: `${EXIT_ROOT}/ws/${EXIT_CELL}/${task}`,
  benchRoot: EXIT_ROOT,
  toolPaths: [`${EXIT_ROOT}/ws/${EXIT_CELL}/bin`, `${EXIT_ROOT}/deps`],
});
const ownTmp = (task, session = 'cbebbad3-8eec-4102-89c8-d851c2248ab9') =>
  `/private/tmp/claude-501/-b-forge-bench-p6exit-ws-${EXIT_CELL}-${task}/${session}/tasks/baqdehh3u.output`;

test('the agent’s own harness task output (named after its workspace) is not bench data', () => {
  clean(
    [
      claudeBash(`sleep 100; tail -c 1500 ${ownTmp('t19456')}`),
      claudeBash(`until grep -q '"phase"' ${ownTmp('t19456')}; do sleep 5; done`),
      claudeBash(`until [ -s ${ownTmp('t19456')} ]; do sleep 5; done; cat ${ownTmp('t19456')}`),
      `tail -n 5 ${ownTmp('t19456')}`,
    ],
    exit('t19456'),
  );
  // The same name with a dot or another flattening of the workspace path is still its own.
  clean([`cat /var/tmp/${'/b/forge-bench/p6exit/ws/x/t1'.replace(/[/]/g, '_')}/s/out`], {
    workspace: '/b/forge-bench/p6exit/ws/x/t1',
    benchRoot: EXIT_ROOT,
  });
});

test('another cell’s or task’s harness dir, and the bench runs tree, still void as bench data', () => {
  for (const bad of [
    claudeBash(`tail -c 1500 ${ownTmp('t23938')}`), // another task of the same cell
    claudeBash(`cat ${ownTmp('t19456').replace(EXIT_CELL, 'github-n10-r1-a1-20261108T120026')}`),
    claudeBash(`cat ${ownTmp('t19456').replace('t19456/', 't194569/')}`), // a longer name that only starts like its own
    claudeBash(`cat ${ownTmp('t19456')}/../../${EXIT_ROOT}/runs/x/result.json`),
    `cat ${EXIT_ROOT}/runs/${EXIT_CELL}/result.json`,
    `cat ${EXIT_ROOT}/ws/${EXIT_CELL}/t23938/src/a.ts`,
  ])
    voids(bad, 'bench-data', exit('t19456'));
});

test('a redirection after a gh pr verb is not a PR number; a real other PR still voids', () => {
  clean([
    claudeBash('sleep 100; gh pr view --json state,mergedAt; gh pr checks 2>&1 | tail -3'),
    claudeBash('gh pr view --json state,mergeStateStatus | head -20; gh pr checks 2>&1|tail'),
    'gh pr checks 2>/dev/null',
    'gh pr view 12 --json state', // its own PR (ctx.ownPrs)
    'gh pr checks 12 2>&1',
    'gh pr view 7>/dev/null', // digits glued to a redirect are a file descriptor
  ]);
  for (const bad of [
    'gh pr checks 7 2>&1',
    'gh pr diff 7|head',
    'gh pr view 7&& echo',
    'gh pr checks #7',
    'echo https://github.com/NanthAI/x/pull/7',
  ])
    voids(bad, 'other-fork-pr');
});
