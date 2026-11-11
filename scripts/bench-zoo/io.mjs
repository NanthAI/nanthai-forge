// SPDX-License-Identifier: Apache-2.0
// Side effects of the zoo run (Issue 85d26a8b): the Forge CLI, git, GitHub reads, the import
// actions and the Convex meter. run.mjs takes these as one injectable object.
import { appendFileSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { exec } from './exec.mjs';
import { controlCodeSource, thrownRefusal } from './lib.mjs';

// Share this checkout's import client; runtime auth and network adapters come from the approved CLI.
const fromCheckout = (checkout, path) => import(pathToFileURL(join(checkout, path)).href);
const githubArm = () => import('../bench-t3code/github-arm.mjs');
const meter = () => import('../bench-t3code/meter.mjs');

const IMPORT_POLL_MS = 5_000;
const GITHUB_RUN_DEADLINE_MS = 40 * 60_000;
const GITHUB_POLL_MS = 20_000;

export function makeIo({
  cfg,
  root,
  runDir,
  state,
  statePath,
  load = fromCheckout,
  importClock = Date.now,
  importSleep = wait,
}) {
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
    saveState: () => {
      writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 1) + '\n');
      renameSync(statePath + '.tmp', statePath);
    },

    /** GitHub import into a NEW project (projectGithubImport start + status), timed end to end. */
    async importProject(repo, journalPath, { onJournal } = {}) {
      const prior = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
      const co = cfg.forgeCheckout;
      const [{ importProject }, { resolveAuthToken }, { deadlineConvexClient }, { makeFunctionReference }] =
        await Promise.all([
          import('../bench-t3code/forge-import.mjs'),
          load(co, 'dist/auth-store.js'),
          load(co, 'dist/network-convex-client.js'),
          load(co, 'node_modules/convex/dist/esm/server/index.js'),
        ]);
      const token = resolveAuthToken(cfg.deployment);
      if (!token) return { phase: null, error: { code: 'AUTH_REQUIRED' } };
      const client = deadlineConvexClient(cfg.deployment, {});
      client.setAuth(token);
      let calls = 0;
      const tracked = {
        action: (...args) => {
          calls++;
          return client.action(...args);
        },
      };
      const spec = {
        url: `https://github.com/${repo.fork}`,
        ref: repo.ref,
        name: `bench-zoo-${repo.id}`,
        deployment: cfg.deployment,
      };
      const res = await importAfterReset({
        now: importClock,
        sleep: importSleep,
        observe: entry =>
          appendFileSync(
            join(runDir, `${repo.id}.receipts.jsonl`),
            JSON.stringify({ verb: 'import-setup-void', at: new Date().toISOString(), ...entry }) + '\n',
          ),
        attempt: async ({ resume }) => {
          const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {};
          // A failed stored job resumes through start with its original operation and exact spec.
          // A refusal before job creation is retried by the existing import client itself.
          if (resume && journal.jobId)
            await tracked.action(makeFunctionReference('projectGithubImport:start'), {
              operationId: journal.operationId,
              url: spec.url,
              ref: spec.ref,
              name: spec.name,
            });
          return importProject({
            client: tracked,
            ref: makeFunctionReference,
            journalPath,
            spec,
            now: importClock,
            onJournal,
            sleep: () => wait(IMPORT_POLL_MS),
          });
        },
      });
      return {
        ...res,
        calls,
        ...(prior?.startedAt
          ? {
              wallSeconds: Math.max(res.wallSeconds, (importClock() - Date.parse(prior.startedAt)) / 1000),
              resumedImport: { operationId: prior.operationId, startedAt: prior.startedAt },
            }
          : {}),
      };
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
      if (cfg.reimport || !projectId || !cfg.meterCwd)
        return {
          ...(await fn()),
          meter: { valid: false, problems: ['not metered: import must be prepared and meterCwd configured'] },
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

/** A provider reset is a setup void, retained separately from the successful import timing.
 * Waiting is local; the callback resumes the same journal/operation, never a different source. */
export async function importAfterReset({ attempt, sleep, now = Date.now, observe = () => {} }) {
  const wallStart = now(),
    setupVoids = [];
  for (;;) {
    const started = now();
    let result;
    try {
      result = await attempt({ resume: setupVoids.length > 0 });
    } catch (error) {
      const refusal = thrownRefusal(error);
      if (!refusal) throw error;
      result = { phase: 'refused', error: refusal };
    }
    const seconds = (now() - started) / 1000;
    const error = result.error;
    if (error?.code !== 'GITHUB_RATE_LIMIT' || !Number.isFinite(error.retryAt) || error.retryAt <= now())
      return { ...result, seconds, wallSeconds: (now() - wallStart) / 1000, setupVoids };
    const entry = { code: error.code, retryAt: error.retryAt, seconds, waitSeconds: 0 };
    setupVoids.push(entry);
    observe(entry);
    const waitStart = now();
    while (now() < error.retryAt) await sleep(Math.min(60_000, error.retryAt - now()));
    entry.waitSeconds = (now() - waitStart) / 1000;
  }
}
