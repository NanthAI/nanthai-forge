// SPDX-License-Identifier: Apache-2.0
// B1.5d version record (B2/B3/S6): everything that defines the system under test, read at
// cell start and end. Any difference voids the cell, except the readings that only follow
// nanthai-forge main (RECORDED_KEYS: builders keep landing during scored batches, exit plan
// "Quiet rule and deploys"); the driver also holds every cell of a run to the first cell's
// record (the run pin), so cells compare like with like.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentOf, CLAUDE, CODEX } from './agent.mjs';
import { parseMirror } from './pin.mjs';
import { benchCli, freezePath } from './cli-install.mjs';

const run = promisify(execFile);
const FORGE = 'NanthAI/nanthai-forge';
export const HARNESS_DIR = import.meta.dirname;
/** The measurement hold of the bench's own CLI installation (config.forge.cli; cli-install.mjs
 * benchCli refuses the builders' one): while it exists that CLI holds land/finish and does not
 * update itself. */
export const benchFreeze = config => freezePath(benchCli({ config }));
/** Hold text: the owner line (stale detection reads its pid), then the measured bench project, so
 * the bench's own landings run on the held build while every other project's landings wait
 * (src/cli-measurement-hold.ts). */
export function benchHoldText(config, owner) {
  const projectId = config.forge?.projectId;
  if (typeof projectId !== 'string' || !/^\S+$/.test(projectId))
    throw Error('BENCH_HOLD_PROJECT config.forge.projectId is required for the measurement hold');
  return `${owner}\nproject ${projectId}\n`;
}
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
/** The Git commit of a CLI commit. Forge main is the authority and its State heads are 64 hex
 * (the CLI's `.commit` is one); GitHub main is a Git commit. The project's own mirror record
 * maps one to the other; a 40-hex CLI commit is already Git. null = not mapped (yet). */
export function cliGitCommit(cliCommit, mirror) {
  if (/^[0-9a-f]{40}$/.test(cliCommit ?? '')) return cliCommit;
  return mirror && mirror.mirroredHead === cliCommit && /^[0-9a-f]{40}$/.test(mirror.gitHead ?? '')
    ? mirror.gitHead
    : null;
}

