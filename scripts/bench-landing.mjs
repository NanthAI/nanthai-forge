// SPDX-License-Identifier: Apache-2.0
// Compare landing the same small change through Forge and through Git+GitHub.
// Usage: node scripts/bench-landing.mjs --source OWNER [--dry-run] [options]; see docs/development.md.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  githubWorkflow,
  parseProgressLine,
  SCENARIOS,
  finishPhases,
  finishUntilLanded,
  githubCheckTimes,
  renderMarkdown,
  repoName,
  runRecordTimes,
  scenarioEdits,
} from './bench-landing-lib.mjs';
import {
  loadManifest,
  createRepo,
  cleanupRepos,
  configureGithub,
  requiredRuleset,
  setupForgeTarget,
  mergeGithub,
} from './bench-landing-github.mjs';
import { prepareGithubClone, seedNativeGit } from './bench-landing-seed.mjs';
import { PAIRS, runnerPolicy, burstMetrics, actionsCost } from './bench-landing-v2.mjs';

export function parseArgs(argv) {
  const pair = argv.includes('--pair') ? argv[argv.indexOf('--pair') + 1] : undefined;
  if (pair && !PAIRS[pair]) throw new Error('Pair: P1|P2|P3|P4');
  const options = {
    pair: pair ?? 'custom',
    visibility: 'private',
    forgeRunner: 'local',
    forgeRunsOn: 'ubuntu-latest',
    ghRunsOn: 'ubuntu-latest',
    ghShards: 1,
    burst: [4],
    runs: 3,
    scenarios: SCENARIOS,
    forgeOwner: 'throwaway',
    sides: ['forge', 'github'],
    ...PAIRS[pair],
  };
  const value = flag => {
    const next = argv[++i];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--pair') value(flag);
    else if (flag === '--gh-runs-on') options.ghRunsOn = value(flag);
    else if (flag === '--gh-shards') options.ghShards = Number(value(flag));
    else if (flag === '--forge-runs-on') options.forgeRunsOn = value(flag);
    else if (flag === '--gh-merge-queue') options.ghMergeQueue = true;
    else if (flag === '--burst') options.burst = value(flag).split(',').map(Number);
    else if (flag === '--source') options.source = resolve(value(flag));
    else if (flag === '--forge-owner') options.forgeOwner = value(flag);
    else if (flag === '--runs') options.runs = Number(value(flag));
    else if (flag === '--scenarios') options.scenarios = value(flag).split(',');
    else if (flag === '--sides') options.sides = value(flag).split(',');
    else if (flag === '--github-owner') options.githubOwner = value(flag);
    else if (flag === '--visibility') options.visibility = value(flag);
    else if (flag === '--github-repo') options.githubRepo = value(flag);
    else if (flag === '--github-mirror') options.githubMirror = value(flag);
    else if (flag === '--hosted') options.hosted = true;
    else if (flag === '--forge-runner') options.forgeRunner = value(flag);
    else if (flag === '--work') options.work = resolve(value(flag));
    else if (flag === '--out') options.out = resolve(value(flag));
    else if (flag === '--max-minutes') options.maxMinutes = Number(value(flag));
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--cleanup') options.cleanup = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!options.source) throw new Error('--source NATIVE_OWNER is required');
  if (!['throwaway', 'source'].includes(options.forgeOwner))
    throw new Error('--forge-owner is throwaway|source');
  if (!(options.runs >= 3)) throw new Error('--runs must be at least 3');
  if (options.scenarios.some(s => !SCENARIOS.includes(s)))
    throw new Error(`Scenarios: ${SCENARIOS.join(',')}`);
  if (options.sides.some(s => !['forge', 'github'].includes(s))) throw new Error('Sides: forge,github');
  if (!['local', 'modal', 'github-actions'].includes(options.forgeRunner))
    throw new Error('Forge runner: local|modal|github-actions');
  if (![options.ghShards, ...options.burst, options.runs].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error('Shards, burst and runs must be positive integers');
  if (!['public', 'private'].includes(options.visibility)) throw new Error('Visibility: public|private');
  const date = new Date();
  options.work ??= join(os.tmpdir(), `forge-bench-${date.toISOString().slice(0, 10)}-${options.pair}`);
  options.out ??= resolve(`bench-landing-${date.toISOString().slice(0, 10)}-${options.pair}.json`);
  options.manifest = `${options.out}.manifest.json`;
  return options;
}

const NFORGE = process.env.NFORGE ?? 'nforge';
const childEnv = { ...process.env, FORGE_CHECK_SCOPED: process.env.FORGE_CHECK_SCOPED ?? '1' };
function exec(command, args, { cwd, onStderrLine, allowFail = false, input } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    let stdout = '',
      stderr = '',
      partial = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) onStderrLine?.({ atMs: Date.now(), line });
    });
    child.on('error', fail);
    child.on('close', code => {
      if (partial) onStderrLine?.({ atMs: Date.now(), line: partial });
      if (code !== 0 && !allowFail)
        fail(
          new Error(
            `${command} ${args[0]} ${args[1] ?? ''} exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`,
          ),
        );
      else done({ code, stdout, stderr });
    });
  });
}
const json = text => JSON.parse(text.trim().split('\n').at(-1));
const agent = async (root, action, body, opts) =>
  json((await exec(NFORGE, ['agent', root, action, JSON.stringify(body)], opts)).stdout).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function plan(options, setup) {
  const forge = setup.forge,
    gh = setup.github;
  const steps = [];
  if (forge && forge.root !== options.source)
    steps.push(
      `forge setup: create one parentless Git commit from ${options.source} <main head> exact tree in ${join(options.work, 'seed-git')}`,
      `forge setup: git clone --quiet --no-checkout seed-git seed-checkout`,
      `forge setup: ${NFORGE} import-native-git <seed-checkout> <commit> ${forge.root}`,
      `forge setup: define-check verify = ${process.execPath} scripts/forge-check.mjs; set-policy preset trusted`,
    );
  if (gh)
    steps.push(
      `github setup: git clone seed-git ${gh.clone}; replace .github/workflows with bench-check.yml (scoped forge-check.mjs, ${options.ghRunsOn}, ${options.ghShards} test-shard jobs plus one static job; bench-required aggregate)`,
      `github setup: gh repo create ${gh.repo} --${options.visibility} --source ${gh.clone} --remote github --push`,
    );
  if (forge && options.forgeRunner === 'github-actions')
    steps.push(
      `forge target: gh repo create ${options.forgeCheckRepo} --${options.visibility}`,
      `forge target: register .github/workflows/forge-check.yml on default branch (${options.forgeRunsOn}; ${options.ghShards} test-shard jobs plus one static job)`,
    );
  if (gh && options.ghMergeQueue)
    steps.push(`github setup: PATCH repos/${gh.repo} ${JSON.stringify({ allow_auto_merge: true })}`);
  if (gh)
    steps.push(
      `github ruleset: POST repos/${gh.repo}/rulesets ${JSON.stringify(requiredRuleset(Boolean(options.ghMergeQueue)))}`,
    );
  for (let run = 1; run <= options.runs; run++)
    for (const scenario of options.scenarios) {
      const paths = Object.keys(scenarioEdits(scenario, 'TOKEN')).join(', ');
      if (forge)
        steps.push(
          `forge ${scenario} #${run}: agent start -> edit ${paths} -> finish {accept:true} (FORGE_CHECK_SCOPED=1) until main moves` +
            (forge.hosted ? ' -> exchange push' : '') +
            (forge.mirror ? ` -> github-sync --repo ${forge.mirror} --push until branch moves` : ''),
        );
      if (gh)
        steps.push(
          `github ${scenario} #${run}: branch -> edit ${paths} -> commit -> push -> gh pr create -> poll gh pr checks -> gh pr merge ${gh.mergeQueue ? '--auto' : '--squash --delete-branch'} -> poll main`,
        );
    }
  steps.push(
    `policy: ${JSON.stringify(runnerPolicy(options, options.forgeCheckRepo))}`,
    `workflow:\n${githubWorkflow(options)}`,
  );
  for (const k of options.burst)
    steps.push(
      `BURST ${k}: prepare ${k} disjoint code+test changes per side; release all at one barrier; repeat ${options.runs} times; record per-change and set all-landed time, landings/hour, check count, red-main, retries`,
    );
  steps.push(
    `merge: ${options.ghMergeQueue ? 'use merge queue when configured; otherwise squash after required checks' : 'squash after required checks'}; costs: Actions timing API, Blacksmith job minutes, Modal backend estimate`,
  );
  steps.push(
    options.cleanup
      ? `cleanup: delete only created repositories in ${options.manifest} after writing results`
      : 'no cleanup (pass --cleanup)',
  );
  return steps;
}

