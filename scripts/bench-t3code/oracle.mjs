// B1.5d oracle: each task's own PR tests (original versions) plus the existing suites of
// the check's scope (oracle.sh SUITES: five packages and apps/server/src/preview), run on the
// exact final main of a cell, on GitHub Actions in the fork
// (public, free minutes). Works from a fork commit (GitHub arm) or from a directory holding
// Forge's final main (Forge arm), so both arms use one grader.
// Leak rule (B1): the grading branch and run exist only while no agent runs (after every
// landing settled); both are deleted right after the log is read, and the log is kept here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { repository, fromGithub } from './github-arm.mjs';
import { attribute, gitShow, titleMatches } from './attribution.mjs';
import { gitlinks } from './forge-arm.mjs';

const run = promisify(execFile);
const ORACLE_SH = join(import.meta.dirname, 'oracle.sh');
/** The suites oracle.sh runs (its `suites=` line); every one must report for a green cell. */
export const SUITES = readFileSync(ORACLE_SH, 'utf8')
  .match(/^suites="([^"]+)"/m)[1]
  .split(' ');
const METADATA = [':!.forge', ':!.nforge', ':!node_modules', ':!**/node_modules'];

export async function oracleCommit({ meta, tasks, label, fromCommit, fromDirectory, baseCommit }) {
  const index = `${meta}/.git/oracle-${label}.index`;
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'NanthAI bench',
    GIT_AUTHOR_EMAIL: 'bench@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'NanthAI bench',
    GIT_COMMITTER_EMAIL: 'bench@users.noreply.github.com',
  };
  const git = async args =>
    (await run('git', ['-C', meta, ...args], { env, maxBuffer: 256 << 20 })).stdout.trim();
  try {
    let parent;
    if (fromCommit) {
      await git(['fetch', '-q', '--filter=blob:none', 'fork', fromCommit]);
      await git(['read-tree', fromCommit]);
      parent = fromCommit;
    } else {
      // Forge final main: the whole materialized tree over the base index (-f: .gitignore
      // never hides a landed file; Forge metadata and gitlinks excluded).
      await git(['read-tree', baseCommit]);
      const links = (await gitlinks(meta, baseCommit)).map(p => `:!${p}`);
      await git([`--work-tree=${fromDirectory}`, 'add', '-A', '-f', '--', '.', ...METADATA, ...links]);
      parent = baseCommit;
    }
    const changedFromBase = (await git(['diff', '--cached', '--name-only', baseCommit]))
      .split('\n')
      .filter(Boolean);
    // Overlay original PR test files; a path touched by several tasks takes the latest merge.
    const { latest } = attribute(tasks, gitShow(meta));
    for (const [path, commit] of Object.entries(latest)) {
      await git(['fetch', '-q', '--filter=blob:none', 'origin', commit]);
      const blob = await git(['rev-parse', `${commit}:${path}`]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const oracle = await git(['hash-object', '-w', ORACLE_SH]);
    await git(['update-index', '--add', '--cacheinfo', `100755,${oracle},.bench/ci.sh`]);
    const tree = await git(['write-tree']);
    const commit = await git(['commit-tree', tree, '-p', parent, '-m', `bench grading ${label}`]);
    return { commit, branch: `oracle/${label}`, changedFromBase };
  } finally {
    await rm(index, { force: true });
  }
}

const gh = async args => (await run('gh', args, { maxBuffer: 256 << 20 })).stdout;

/** Push the grading branch, dispatch bench-ci, wait (30 s reads, 40 min cap), keep the log
 * under logFile, then delete the run and the branch. */
export async function runOracle({ meta, branch, commit }, logFile) {
  await run('git', ['-C', meta, 'push', '-q', '--force', 'fork', `${commit}:refs/heads/${branch}`]);
  let r = null;
  try {
    const since = new Date(Date.now() - 5000).toISOString();
    await gh(['workflow', 'run', 'bench-ci.yml', '-R', repository, '--ref', branch]);
    for (let i = 0; i < 80; i++) {
      await wait(30_000);
      r ??= JSON.parse(
        await gh([
          'run',
          'list',
          '-R',
          repository,
          '--workflow',
          'bench-ci.yml',
          '--branch',
          branch,
          '-L',
          '5',
          '--json',
          'databaseId,headSha,createdAt,status,conclusion',
        ]),
      ).find(x => x.headSha === commit && fromGithub(x.createdAt) >= since);
      if (!r) continue;
      r = JSON.parse(
        await gh([
          'run',
          'view',
          String(r.databaseId),
          '-R',
          repository,
          '--json',
          'databaseId,headSha,createdAt,status,conclusion',
        ]),
      );
      if (r.status === 'completed') break;
    }
    if (r?.status !== 'completed') return { runId: r?.databaseId ?? null, status: 'unfinished' };
    const log = await gh(['run', 'view', String(r.databaseId), '-R', repository, '--log']);
    const lines = log.split('\n').filter(l => l.includes('ORACLE'));
    writeFileSync(logFile, lines.join('\n') + '\n');
    return { runId: r.databaseId, conclusion: r.conclusion, ...parseOracle(lines) };
  } finally {
    if (r?.databaseId) await gh(['run', 'delete', String(r.databaseId), '-R', repository]).catch(() => {});
    await gh(['api', '-X', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`]).catch(() => {});
  }
}

const unb64 = s => Buffer.from(s ?? '', 'base64').toString('utf8');
export function parseOracle(lines) {
  const files = {},
    packages = {},
    cases = [];
  for (const line of lines) {
    const at = line.indexOf('ORACLE');
    if (at < 0) continue;
    const parts = line.slice(at).trim().split(/\s+/);
    if (parts[0] === 'ORACLE' && parts.length >= 4)
      files[parts[2]] = { status: parts[1], assertions: parts[3] };
    if (parts[0] === 'ORACLE-PACKAGE') packages[parts[1]] = { status: parts[2], tests: parts[3] };
    if (parts[0] === 'ORACLE-CASE')
      cases.push({ status: parts[1], file: parts[2], fullName: unb64(parts[3]), message: unb64(parts[4]) });
  }
  return { files, packages, cases };
}

// A failure that only compares wording (two string literals) rather than behaviour.
const WORDING = /expected ['"`].*['"`] to (include|contain|be|equal|strictly equal|match) ['"`]/i;

/** Pre-registered scoring (PLAN.md): strict, lenient, wording-only flags, existing suites. */
export function grade(tasks, result, owners) {
  const shared = new Map();
  for (const t of tasks) for (const f of t.oracle.testFiles) shared.set(f, (shared.get(f) ?? 0) + 1);
  const owned = (task, c) =>
    task.oracle.testFiles.includes(c.file) &&
    (shared.get(c.file) === 1 ||
      Object.entries(owners.files[c.file] ?? {}).some(
        ([title, id]) => id === task.id && titleMatches(c.fullName, title),
      ));
  const cases = result.cases ?? [];
  const perTask = {},
    ownedAll = new Set();
  for (const task of tasks) {
    const mine = cases.filter(c => owned(task, c));
    mine.forEach(c => ownedAll.add(c));
    const passed = mine.filter(c => c.status === 'passed').length;
    const filesRan = task.oracle.testFiles.every(
      f => result.files?.[f] && result.files[f].assertions !== '0/0',
    );
    const failing = mine.filter(c => c.status !== 'passed');
    perTask[task.id] = {
      strict: filesRan && mine.length > 0 && failing.length === 0 ? 'passed' : 'failed',
      lenient: mine.length ? passed / mine.length : 0,
      cases: `${passed}/${mine.length}`,
      wordingOnly: failing.length > 0 && failing.every(c => WORDING.test(c.message)),
      fileLevel: task.oracle.testFiles.every(f => result.files?.[f]?.status === 'passed')
        ? 'passed'
        : 'failed',
    };
  }
  // Owned cases fail unless they pass (skipping a task's test never helps). Existing cases
  // fail only when failed: the base itself skips some (2 in shell.test.ts on the runner).
  const existing = cases.filter(c => !ownedAll.has(c));
  const values = Object.values(perTask);
  return {
    perTask,
    strictSuccess: values.filter(t => t.strict === 'passed').length,
    lenientScore: values.reduce((a, t) => a + t.lenient, 0) / Math.max(1, values.length),
    fileLevelSuccess: values.filter(t => t.fileLevel === 'passed').length,
    existingSuitesGreen:
      Object.keys(result.packages ?? {}).length === SUITES.length &&
      existing.every(c => c.status !== 'failed'),
    existingSkipped: existing.filter(c => c.status !== 'passed' && c.status !== 'failed').length,
    existingFailures: existing
      .filter(c => c.status === 'failed')
      .map(c => `${c.file} :: ${c.fullName}`)
      .slice(0, 50),
    suiteGreen:
      Object.values(result.packages ?? {}).length === SUITES.length &&
      Object.values(result.packages).every(p => p.status === 'passed'),
  };
}
