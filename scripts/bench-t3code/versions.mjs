// B1.5d version record (B2/B3/S6): everything that defines the system under test, read at
// cell start and end. Any difference voids the cell; the driver also holds every cell of a
// run to the first cell's record (the run pin), so cells compare like with like.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { agentOf, CLAUDE, CODEX } from './agent.mjs';

const run = promisify(execFile);
const FORGE = 'NanthAI/nanthai-forge';
export const HARNESS_DIR = import.meta.dirname;
// The lead's CLI updater skips swapping forge-cli/current while this file exists.
export const FREEZE = join(homedir(), 'NanthAI/forge-cli/.freeze');
const out = async (cmd, args, opts = {}) =>
  (await run(cmd, args, { maxBuffer: 64 << 20, ...opts })).stdout.trim();
const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/** The harness code itself: its commit, whether the checkout is clean, and a content hash. */
export async function harness(dir = HARNESS_DIR) {
  const repo = dirname(dirname(dir));
  const files = [
    ...readdirSync(dir)
      .filter(f => /\.(mjs|sh|md)$/.test(f))
      .map(f => join(dir, f)),
    join(repo, 'scripts/benchmark-import-monitor.mjs'),
    join(repo, 'scripts/filesystem-event-health.mjs'),
    join(repo, 'scripts/filesystem-event-health-worker.mjs'),
    join(repo, 'scripts/child-env.mjs'),
  ].sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.slice(repo.length)).update(readFileSync(f));
  const commit = await safe(() => out('git', ['-C', repo, 'rev-parse', 'HEAD']));
  const dirty = commit
    ? await safe(() => out('git', ['-C', repo, 'status', '--porcelain', '--', 'scripts']), 'unknown')
    : 'not a git checkout';
  return {
    dir: repo,
    commit,
    clean: dirty === '',
    dirty: dirty || null,
    filesSha256: hash.digest('hex'),
    laneRoot: repo.includes('/forge-hosted/'),
  };
}

/** A pinned harness: a clean git checkout (never a Lane root) of a commit on GitHub main. */
export async function pinProblems(h) {
  const problems = [];
  if (!h.commit) problems.push('harness is not a git checkout');
  if (h.laneRoot) problems.push('harness runs from a Lane root');
  if (h.commit && !h.clean) problems.push(`harness checkout is dirty: ${String(h.dirty).slice(0, 200)}`);
  if (h.commit) {
    const status = await safe(() =>
      out('gh', ['api', `repos/${FORGE}/compare/${h.commit}...main`, '--jq', '.status']),
    );
    if (!['identical', 'ahead'].includes(status))
      problems.push(`harness commit ${h.commit.slice(0, 12)} is not on GitHub main (${status})`);
  }
  return problems;
}

async function treeEntry(repo, sha, path) {
  if (!sha) return null;
  return safe(async () => {
    const tree = await out('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.tree.sha']);
    return out('gh', [
      'api',
      `repos/${repo}/git/trees/${tree}`,
      '--jq',
      `.tree[] | select(.path == "${path}") | .sha`,
    ]);
  });
}
const blobAt = (repo, sha, path) =>
  safe(() => out('gh', ['api', `repos/${repo}/contents/${path}?ref=${sha}`, '--jq', '.sha']));