async function setupForge(options) {
  if (options.forgeOwner === 'source') {
    const status =
      options.hosted && !options.dryRun
        ? json((await exec(NFORGE, ['host', options.source, '--status'])).stdout)
        : null;
    return {
      mode: 'source owner (real main)',
      root: options.source,
      hosted: Boolean(status?.result?.bound ?? status?.bound),
      mirror: options.githubMirror,
    };
  }
  const root = join(options.work, 'forge-owner');
  let target;
  if (!options.dryRun && options.forgeRunner === 'github-actions') {
    const { githubActionsWorkflow } = await import('../dist/github-actions-workflow.js');
    target = await setupForgeTarget(exec, options, githubActionsWorkflow(options.forgeRunsOn));
  }
  if (!options.dryRun && !existsSync(root)) {
    await seed(options);
    const commit = (
      await exec('git', ['-C', join(options.work, 'seed-git'), 'rev-parse', 'HEAD'])
    ).stdout.trim();
    // The seed is bare; import-native-git reads Git metadata from a worktree.
    const checkout = join(options.work, 'seed-checkout');
    if (!existsSync(checkout))
      await exec('git', ['clone', '--quiet', '--no-checkout', join(options.work, 'seed-git'), checkout]);
    await exec(NFORGE, ['import-native-git', checkout, commit, root]);
    await agent(root, 'define-check', {
      name: 'verify',
      executable: process.execPath,
      args: ['scripts/forge-check.mjs'],
    });
  }
  if (!options.dryRun)
    await agent(root, 'set-policy', {
      operationId: randomUUID(),
      preset: 'trusted',
      ...runnerPolicy(options, options.forgeCheckRepo),
    });
  return {
    mode: 'throwaway native owner',
    root,
    hosted: false,
    mirror: null,
    runner: options.forgeRunner,
    target,
  };
}

