// B1.5d GitHub arm: public NanthAI fork, merge queue (HEADGREEN, 10/10, squash),
// required check `bench-check` = `bash .bench/ci.sh` on ubuntu-latest.
// All GitHub reads are finite harness observations; nothing polls while idle.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chronologicalJobs, parseRunnerLog } from './runners.mjs';
import { oracleBranchCell } from './oracle-branches.mjs';

const run = promisify(execFile);
export const repository = 'NanthAI/forge-b15d-t3code';
export const rulesetName = 'b15d-main';
const upstream = 'pingdotgg/t3code';
// Agents' clones see main only (B1): no other branch of the fork is ever fetched.
export const REFSPEC = '+refs/heads/main:refs/remotes/origin/main';

const gh = async args => (await run('gh', args, { maxBuffer: 256 << 20 })).stdout;
const api = async (path, ...rest) => JSON.parse((await gh(['api', ...rest, path])) || 'null');
const pages = async path => JSON.parse(await gh(['api', '--paginate', '--slurp', path])).flat();

// GitHub's stored timestamps can disagree with real time: on 2026-11-01 every read (REST
// and GraphQL: PRs, runs, jobs, comments, statuses) returned times one hour ahead, while
// the create response, GitHub's HTTP Date header, Convex and the Mac agreed. The harness
// measures that read offset (create a commit status on the fixed base commit, read it back,
// compare with the local request midpoint) and converts every GitHub time it compares with
// local time.
let skewMs = 0;
export const fromGithub = iso => (iso ? new Date(Date.parse(iso) - skewMs).toISOString() : iso);
export const toGithub = iso => (iso ? new Date(Date.parse(iso) + skewMs).toISOString() : iso);
export async function measureSkew(sha, { api: call = api, now = Date.now, pause = wait } = {}) {
  const sent = now();
  const created = await call(
    `repos/${repository}/statuses/${sha}`,
    '-X',
    'POST',
    '-f',
    'state=success',
    '-f',
    'context=bench-clock-probe',
    '-f',
    'description=B1.5d clock probe (harness)',
  );
  const received = now();
  const createResponseSkewMs = Math.round(Date.parse(created.created_at) - (sent + received) / 2);
  // A successful POST can precede list visibility. Retry the read, never the write;
  // keep the POST midpoint even when read visibility takes seconds. Page through
  // concurrent statuses too, with finite request/memory budgets on a busy SHA.
  const delays = [0, 250, 500, 1000, 2000, 4000];
  let stored,
    readAttempts = 0,
    readPages = 0;
  for (const delay of delays) {
    if (delay) await pause(delay);
    readAttempts++;
    for (let page = 1; page <= 10; page++) {
      const statuses = await call(
        `repos/${repository}/statuses/${sha}?per_page=100&page=${page}`,
        '-H',
        'Cache-Control: no-cache',
      );
      readPages++;
      stored = statuses.find(st => st.id === created.id);
      if (stored || statuses.length < 100) break;
    }
    if (stored) break;
  }
  // Do not fall back to the POST timestamp: the probe measures the read surface,
  // which has previously disagreed with the create response by an hour.
  if (!stored)
    throw Object.assign(
      Error(
        `BENCH_CLOCK_PROBE_NOT_FOUND: status ${created.id} on ${sha} after ${readAttempts} attempts / ${readPages} pages (createResponseSkewMs=${createResponseSkewMs})`,
      ),
      { code: 'BENCH_CLOCK_PROBE_NOT_FOUND' },
    );
  if (!Number.isFinite(Date.parse(stored.created_at)))
    throw Error(`BENCH_CLOCK_PROBE_INVALID_TIMESTAMP: status ${created.id}`);
  skewMs = Math.round(Date.parse(stored.created_at) - (sent + received) / 2);
  return {
    skewMs,
    createResponseSkewMs,
    roundTripMs: received - sent,
    at: new Date(received).toISOString(),
    statusId: created.id,
    readAttempts,
    readPages,
  };
}