/** One record of every version that matters; arm-independent so both arms record the same. */
export async function snapshot(config) {
  const cliPkg = dirname(dirname(config.forge.cli));
  const cliCommit = await safe(() => readFileSync(join(cliPkg, '.commit'), 'utf8').trim());
  const githubMain = await safe(
    async () =>
      (await out('git', ['ls-remote', `https://github.com/${FORGE}`, 'refs/heads/main'])).split(/\s/)[0],
  );
  const deploy = await safe(
    async () =>
      JSON.parse(
        await out('gh', [
          'run',
          'list',
          '-R',
          FORGE,
          '--workflow',
          config.forge.deployWorkflow,
          '--status',
          'success',
          '-L',
          '1',
          '--json',
          'headSha,updatedAt,databaseId',
        ]),
      )[0],
  );
  return {
    at: new Date().toISOString(),
    cli: { build: await safe(() => realpathSync(cliPkg)), commit: cliCommit },
    githubMain,
    deploy: deploy ?? null,
    convexTree: {
      cli: await treeEntry(FORGE, cliCommit, 'convex'),
      deploy: await treeEntry(FORGE, deploy?.headSha, 'convex'),
    },
    checkWorkflow: {
      forge: await blobAt(FORGE, githubMain, '.github/workflows/forge-check.yml'),
      github: await blobAt(
        config.github.repository,
        config.github.mainBase,
        '.github/workflows/bench-ci.yml',
      ),
    },
    harness: await harness(),
    // Provider, model, effort and CLI version of the agent both arms run (config.agent).
    agent: await safe(async () => {
      const a = agentOf(config);
      const version = await out(a.provider === 'codex' ? CODEX : CLAUDE, ['--version'], {
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      });
      return version ? `${a.provider} ${a.model} ${a.effort} ${version}` : null;
    }),
    freeze: existsSync(FREEZE),
  };
}

const KEYS = [
  ['cli.build', s => s.cli?.build],
  ['cli.commit', s => s.cli?.commit],
  ['githubMain', s => s.githubMain],
  ['deploy.headSha', s => s.deploy?.headSha],
  ['convexTree.deploy', s => s.convexTree?.deploy],
  ['checkWorkflow.forge', s => s.checkWorkflow?.forge],
  ['checkWorkflow.github', s => s.checkWorkflow?.github],
  ['harness.commit', s => s.harness?.commit],
  ['harness.filesSha256', s => s.harness?.filesSha256],
  ['agent', s => s.agent],
];
// Readings that follow nanthai-forge main. Scored cells run with landings frozen, so any
// change voids. Dry runs happen while builders still land: these are recorded as waived.
export const LIVE_MAIN_KEYS = ['githubMain', 'deploy.headSha', 'convexTree.deploy', 'checkWorkflow.forge'];
/** Keys whose values differ (an unreadable value on either side counts as a difference).
 * `unpinned` (dry runs from a Lane root only): a harness with no git commit on both sides
 * is the expected reading, not a difference; its file hash still has to match. */
export function differences(a, b, { liveMain = false, unpinned = false } = {}) {
  return KEYS.filter(([k]) => !(liveMain && LIVE_MAIN_KEYS.includes(k)))
    .filter(([k, get]) => !(unpinned && k === 'harness.commit' && get(a) == null && get(b) == null))
    .filter(([, get]) => get(a) == null || get(b) == null || get(a) !== get(b))
    .map(([k, get]) => `${k}: ${get(a)} -> ${get(b)}`);
}

/** Problems with one snapshot by itself (the GO rules that need no second reading). */
export function snapshotProblems(s, { requireFreeze, liveMain = false }) {
  const p = [];
  if (!s.cli.commit) p.push('CLI commit unreadable');
  else if (!liveMain && s.cli.commit !== s.githubMain)
    p.push(`CLI ${s.cli.commit} is not GitHub main ${s.githubMain}`);
  if (!liveMain && (!s.convexTree.cli || s.convexTree.cli !== s.convexTree.deploy))
    p.push(`deployed convex/ (${s.deploy?.headSha?.slice(0, 12)}) differs from the CLI commit's convex/`);
  if (!s.checkWorkflow.forge || !s.checkWorkflow.github) p.push('check workflow version unreadable');
  if (!s.agent) p.push('agent CLI --version unreadable');
  if (requireFreeze && !s.freeze) p.push(`freeze file ${FREEZE} missing`);
  return p;
}

/** Runs queued or in progress on nanthai-forge (a dogfood landing, deploy or check). */
export async function forgeInFlight() {
  const runs = [];
  for (const status of ['queued', 'in_progress'])
    runs.push(
      ...JSON.parse(
        await out('gh', [
          'run',
          'list',
          '-R',
          FORGE,
          '--status',
          status,
          '-L',
          '50',
          '--json',
          'databaseId,name,workflowName,createdAt',
        ]),
      ),
    );
  return runs;
}