async function seed(options) {
  const target = join(options.work, 'seed-git');
  const status = await agent(options.source, 'status', { limit: 50 });
  const main = status.channels.items.find(item => item.name === 'main')?.head;
  if (!main) throw new Error('Source owner main head not found in status');
  await seedNativeGit(options.source, main, target);
  return target;
}

async function setupGithub(options) {
  const repo = options.githubRepo ?? options.plannedRepo,
    clone = join(options.work, 'github-clone');
  if (!options.dryRun && !existsSync(clone)) {
    await prepareGithubClone(exec, await seed(options), clone, githubWorkflow(options));
  }
  if (!options.dryRun)
    await createRepo(exec, options, repo, ['--source', clone, '--remote', 'github', '--push']);
  const merging = options.dryRun
    ? {
        mergeQueue: Boolean(options.ghMergeQueue),
        mergePath: options.ghMergeQueue ? 'merge-queue-if-available' : 'squash-required-checks',
      }
    : await configureGithub(exec, options, repo);
  return { repo, clone, ...merging, visibility: options.visibility, options };
}

function applyEdits(dir, scenario, token, member) {
  for (const [path, edit] of Object.entries(scenarioEdits(scenario, token, member))) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, edit(existsSync(file) ? readFileSync(file, 'utf8') : null));
  }
}