/** Branches of the fork; only main and this harness's agent-* branches may exist. */
export async function branches() {
  return (await pages(`repos/${repository}/branches?per_page=100`)).map(b => b.name);
}
export const foreignBranches = names => names.filter(n => n !== 'main' && !n.startsWith('agent-'));

/** Reset requests have fixed targets and are outside cell timing. Preserve the final error. */
export async function retryResetRequest(request, pause = wait) {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const text = `${error.stderr ?? ''}\n${error.message ?? ''}`;
      const transient = /\bHTTP(?:\/\d(?:\.\d)?)?\s+5\d\d\b|\bGraphQL:[^\n]*\b50[0-9]\b/i.test(text);
      if (!transient || attempt === delays.length) throw error;
      await pause(delays[attempt]);
    }
  }
}

/** Reset main to the frozen base: close open PRs, drop agent branches, force main.
 * `finishedCell(cellId)` says whether a cell of this harness's ledger has ended; the grading
 * branch (oracle/<cellId>) of such a cell is removed here, because a network blip can leave
 * it behind. Any other non-agent branch still fails the reset (BENCH_FORK_NOT_CLEAN). */
export async function reset(base, { request = gh, pause = wait, finishedCell = () => false } = {}) {
  const gh = args => retryResetRequest(() => request(args), pause);
  const api = async (path, ...rest) => JSON.parse((await gh(['api', ...rest, path])) || 'null');
  const branches = async () =>
    JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repository}/branches?per_page=100`]))
      .flat()
      .map(b => b.name);
  const setRuleset = async enforcement => {
    const found = (await api(`repos/${repository}/rulesets`)).find(r => r.name === rulesetName);
    if (!found) throw Error('BENCH_RULESET_MISSING');
    await gh([
      'api',
      '-X',
      'PUT',
      `repos/${repository}/rulesets/${found.id}`,
      '-f',
      `enforcement=${enforcement}`,
    ]);
  };
  for (const pr of JSON.parse(
    await gh(['pr', 'list', '-R', repository, '--state', 'open', '-L', '200', '--json', 'number']),
  ))
    await gh(['pr', 'close', String(pr.number), '-R', repository]);
  const names = await branches();
  const staleOracle = names.filter(n => {
    const cell = oracleBranchCell(n);
    return cell && finishedCell(cell);
  });
  for (const name of [...names.filter(n => n.startsWith('agent-')), ...staleOracle])
    await gh(['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${name}`]);
  await setRuleset('disabled');
  try {
    await gh([
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
    await setRuleset('active');
  }
  const head = (await api(`repos/${repository}/branches/main`)).commit.sha;
  if (head !== base) throw Error(`BENCH_RESET_FAILED ${head}`);
  const foreign = foreignBranches(await branches());
  if (foreign.length) throw Error(`BENCH_FORK_NOT_CLEAN ${foreign.slice(0, 5).join(' ')}`);
  return {
    main: head,
    remaining: 0,
    at: new Date().toISOString(),
    ...(staleOracle.length ? { removedOracleBranches: staleOracle } : {}),
  };
}

/** One local clone per cell (outside cell timing), like a developer's existing clone: main
 * only, the FULL tree (.repos included, same files as a Forge Lane). Blobless history; the
 * checkout brings every blob of main into the hub, which the task workspaces share. */
export async function prepareHub(hub) {
  await run('git', [
    'clone',
    '-q',
    '--filter=blob:none',
    '--single-branch',
    '--branch',
    'main',
    '--no-tags',
    `https://github.com/${repository}`,
    hub,
  ]);
  await run('git', ['-C', hub, 'config', 'remote.origin.fetch', REFSPEC]);
}
/** Per task: a --shared clone of the hub (own .git/config), pointed at the fork, main only.
 * Returns each step's seconds. */
export async function workspace(hub, dir, branch) {
  const phases = {};
  let t = Date.now();
  const lap = k => ((phases[k] = (Date.now() - t) / 1000), (t = Date.now()));
  const url = `https://github.com/${repository}`;
  await run('git', [
    'clone',
    '-q',
    '--shared',
    '--no-checkout',
    '--single-branch',
    '--branch',
    'main',
    hub,
    dir,
  ]);
  lap('clone');
  await run('git', ['-C', dir, 'remote', 'set-url', 'origin', url]);
  await run('git', ['-C', dir, 'config', 'remote.origin.fetch', REFSPEC]);
  // Its own branch too (a glob, so fetching before the first push is fine): `git push -u`
  // then records origin/<branch>, which `gh pr create` needs, as in a normal clone.
  await run('git', [
    '-C',
    dir,
    'config',
    '--add',
    'remote.origin.fetch',
    `+refs/heads/${branch}*:refs/remotes/origin/${branch}*`,
  ]);
  await run('git', ['-C', dir, 'config', 'remote.origin.promisor', 'true']);
  await run('git', ['-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
  await run('git', ['-C', dir, 'config', 'remote.origin.tagOpt', '--no-tags']);
  lap('config');
  await run('git', ['-C', dir, 'fetch', '-q', 'origin']);
  lap('fetch');
  await run('git', ['-C', dir, 'switch', '-q', '--no-track', '-c', branch, 'origin/main']);
  await run('git', ['-C', dir, 'config', 'user.name', 'bench-agent']);
  await run('git', ['-C', dir, 'config', 'user.email', 'bench-agent@users.noreply.github.com']);
  lap('switch');
  return phases;
}

// Cell membership by id, not time: PR numbers and run ids only grow, while GitHub served objects
// created 08:00-09:00 UTC on 2026-11-01 one hour late on every read, so an older PR or run
// could fall inside a later cell's time window. markFloors records the highest PR number and
// run id at cell start; only newer ones belong to the cell.
const floors = { prs: null, runs: new Map() };
export async function markFloors(repos) {
  const prs = JSON.parse(
    await gh(['pr', 'list', '-R', repository, '--state', 'all', '-L', '100', '--json', 'number']),
  );
  floors.prs = Math.max(0, ...prs.map(pr => pr.number));
  for (const repo of repos) {
    const runs = (await api(`repos/${repo}/actions/runs?per_page=100`)).workflow_runs ?? [];
    floors.runs.set(repo, Math.max(0, ...runs.map(r => r.id)));
  }
  return { prs: floors.prs, runs: Object.fromEntries(floors.runs) };
}

async function prsFor(branch, sinceIso) {
  return JSON.parse(
    await gh([
      'pr',
      'list',
      '-R',
      repository,
      '--state',
      'all',
      '--head',
      branch,
      '--json',
      'number,createdAt,mergedAt,mergeCommit,state,autoMergeRequest',
    ]),
  )
    .map(pr => ({ ...pr, createdAt: fromGithub(pr.createdAt), mergedAt: fromGithub(pr.mergedAt) }))
    .filter(pr => (floors.prs === null ? pr.createdAt >= sinceIso : pr.number > floors.prs));
}

/** This cell's PR for the head branch. Waits (bounded) while a PR is still queued for merge
 * after the agent exits, so a late merge is counted, not left racing the oracle (B7). */
export async function landing(
  branch,
  sinceIso,
  { deadlineMs = 20 * 60_000, pollMs = 30_000, agentExitedAt = Date.now() } = {},
) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const prs = await prsFor(branch, sinceIso);
    const merged = prs.find(pr => pr.mergedAt);
    const queued = prs.filter(pr => pr.state === 'OPEN' && pr.autoMergeRequest);
    if (merged || !queued.length || Date.now() > until)
      return {
        prs: prs.map(pr => pr.number),
        landed: Boolean(merged),
        state: merged ? 'landed' : queued.length ? 'in-flight-at-deadline' : (prs.at(-1)?.state ?? 'no-pr'),
        mergedAt: merged?.mergedAt ?? null,
        mergeCommit: merged?.mergeCommit?.oid ?? null,
        landedAfterAgentExit: merged ? Date.parse(merged.mergedAt) > agentExitedAt : null,
        inFlight: merged ? [] : queued.map(pr => pr.number),
      };
    await wait(pollMs);
  }
}

/** Wait until no PR is queued for merge (before grading). */
export async function settleQueue({ deadlineMs = 30 * 60_000, pollMs = 30_000 } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const open = JSON.parse(
      await gh([
        'pr',
        'list',
        '-R',
        repository,
        '--state',
        'open',
        '-L',
        '200',
        '--json',
        'number,autoMergeRequest',
      ]),
    );
    const queued = open.filter(pr => pr.autoMergeRequest).map(pr => pr.number);
    if (!queued.length) return { settled: true, queued };
    if (Date.now() > until) return { settled: false, queued };
    await wait(pollMs);
  }
}

