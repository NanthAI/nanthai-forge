// SPDX-License-Identifier: Apache-2.0
// Side effects of the zoo run (Issue 85d26a8b): the Forge CLI, git, GitHub reads, the import
// actions and the Convex meter. run.mjs takes these as one injectable object.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { exec } from './exec.mjs';
import { controlCodeSource } from './lib.mjs';

// The import client needs a built Forge checkout (cfg.forgeCheckout: dist/ and node_modules/),
// so it is loaded from there; the GitHub and meter helpers use Node built-ins only.
const fromCheckout = (checkout, path) => import(pathToFileURL(join(checkout, path)).href);
const githubArm = () => import('../bench-t3code/github-arm.mjs');
const meter = () => import('../bench-t3code/meter.mjs');

const IMPORT_POLL_MS = 5_000;
const GITHUB_RUN_DEADLINE_MS = 40 * 60_000;
const GITHUB_POLL_MS = 20_000;

export function makeIo({ cfg, root, runDir, state, statePath }) {
  const nforge = cfg.cli ?? 'nforge';
  const gh = async args => {
    const r = await exec('gh', args);
    if (r.code) throw Error(`gh ${args.slice(0, 3).join(' ')}: ${r.stderr.slice(-300)}`);
    return r.stdout;
  };
  return {
    cli: args => exec(nforge, args),
    git: args => exec('git', args),
    receipt: (id, entry) =>
      appendFileSync(
        join(runDir, `${id}.receipts.jsonl`),
        JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      ),
    /** Where the runner workflow gets Forge's control code: the runner repository's own checkout at
     * its workflow sha, or a pinned digest (Issue 77fa4412). Reads the workflow text on GitHub. */
    async controlCode(runnerRepo) {
      const text = await gh([
        'api',
        `repos/${runnerRepo}/contents/.github/workflows/forge-check.yml`,
        '-H',
        'Accept: application/vnd.github.raw',
      ]);
      return controlCodeSource(text);
    },
    saveState: () => writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n'),

    /** GitHub import into a NEW project (projectGithubImport start + status), timed end to end. */
    async importProject(repo, journalPath) {
      const co = cfg.forgeCheckout;
      const [{ importProject }, { resolveAuthToken }, { deadlineConvexClient }, { makeFunctionReference }] =
        await Promise.all([
          fromCheckout(co, 'scripts/bench-t3code/forge-import.mjs'),
          fromCheckout(co, 'dist/auth-store.js'),
          fromCheckout(co, 'dist/network-convex-client.js'),
          fromCheckout(co, 'node_modules/convex/dist/esm/server/index.js'),
        ]);
      const token = resolveAuthToken(cfg.deployment);
      if (!token) return { phase: null, error: { code: 'AUTH_REQUIRED' } };
      const client = deadlineConvexClient(cfg.deployment, {});
      client.setAuth(token);
      const started = performance.now();
      const res = await importProject({
        client,
        ref: makeFunctionReference,
        journalPath,
        spec: { url: `https://github.com/${repo.fork}`, ref: repo.ref, name: `bench-zoo-${repo.id}` },
        sleep: () => wait(IMPORT_POLL_MS),
      });
      return { ...res, seconds: (performance.now() - started) / 1000 };
    },

    /** This project's forge-check runs on the runner repository in the window, as job minutes. */
    async forgeChecks(runnerRepo, projectId, since, until) {
      const github = await githubArm();
      const { runs, otherProjectRuns } = await github.projectCheckRuns(runnerRepo, projectId, since, until);
      const m = await github.jobMetrics(runnerRepo, runs);
      return {
        runs: m.runs,
        jobs: m.jobs,
        jobSeconds: m.jobSeconds,
        queueSeconds: m.queueSeconds,
        // GitHub-side timing per run, to compare with Forge's own run start and end.
        runTimes: runs.map(x => ({
          title: x.name ?? x.display_title ?? null,
          created: x.created_at ?? null,
          updated: x.updated_at ?? null,
          conclusion: x.conclusion ?? null,
        })),
        otherProjectRuns,
      };
    },

    /** One GitHub-equivalent full run: dispatch the fork's workflow on its default branch and
     * wait (bounded, GitHub reads only) for it to finish. */
    async githubFullRun(repo) {
      const github = await githubArm();
      const since = new Date(Date.now() - 5_000).toISOString();
      await gh(['workflow', 'run', cfg.githubWorkflow, '-R', repo.fork, '--ref', repo.ref]);
      const deadline = Date.now() + GITHUB_RUN_DEADLINE_MS;
      for (;;) {
        const list = JSON.parse(
          await gh([
            'run',
            'list',
            '-R',
            repo.fork,
            '-w',
            cfg.githubWorkflow,
            '-L',
            '5',
            '--json',
            'databaseId,status,conclusion,createdAt,event',
          ]),
        );
        const run = list.find(r => r.createdAt >= since.slice(0, 19) && r.event === 'workflow_dispatch');
        if (run?.status === 'completed') {
          const m = await github.jobMetrics(repo.fork, [
            { id: run.databaseId, event: run.event, status: run.status },
          ]);
          return {
            runId: run.databaseId,
            conclusion: run.conclusion,
            jobs: m.jobs,
            jobSeconds: m.jobSeconds,
            queueSeconds: m.queueSeconds,
          };
        }
        if (Date.now() > deadline) return { runId: run?.databaseId ?? null, conclusion: 'timeout' };
        await wait(GITHUB_POLL_MS);
      }
    },

    /** Convex usage attributed to this repository's project while `fn` runs. */
    async metered(repo, fn) {
      const projectId = state.repos[repo.id]?.projectId;
      if (!projectId || !cfg.meterCwd)
        return {
          ...(await fn()),
          meter: { valid: false, problems: ['not metered: no project yet or no meterCwd'] },
        };
      const { convexMeter } = await meter();
      const m = convexMeter({
        deployment: cfg.deploymentName,
        projectId,
        name: `bench-zoo-${repo.id}`,
        cwd: cfg.meterCwd,
      });
      try {
        // One cheap project read (address by url + projectId) proves the stream sees this project.
        await m.ready(() =>
          exec(nforge, ['agent', '.', 'check-settings', JSON.stringify({ url: cfg.deployment, projectId })], {
            cwd: runDir,
          }),
        );
      } catch (error) {
        m.stop();
        return { ...(await fn()), meter: { valid: false, problems: [error.message] } };
      }
      const result = await fn();
      return { ...result, meter: m.stop() };
    },
  };
}