async function forgeSample(forge, scenario, token, member, prepareOnly = false) {
  const t0 = Date.now();
  const lane = await agent(forge.root, 'start', { outcome: `Benchmark ${scenario} ${token}` });
  const tStart = Date.now();
  applyEdits(lane.path, scenario, token, member);
  const land = async () => {
    const events = [],
      tFinish = Date.now();
    // `waiting to land` means still queued, not failed: keep replaying until landed or rejected.
    const { result: finished, replays } = await finishUntilLanded(
      body => agent(forge.root, 'finish', body, { onStderrLine: event => events.push(event) }),
      { laneId: lane.laneId, message: `Benchmark ${scenario} ${token}`, accept: true },
    );
    const tEnd = Date.now();
    if (forge.runner && finished.run?.backend?.actual && finished.run.backend.actual !== forge.runner)
      throw new Error(`Runner changed to ${finished.run.backend.actual}`);
    if (finished.status !== 'accepted') throw new Error(`finish ended ${finished.status}`);
    const phases = {
      doneToMain: tEnd - tFinish,
      start: tStart - t0,
      ...finishPhases(events, tFinish, tEnd),
      ...runRecordTimes(finished.run),
      total: tEnd - t0,
    };
    if (forge.hosted) {
      const t = Date.now();
      await exec(NFORGE, ['exchange', forge.root, 'push']);
      phases.hostedPush = Date.now() - t; // the push receipt returns after hosted publication
    }
    if (forge.mirror) phases.githubMirror = await mirror(forge);
    return {
      phases,
      landedAt: tEnd,
      landReplays: replays,
      checksRun: new Set(events.map(e => parseProgressLine(e.line)?.run).filter(Boolean)).size || 1,
      retries: events.filter(
        (e, i) =>
          parseProgressLine(e.line)?.phase === 'finish retry' &&
          parseProgressLine(events[i - 1]?.line)?.phase !== 'finish retry',
      ).length,
      redMain:
        finished.acceptance?.head === finished.run?.head && finished.run?.status === 'passed' ? 0 : null,
      cost: { modalEstimatedUsd: finished.run?.backend?.estimatedCostUsd ?? null },
      mainHead: finished.acceptance?.head ?? null,
      progressLines: events.length,
    };
  };
  return prepareOnly ? land : land();
}

const branchHead = async repo =>
  (await exec('gh', ['api', `repos/${repo}/branches/main`, '--jq', '.commit.sha'])).stdout.trim();
async function waitForMove(repo, before, limitMs = 10 * 60_000) {
  for (const end = Date.now() + limitMs; Date.now() < end; await sleep(2000))
    if ((await branchHead(repo)) !== before) return;
  throw new Error(`${repo} main did not move within ${limitMs / 1000}s`);
}
async function mirror(forge) {
  const before = await branchHead(forge.mirror),
    t = Date.now();
  await exec(NFORGE, ['github-sync', forge.root, '--repo', forge.mirror, '--push']);
  await waitForMove(forge.mirror, before);
  return Date.now() - t;
}

