// B1.5d GitHub arm: public NanthAI fork, merge queue (HEADGREEN, 10/10, squash),
// required check `bench-check` = `bash .bench/ci.sh` on ubuntu-latest.
// All GitHub reads are finite harness observations; nothing polls while idle.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const repository = 'NanthAI/forge-b15d-t3code';
export const rulesetName = 'b15d-main';
const upstream = 'pingdotgg/t3code';

const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
const api = (path, ...rest) => JSON.parse(gh(['api', ...rest, path]) || 'null');
const pages = path => JSON.parse(gh(['api', '--paginate', '--slurp', path])).flat();

function ruleset() {
  const found = api(`repos/${repository}/rulesets`).find(r => r.name === rulesetName);
  if (!found) throw Error('BENCH_RULESET_MISSING');
  return found.id;
}
function setRuleset(enforcement) {
  gh(['api', '-X', 'PUT', `repos/${repository}/rulesets/${ruleset()}`, '-f', `enforcement=${enforcement}`]);
}

/** Reset main to the frozen base: close open PRs, drop agent branches, force main. */
export function reset(base) {
  // GraphQL-backed gh reads where possible: the REST quota (5,000/h) is shared by
  // every process on this Mac using the owner's gh login.
  for (const pr of JSON.parse(
    gh(['pr', 'list', '-R', repository, '--state', 'open', '-L', '200', '--json', 'number']),
  ))
    gh(['pr', 'close', String(pr.number), '-R', repository]);
  for (const branch of pages(`repos/${repository}/branches?per_page=100`))
    if (branch.name.startsWith('agent-'))
      gh(['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${branch.name}`]);
  setRuleset('disabled');
  try {
    gh([
      'api',
      '-X',
      'PATCH',
      `repos/${repository}/git/refs/heads/main`,
      '-f',
      `sha=${base}`,
      '-F',
      'force=true',
    ]);
  } finally {
    setRuleset('active');
  }
  const head = api(`repos/${repository}/branches/main`).commit.sha;
  if (head !== base) throw Error(`BENCH_RESET_FAILED ${head}`);
  return { main: head, at: new Date().toISOString() };
}

const SPARSE = ['/*', '!/.repos/', '!/apps/mobile/modules/t3-terminal/Vendor/**/*.a'];
/** One local clone per cell (outside cell timing), like a developer's existing clone;
 * task workspaces borrow its objects.
 * Sparse like upstream CI: no reference repos / vendored iOS archives. */
export async function prepareHub(hub) {
  await run('git', [
    'clone',
    '-q',
    '--filter=blob:none',
    '--no-checkout',
    `https://github.com/${repository}`,
    hub,
  ]);
  await run('git', ['-C', hub, 'sparse-checkout', 'set', '--no-cone', ...SPARSE]);
  await run('git', ['-C', hub, 'checkout', '-q', 'main']);
}
/** Per task: a local --shared clone of the hub (seconds, own .git/config so parallel
 * `git push -u` never contends on one config lock), pointed at the fork; blobs outside
 * the hub come lazily from the fork like any blobless clone. */
export async function workspace(hub, dir, branch) {
  const url = `https://github.com/${repository}`;
  await run('git', ['clone', '-q', '--shared', '--no-checkout', hub, dir]);
  await run('git', ['-C', dir, 'remote', 'set-url', 'origin', url]);
  await run('git', ['-C', dir, 'config', 'remote.origin.promisor', 'true']);
  await run('git', ['-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
  await run('git', ['-C', dir, 'fetch', '-q', 'origin', 'main']);
  await run('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...SPARSE]);
  await run('git', ['-C', dir, 'switch', '-q', '--no-track', '-c', branch, 'origin/main']);
  await run('git', ['-C', dir, 'config', 'user.name', 'bench-agent']);
  await run('git', ['-C', dir, 'config', 'user.email', 'bench-agent@users.noreply.github.com']);
  // gh resolves the base repository from GH_REPO, so a PR can never target upstream.
  return { env: { GH_REPO: repository, GIT_TERMINAL_PROMPT: '0' } };
}

/** System-of-record landing: this cell's PR for the head branch and its merged_at.
 * Branch names repeat across cells, so PRs created before dispatch are ignored. */
export function landing(branch, sinceIso) {
  const prs = JSON.parse(
    gh([
      'pr',
      'list',
      '-R',
      repository,
      '--state',
      'all',
      '--head',
      branch,
      '--json',
      'number,createdAt,mergedAt,mergeCommit',
    ]),
  ).filter(pr => pr.createdAt >= sinceIso);
  const merged = prs.find(pr => pr.mergedAt);
  return {
    prs: prs.map(pr => pr.number),
    landed: Boolean(merged),
    mergedAt: merged?.mergedAt ?? null,
    mergeCommit: merged?.mergeCommit?.oid ?? null,
  };
}

/** Runs, check jobs and billed runner minutes for the window; red-main pushes. */
export function windowMetrics(sinceIso, untilIso) {
  const runs = pages(`repos/${repository}/actions/runs?per_page=100&created=>=${sinceIso}`)
    .flatMap(p => p.workflow_runs ?? p)
    .filter(r => r.created_at <= untilIso);
  let jobs = 0,
    billedMinutes = 0,
    jobSeconds = 0;
  for (const run of runs)
    for (const job of api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).jobs) {
      if (!job.started_at || !job.completed_at) continue;
      jobs++;
      const s = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      jobSeconds += s;
      billedMinutes += Math.ceil(s / 60);
    }
  const byEvent = {};
  for (const run of runs) byEvent[run.event] = (byEvent[run.event] ?? 0) + 1;
  const mainPushes = runs.filter(r => r.event === 'push' && r.head_branch === 'main');
  return {
    runs: runs.length,
    byEvent,
    jobs,
    jobSeconds,
    billedMinutes,
    mainPushRuns: mainPushes.length,
    redMainPushRuns: mainPushes.filter(r => r.conclusion && r.conclusion !== 'success').map(r => r.head_sha),
    unfinishedRuns: runs.filter(r => r.status !== 'completed').length,
  };
}

/** Safety audit: no PR by this account reached upstream during the window. */
export function upstreamAudit(sinceIso) {
  const login = api('user').login;
  const found = JSON.parse(
    gh([
      'search',
      'prs',
      '--repo',
      upstream,
      '--author',
      login,
      '--created',
      `>=${sinceIso.slice(0, 10)}`,
      '--json',
      'number,createdAt',
    ]),
  ).filter(pr => pr.createdAt >= sinceIso);
  return { login, upstreamPrs: found.map(pr => pr.number) };
}

export function mainHead() {
  return api(`repos/${repository}/branches/main`).commit.sha;
}

/** Scripted no-model agent: one trivial file through branch, PR, queue, merge. */
export function scriptedAgent(binDir, name) {
  const file = join(binDir, `scripted-${name}.sh`);
  writeFileSync(
    file,
    `#!/bin/bash
set -euo pipefail
branch="$1"; task="$2"
mkdir -p .bench/dry && echo "dry run $task $(date -u +%FT%TZ)" > ".bench/dry/$task.md"
git add .bench/dry && git commit -qm "bench dry run: $task"
git push -q -u origin "$branch"
gh pr create --base main --title "bench dry run: $task" --body "No-model dry run." >/dev/null
gh pr merge --squash --auto >/dev/null
for i in $(seq 1 120); do
  state=$(gh pr view --json state --jq .state)
  [ "$state" = MERGED ] && { echo merged; exit 0; }
  [ "$state" = CLOSED ] && { echo closed; exit 1; }
  sleep 15
done
echo timeout; exit 2
`,
  );
  chmodSync(file, 0o755);
  return file;
}