/** Workflow runs of a repository in a window, grading runs (oracle/*, dispatch) excluded. */
export async function windowRuns(repo, sinceIso, untilIso, keep = () => true) {
  return (await pages(`repos/${repo}/actions/runs?per_page=100&created=>=${toGithub(sinceIso)}`))
    .flatMap(p => p.workflow_runs ?? p)
    .filter(
      r =>
        r.created_at <= toGithub(untilIso) &&
        (!floors.runs.has(repo) || r.id > floors.runs.get(repo)) &&
        !String(r.head_branch).startsWith('oracle/') &&
        keep(r),
    );
}

/** Wait (bounded) until every kept run in the window has finished, so its minutes are whole. */
export async function settleRuns(repo, sinceIso, keep, { deadlineMs = 15 * 60_000, pollMs = 30_000 } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const open = (
      await windowRuns(repo, sinceIso, new Date(Date.now() + 3600_000).toISOString(), keep)
    ).filter(r => r.status !== 'completed');
    if (!open.length || Date.now() > until) return { settled: !open.length, open: open.map(r => r.id) };
    await wait(pollMs);
  }
}

/** Forge check runs of one project: forge-check/<id> runs whose plan job log names it. */
export async function projectCheckRuns(repo, projectId, sinceIso, untilIso) {
  const runs = await windowRuns(repo, sinceIso, untilIso, r => String(r.name).startsWith('forge-check/'));
  const mine = [];
  for (const r of runs) {
    const jobs = (await api(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`)).jobs;
    const plan = jobs.find(j => j.name === 'hosted-plan') ?? jobs[0];
    const log = plan ? await gh(['api', `repos/${repo}/actions/jobs/${plan.id}/logs`]).catch(() => '') : '';
    if (log.includes(projectId)) mine.push(r);
  }
  return { runs: mine, otherProjectRuns: runs.length - mine.length };
}

/** Jobs, job seconds and billed minutes of runs (the same shape for both arms, S2). */
export async function jobMetrics(repo, runs, { api: call = api } = {}) {
  let jobs = 0,
    billedMinutes = 0,
    jobSeconds = 0,
    queueSeconds = 0;
  const records = new Map();
  for (const r of runs) {
    for (let page = 1; ; page++) {
      const result = await call(
        `repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100&page=${page}`,
      );
      for (const job of result.jobs) records.set(job.id, { ...job, runId: r.id });
      if (result.jobs.length < 100) break;
    }
  }
  const jobRecords = chronologicalJobs(
    [...records.values()].map(job => ({
      jobId: job.id,
      runId: job.runId,
      name: job.name,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      conclusion: job.conclusion,
      status: job.status,
      createdAt: job.created_at,
    })),
  );
  for (const job of jobRecords) {
    // Retain skipped/unfinished jobs as evidence, without billing them as completed jobs.
    if (!job.startedAt || !job.completedAt || job.conclusion === 'skipped') continue;
    const s = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000;
    if (s <= 0) continue;
    jobs++;
    jobSeconds += s;
    billedMinutes += Math.ceil(s / 60);
    queueSeconds += Math.max(0, (Date.parse(job.startedAt) - Date.parse(job.createdAt)) / 1000);
  }
  const jobIds = jobRecords.map(j => j.jobId);
  const started = jobRecords.filter(
    j => j.conclusion !== 'skipped' && Number.isFinite(Date.parse(j.startedAt)),
  );
  const byEvent = {};
  for (const r of runs) byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
  return {
    runs: runs.length,
    byEvent,
    jobs,
    jobSeconds,
    billedMinutes,
    queueSeconds,
    unfinishedRuns: runs.filter(r => r.status !== 'completed').length,
    firstJob: started[0]?.jobId ?? null,
    lastJob: started.at(-1)?.jobId ?? null,
    jobIds,
    jobRecords,
  };
}

/** Runner image and resolved action SHAs from one job's log header (S6). */
export async function runnerInfo(repo, jobId) {
  if (!jobId) return null;
  try {
    const log = await gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
    return { jobId, ...parseRunnerLog(log) };
  } catch (error) {
    return { jobId, error: String(error.message).slice(0, 200) };
  }
}

/** Runs, check jobs, billed minutes, red-main pushes for the GitHub arm's window. */
export async function windowMetrics(sinceIso, untilIso, branchPrs = new Map()) {
  const runs = await windowRuns(repository, sinceIso, untilIso, r => r.event !== 'workflow_dispatch');
  const metrics = await jobMetrics(repository, runs);
  const mainPushes = runs.filter(r => r.event === 'push' && r.head_branch === 'main');
  return {
    ...metrics,
    mainPushRuns: mainPushes.length,
    redMainPushRuns: mainPushes.filter(r => r.conclusion && r.conclusion !== 'success').map(r => r.head_sha),
    runList: runs.map(r => ({
      id: r.id,
      event: r.event,
      head_branch: r.head_branch,
      head_sha: r.head_sha,
      conclusion: r.conclusion,
      created_at: r.created_at,
      updated_at: r.updated_at,
      // pull_request runs often carry no PR link: their head branch names the task's PR.
      pr:
        r.pull_requests?.[0]?.number ??
        (Number(String(r.head_branch).match(/\/pr-(\d+)-/)?.[1]) || branchPrs.get(r.head_branch) || null),
    })),
  };
}

/** Safety audit: no PR by this account reached upstream during the window. */
export async function upstreamAudit(sinceIso) {
  const login = (await api('user')).login;
  const found = JSON.parse(
    await gh([
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
  ).filter(pr => fromGithub(pr.createdAt) >= sinceIso);
  return { login, upstreamPrs: found.map(pr => pr.number) };
}

export async function mainHead() {
  return (await api(`repos/${repository}/branches/main`)).commit.sha;
}

/** Scripted no-model agent: one file of its own plus a line in its overlap group's shared
 * file, through branch, PR, queue and merge; on a conflict it merges main, keeps both
 * lines, pushes and re-queues (so the coordination counters see real rework). */
export function scriptedAgent(binDir) {
  const file = join(binDir, 'scripted-github.sh');
  writeFileSync(
    file,
    `#!/bin/bash
set -uo pipefail
branch="$1"; task="$2"; group="$3"
mkdir -p .bench/dry && echo "dry run $task $(date -u +%FT%TZ)" > ".bench/dry/$task.md"
[ -n "$group" ] && echo "$task" >> ".bench/dry/group-$group.md"
git add .bench/dry && git commit -qm "bench dry run: $task" || exit 3
for p in 1 2 3; do git push -q -u origin "$branch" && break; sleep 10; done
gh pr create --base main --title "bench dry run: $task" --body "No-model dry run." >/dev/null || exit 4
gh pr merge --squash --auto >/dev/null
for i in $(seq 1 160); do
  read -r state merge auto < <(gh pr view --json state,mergeStateStatus,autoMergeRequest --jq '[.state, .mergeStateStatus, (.autoMergeRequest != null)] | @tsv')
  [ "$state" = MERGED ] && { echo merged; exit 0; }
  [ "$state" = CLOSED ] && { echo closed; exit 1; }
  if [ "$merge" = DIRTY ] || [ "$auto" = false ]; then
    git fetch -q origin
    if ! git merge -q --no-edit origin/main; then
      git checkout origin/main -- ".bench/dry/group-$group.md" && echo "$task" >> ".bench/dry/group-$group.md"
      git add .bench/dry && git commit -qm "bench dry run: merge main ($task)" && echo 'bench: conflict resolved'
    fi
    git push -q origin "$branch"; gh pr merge --squash --auto >/dev/null
  fi
  sleep 15
done
echo timeout; exit 2
`,
  );
  chmodSync(file, 0o755);
  return file;
}