async function githubSample(gh, scenario, token, member, prepareOnly = false) {
  const git = (...args) => exec('git', ['-C', gh.clone, ...args]);
  const branch = `bench/${scenario}-${token}`;
  await git('fetch', '--quiet', 'github', 'main');
  const t0 = Date.now();
  await git('checkout', '--quiet', '-B', branch, 'github/main');
  applyEdits(gh.clone, scenario, token, member);
  await git('add', '--', ...Object.keys(scenarioEdits(scenario, token, member)));
  await git('commit', '--quiet', '-m', `Benchmark ${scenario} ${token}`);
  const tCommit = Date.now();
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const land = async () => {
    const readyAt = Date.now();
    await git('push', '--quiet', 'github', `${head}:refs/heads/${branch}`);
    const tPush = Date.now();
    const url = (
      await exec('gh', [
        'pr',
        'create',
        '--repo',
        gh.repo,
        '--base',
        'main',
        '--head',
        branch,
        '--title',
        `Benchmark ${scenario} ${token}`,
        '--body',
        'Benchmark',
      ])
    ).stdout
      .trim()
      .split('\n')
      .at(-1);
    const tPr = Date.now();
    let checks;
    for (const end = tPr + 45 * 60_000; ; await sleep(gh.checksPollMs ?? 3000)) {
      const out = await exec('gh', ['pr', 'checks', url, '--json', 'name,state,startedAt,completedAt'], {
        allowFail: true,
      });
      const rows = out.stdout.trim().startsWith('[') ? JSON.parse(out.stdout) : [];
      checks = { ...githubCheckTimes(rows), count: rows.length };
      if (checks.done) break;
      if (Date.now() > end) throw new Error('GitHub checks did not finish within 45 min');
    }
    const tChecks = Date.now();
    if (!checks.passed) throw new Error(`GitHub checks failed: ${url}`);
    const { merged, submittedAt: tMerge, rateLimitedMs } = await mergeGithub(exec, gh, url);
    const tMain = Date.now();
    const checkMs = checks.checkMs ?? tChecks - tPr;
    const diagnostics = rateLimitedMs
      ? [`GitHub API rate limited for ${rateLimitedMs / 1000} s while waiting to merge; timing inflated`]
      : [];
    const observe = async (fn, fallback) => {
      try {
        return await fn();
      } catch (error) {
        diagnostics.push(error.message);
        return fallback;
      }
    };
    const health = await observe(() => mainHealth(gh, merged.mergeCommit.oid), null);
    const cost = await observe(() => githubCosts(gh, head), { runs: [] });
    const mainCost = await observe(() => githubCosts(gh, merged.mergeCommit.oid), { runs: [] });
    return {
      phases: {
        doneToMain: tMain - readyAt,
        branchCommit: tCommit - t0,
        push: tPush - tCommit,
        prCreate: tPr - tPush,
        queueWait: Math.max(0, tChecks - tPr - checkMs),
        check: checkMs,
        merge: tMerge - tChecks,
        mainVisible: tMain - tMerge,
        total: tMain - t0,
      },
      diagnostics,
      mergePath: gh.mergePath,
      pr: url,
      landedAt: tMain,
      checksRun: diagnostics.length ? null : cost.runs.length + mainCost.runs.length,
      checkJobs: checks.count,
      retries: [...cost.runs, ...mainCost.runs].reduce((n, r) => n + (r.attempt ?? 1) - 1, 0),
      redMain: health,
      cost: { runs: [...cost.runs, ...mainCost.runs] },
    };
  };
  return prepareOnly ? land : land();
}
async function mainHealth(gh, head) {
  for (const end = Date.now() + 45 * 60000; ; await sleep(3000)) {
    const runs = JSON.parse(
      (await exec('gh', ['api', `repos/${gh.repo}/actions/runs?head_sha=${head}&event=push&per_page=100`]))
        .stdout,
    ).workflow_runs;
    const check = runs.find(r => r.name === 'Bench check');
    if (check?.status === 'completed') return check.conclusion === 'success' ? 0 : 1;
    if (Date.now() > end) throw new Error('Post-landing main check was not observed');
  }
}
async function githubCosts(gh, head) {
  const runs = JSON.parse(
    (await exec('gh', ['api', `repos/${gh.repo}/actions/runs?head_sha=${head}&per_page=100`])).stdout,
  ).workflow_runs;
  const costs = [];
  for (const run of runs) {
    const timing = await exec('gh', ['api', `repos/${gh.repo}/actions/runs/${run.id}/timing`], {
      allowFail: true,
    });
    const jobs = JSON.parse(
      (await exec('gh', ['api', `repos/${gh.repo}/actions/runs/${run.id}/jobs?per_page=100`])).stdout,
    ).jobs;
    costs.push({
      runId: run.id,
      attempt: run.run_attempt,
      ...actionsCost(timing.code === 0 ? JSON.parse(timing.stdout) : null, jobs, gh.options.ghRunsOn),
    });
  }
  return { runs: costs };
}
async function burstSample(side, setup, k, token) {
  const prepared = [];
  for (let i = 0; i < k; i++)
    prepared.push(
      side === 'forge'
        ? await forgeSample(setup, 'code', `${token}-${i}`, i, true)
        : // k PRs poll at once: scale the GitHub polls with k so the burst stays inside the hourly API
          // budget it shares with Forge's check controllers (adds at most a few seconds per change).
          await githubSample(
            { ...setup, pollMs: 1000 * k, checksPollMs: 1500 * k },
            'code',
            `${token}-${i}`,
            i,
            true,
          ),
    );
  const readyAt = Date.now();
  const changes = await Promise.all(
    prepared.map(async land => {
      try {
        return { ...(await land()), status: 'ok' };
      } catch (error) {
        return { status: 'failed', error: error.message };
      }
    }),
  );
  return {
    changes,
    burst: burstMetrics(changes, readyAt),
    phases: { total: burstMetrics(changes, readyAt).allLandedMs },
    status: changes.every(c => c.status === 'ok') ? 'ok' : 'failed',
  };
}