export async function snapshot(config) {
  const cliPkg = dirname(dirname(config.forge.cli));
  const cliCommit = await safe(() => readFileSync(join(cliPkg, '.commit'), 'utf8').trim());
  // One read of the dogfood project's mirror record (not the bench project): needed only when
  // the CLI commit is a State head.
  const mirror = await safe(() => {
    if (!config.dogfood?.projectId || /^[0-9a-f]{40}$/.test(cliCommit ?? '')) return null;
    const root = join(tmpdir(), 'forge-bench-mirror-probe');
    mkdirSync(root, { recursive: true });
    const line = execFileSync(
      '/usr/local/bin/node',
      [
        config.forge.cli,
        'agent',
        root,
        'capabilities',
        JSON.stringify({ url: config.dogfood.url ?? config.forge.url, projectId: config.dogfood.projectId }),
        '--detail', // the slim receipt drops a synced mirror's mirroredHead/gitHead
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    return parseMirror(JSON.parse(line));
  });
  const cliGit = cliGitCommit(cliCommit, mirror);
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
    cli: { build: await safe(() => realpathSync(cliPkg)), commit: cliCommit, git: cliGit },
    githubMain,
    deploy: deploy ?? null,
    convexTree: {
      cli: await treeEntry(FORGE, cliGit, 'convex'),
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
    freeze: await safe(() => existsSync(benchFreeze(config)), false),
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
// Readings that follow nanthai-forge main. Builders keep landing while a scored batch runs
// (lead 2026-11-09, exit plan "Quiet rule and deploys"): main, the deploy head and the
// deployed convex/ tree moving are recorded (`moved`), never voids by themselves. A deployed
// convex/ change voids only when it touches the landing path (`landingPathChanges`), and
// forge-check.yml (the Forge arm's check) still voids when it changes. Dry runs waive all four.
export const RECORDED_KEYS = ['githubMain', 'deploy.headSha', 'convexTree.deploy'];
export const LIVE_MAIN_KEYS = [...RECORDED_KEYS, 'checkWorkflow.forge'];

// convex/ files off the landing path (land, queue, check, acceptance): a deploy that changes
// only these is recorded, not a void (exit plan "Quiet rule and deploys"). Any other changed
// convex/ file voids, and so does a change list that cannot be read (void when unsure). Board
// and briefing code is on the path: Forge-arm agents read notices, claims and the briefing
// during a cell (lead c75ed83f).
export const OFF_LANDING_PATH = Object.freeze([
  'convex/gitServe',
  'convex/projectGithubImport',
  'convex/projectGithubInbound',
  'convex/projectPeople',
  'convex/projectPurge',
  'convex/projectR2Purge',
  'convex/projectR2Sweep',
  'convex/projectArchive',
  'convex/projectBackup',
  'convex/projectLegacy',
  'convex/legacy',
  'convex/archive',
  'convex/backup',
  'convex/account',
  'convex/abuse',
  'convex/sharing',
  'convex/team',
]);
export const offLandingPath = file => OFF_LANDING_PATH.some(prefix => file.startsWith(prefix));

/** The deployed convex/ change between two snapshots, classified: `voids` (empty when the tree
 * did not change or only off-path files changed) and the changed convex/ `files`. One GitHub
 * compare call between the two deploy heads, only when the tree changed. */
export async function landingPathChanges(a, b, exec = out) {
  const from = a.convexTree?.deploy ?? null,
    to = b.convexTree?.deploy ?? null;
  if (from && to && from === to) return { voids: [], files: [] };
  const x = a.deploy?.headSha,
    y = b.deploy?.headSha;
  const unsure = why => ({
    voids: [`convexTree.deploy: ${from} -> ${to} (${why}; void when unsure)`],
    files: null,
  });
  if (!from || !to || !x || !y) return unsure('unreadable');
  let view;
  try {
    view = JSON.parse(
      await exec('gh', [
        'api',
        `repos/${FORGE}/compare/${x}...${y}`,
        '--jq',
        '{status: .status, n: (.files | length), files: [.files[].filename]}',
      ]),
    );
  } catch (error) {
    return unsure(`changed files unreadable: ${String(error.message ?? error).slice(0, 120)}`);
  }
  // GitHub lists at most 300 files per compare; a longer list cannot be classified.
  if (view.status !== 'ahead' || view.n >= 300) return unsure(`compare ${view.status}, ${view.n} files`);
  const files = view.files.filter(f => f.startsWith('convex/'));
  if (!files.length) return unsure('the tree changed but no convex/ file is listed');
  const on = files.filter(f => !offLandingPath(f));
  return {
    voids: on.length
      ? [
          `convex/ landing path changed by deploy ${x.slice(0, 12)} -> ${y.slice(0, 12)}: ${on.slice(0, 8).join(', ')}${on.length > 8 ? ` (+${on.length - 8})` : ''}`,
        ]
      : [],
    files,
  };
}
const diff = (a, b, keys, unpinned) =>
  keys
    .filter(([k, get]) => !(unpinned && k === 'harness.commit' && get(a) == null && get(b) == null))
    .filter(([, get]) => get(a) == null || get(b) == null || get(a) !== get(b))
    .map(([k, get]) => `${k}: ${get(a)} -> ${get(b)}`);
/** Keys whose values differ (an unreadable value on either side counts as a difference),
 * without the recorded main readings. `unpinned` (dry runs from a Lane root only): a harness
 * with no git commit on both sides is the expected reading, not a difference; its file hash
 * still has to match. */
export function differences(a, b, { liveMain = false, unpinned = false } = {}) {
  const skip = liveMain ? LIVE_MAIN_KEYS : RECORDED_KEYS;
  return diff(
    a,
    b,
    KEYS.filter(([k]) => !skip.includes(k)),
    unpinned,
  );
}
/** Everything that voids between two snapshots: `differences`, plus a deployed convex/ change
 * on the landing path (`landingPathChanges`; waived with the other main readings when
 * `liveMain`). `convexFiles`: the changed convex/ files (null when unreadable), recorded. */
export async function voidingChanges(a, b, { liveMain = false, unpinned = false, exec = out } = {}) {
  const changes = differences(a, b, { liveMain, unpinned });
  const convex = await landingPathChanges(a, b, exec);
  return {
    changes: liveMain ? changes : [...changes, ...convex.voids],
    convexFiles: convex.files,
    waived: liveMain ? convex.voids : [],
  };
}

/** The recorded main readings that moved between two snapshots (reported, not voids). */
export const moved = (a, b) =>
  diff(
    a,
    b,
    KEYS.filter(([k]) => RECORDED_KEYS.includes(k)),
    false,
  );

/** Problems with one snapshot by itself (the GO rules that need no second reading). */
/** `inBatch`: a cell inside a batch whose start already brought the held CLI to main and
 * matched the deployed convex/; main and the deploy may have moved since (recorded; the gate
 * classifies a convex/ change against the batch pin with `landingPathChanges`). */
export function snapshotProblems(s, { requireFreeze, liveMain = false, inBatch = false }) {
  const p = [];
  if (!s.cli.commit) p.push('CLI commit unreadable');
  else if (!liveMain && !inBatch && s.cli.commit !== s.githubMain && (s.cli.git ?? null) !== s.githubMain)
    p.push(
      `CLI ${s.cli.commit} is not GitHub main ${s.githubMain}` +
        (s.cli.git ? ` (mirror maps it to Git ${s.cli.git})` : ' (no mirror mapping for this State head)'),
    );
  if (!liveMain && !inBatch && (!s.convexTree.cli || s.convexTree.cli !== s.convexTree.deploy))
    p.push(`deployed convex/ (${s.deploy?.headSha?.slice(0, 12)}) differs from the CLI commit's convex/`);
  if (!s.checkWorkflow.forge || !s.checkWorkflow.github) p.push('check workflow version unreadable');
  if (!s.agent) p.push('agent CLI --version unreadable');
  if (requireFreeze && !s.freeze) p.push(`freeze file (.freeze of the CLI installation) missing`);
  return p;
}

/** Runs queued or in progress on nanthai-forge; `workflow` (a workflow file, such as
 * config.forge.deployWorkflow) limits it to that workflow. 2 `gh` calls. */
export async function forgeInFlight({ workflow = null } = {}, exec = out) {
  const runs = [];
  for (const status of ['queued', 'in_progress'])
    runs.push(
      ...JSON.parse(
        await exec('gh', [
          'run',
          'list',
          '-R',
          FORGE,
          ...(workflow ? ['--workflow', workflow] : []),
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

/** The batch quiet rule (exit plan "Quiet rule and deploys"): only a Convex deploy in flight
 * holds a batch start; dogfood landings, Verify Forge and forge-check runs do not. */
export const deployInFlight = (config, exec) =>
  forgeInFlight({ workflow: config.forge.deployWorkflow }, exec);

/** Deploy runs (config.forge.deployWorkflow) that overlap [from, to] (ISO times): id, head,
 * created/updated times, status and conclusion. One `gh` call of the last 30 runs; a run still
 * going at `to` counts. Unreadable: { error }. */
export async function deploysDuring(config, from, to, exec = out) {
  try {
    const list = JSON.parse(
      await exec('gh', [
        'run',
        'list',
        '-R',
        FORGE,
        '--workflow',
        config.forge.deployWorkflow,
        '-L',
        '30',
        '--json',
        'databaseId,headSha,createdAt,updatedAt,status,conclusion',
      ]),
    );
    return overlapping(list, from, to);
  } catch (error) {
    return { error: String(error.message ?? error).slice(0, 200) };
  }
}

/** Runs whose [createdAt, updatedAt] (updatedAt open while not completed) overlaps [from, to]. */
export function overlapping(runs, from, to) {
  const a = Date.parse(from),
    b = Date.parse(to);
  return runs
    .filter(r => {
      const s = Date.parse(r.createdAt),
        e = r.status === 'completed' ? Date.parse(r.updatedAt) : Infinity;
      return s <= b && e >= a;
    })
    .map(r => ({
      id: r.databaseId,
      headSha: r.headSha,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      status: r.status,
      conclusion: r.conclusion ?? null,
    }))
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
}
