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