export async function main(argv, run = exec) {
  const options = parseArgs(argv);
  const resumed =
    !options.dryRun && existsSync(options.out) ? JSON.parse(readFileSync(options.out, 'utf8')) : null;
  const report = resumed ?? {
    startedAt: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    environment: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      node: process.version,
      loadStart: os.loadavg().map(n => n.toFixed(2)),
      pair: options.pair,
      forgeRunner: options.forgeRunner,
      forgeRunsOn: options.forgeRunsOn,
      shards: options.ghShards,
      githubRunner: options.ghRunsOn,
      githubVisibility: options.visibility,
    },
    setup: {},
    samples: [],
  };
  const save = () => {
    writeFileSync(options.out, JSON.stringify(report, null, 2));
    writeFileSync(options.out.replace(/\.json$/, '') + '.md', renderMarkdown(report));
  };
  if (options.cleanup && !options.dryRun) {
    const manifest = loadManifest(options.manifest);
    if (resumed?.manifest?.runId !== undefined && resumed.manifest.runId !== manifest.runId)
      throw new Error('Run manifest does not belong to these results');
    report.manifest = { path: options.manifest, runId: manifest.runId };
    save();
    await cleanupRepos(run, options.manifest);
    report.cleanedUp = new Date().toISOString();
    save();
    console.log(renderMarkdown(report));
    return;
  }
  const owner =
    options.githubOwner ??
    (options.dryRun ? '<login>' : (await exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim());
  options.plannedRepo = options.githubRepo ?? `${owner}/${repoName(new Date(), options.pair)}`;
  options.forgeCheckRepo = `${owner}/${repoName(new Date(), options.pair)}-forgecheck`;
  if (!options.dryRun) {
    mkdirSync(options.work, { recursive: true });
    // A resumed result must retain its original manifest; never recreate ownership evidence.
    const manifest = loadManifest(options.manifest, !resumed);
    if (resumed?.manifest?.runId !== undefined && resumed.manifest.runId !== manifest.runId)
      throw new Error('Run manifest does not belong to these results');
    report.manifest = { path: options.manifest, runId: manifest.runId };
  }
  if (options.sides.includes('forge')) report.setup.forge ??= await setupForge(options);
  if (options.sides.includes('github')) report.setup.github ??= await setupGithub(options);
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          options,
          setup: report.setup,
          plan: plan(options, report.setup),
          workflow: githubWorkflow(options),
          policy: runnerPolicy(options, options.forgeCheckRepo),
          ruleset: requiredRuleset(Boolean(options.ghMergeQueue)),
          forgeWorkflow:
            options.forgeRunner === 'github-actions'
              ? (await import('../dist/github-actions-workflow.js')).githubActionsWorkflow(
                  options.forgeRunsOn,
                )
              : null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const deadline = options.maxMinutes ? Date.now() + options.maxMinutes * 60_000 : Infinity;
  for (let run = 1; run <= options.runs; run++)
    for (const scenario of [...options.scenarios, ...options.burst.map(k => `burst-${k}`)])
      for (const side of options.sides) {
        if (
          report.samples.some(
            s => s.side === side && s.scenario === scenario && s.run === run && s.status === 'ok',
          )
        )
          continue;
        if (Date.now() > deadline)
          return (
            save(),
            console.error(`Stopped at --max-minutes; rerun with --out ${options.out} to resume.`)
          );
        const token = randomUUID().slice(0, 8),
          load = os.loadavg()[0];
        process.stderr.write(`bench ${side} ${scenario} #${run} (${token}) load=${load.toFixed(2)}\n`);
        const sample = {
          pair: options.pair,
          side,
          scenario,
          run,
          token,
          load1: load,
          at: new Date().toISOString(),
        };
        try {
          Object.assign(
            sample,
            scenario.startsWith('burst-')
              ? await burstSample(side, report.setup[side], Number(scenario.slice(6)), token)
              : side === 'forge'
                ? await forgeSample(report.setup.forge, scenario, token)
                : await githubSample(report.setup.github, scenario, token),
            { status: 'ok' },
          );
        } catch (error) {
          Object.assign(sample, { status: 'failed', error: error.message });
        }
        if (sample.changes?.some(c => c.status !== 'ok')) sample.status = 'failed';
        report.samples = report.samples.filter(
          s => !(s.side === side && s.scenario === scenario && s.run === run),
        );
        report.samples.push(sample);
        save();
      }
  console.log(renderMarkdown(report));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
