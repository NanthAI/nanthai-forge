// B1.5d oracle: each task's own PR tests (original versions) plus the existing suites
// of the four packages, run on the exact final main of a cell, on GitHub Actions in
// the fork (public, free minutes). Works from a fork commit (GitHub arm) or from a
// directory holding Forge's final main (Forge arm), so both arms use one grader.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { repository } from './github-arm.mjs';

const EXCLUDE = [
  ':!.repos',
  ':!apps/mobile/modules/t3-terminal/Vendor',
  ':!.forge',
  ':!.nforge',
  ':!.github/workflows',
];

export function oracleCommit({ meta, tasks, setup, label, fromCommit, fromDirectory, sgCommit }) {
  const env = {
    ...process.env,
    GIT_INDEX_FILE: `${meta}/.git/oracle-${label}.index`,
    GIT_AUTHOR_NAME: 'NanthAI bench',
    GIT_AUTHOR_EMAIL: 'bench@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'NanthAI bench',
    GIT_COMMITTER_EMAIL: 'bench@users.noreply.github.com',
  };
  const git = (args, extra = {}) =>
    execFileSync('git', ['-C', meta, ...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 256 << 20,
      ...extra,
    }).trim();
  let parent;
  if (fromCommit) {
    git(['fetch', '-q', '--filter=blob:none', 'fork', fromCommit]);
    git(['read-tree', fromCommit]);
    parent = fromCommit;
  } else {
    // Forge final main: hash the materialized tree over the base index (sparse paths
    // and Forge metadata excluded; workflows come from the GitHub-arm base).
    git(['read-tree', sgCommit]);
    execFileSync('git', ['-C', meta, `--work-tree=${fromDirectory}`, 'add', '-A', '--', '.', ...EXCLUDE], {
      env,
    });
    parent = sgCommit;
  }
  // Overlay original PR test files; a path touched by several tasks takes the latest merge.
  const latest = new Map();
  for (const task of [...tasks].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)))
    for (const path of task.oracle.testFiles) latest.set(path, task.mergeCommit);
  for (const [path, commit] of latest) {
    git(['fetch', '-q', '--filter=blob:none', 'origin', commit]);
    const blob = git(['rev-parse', `${commit}:${path}`]);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  }
  const oracle = git(['hash-object', '-w', `${setup}/.bench/oracle.sh`]);
  git(['update-index', '--add', '--cacheinfo', `100755,${oracle},.bench/ci.sh`]);
  const tree = git(['write-tree']);
  const commit = git(['commit-tree', tree, '-p', parent, '-m', `bench oracle ${label}`]);
  git(['push', '-q', '--force', 'fork', `${commit}:refs/heads/oracle/${label}`]);
  rmSync(env.GIT_INDEX_FILE, { force: true });
  return {
    commit,
    branch: `oracle/${label}`,
    changedFromBase: fromDirectory ? git(['diff', '--name-only', sgCommit, commit]).split('\n') : null,
  };
}

/** Dispatch bench-ci on the oracle branch and wait (finite, 30 s reads, 30 min cap). */
export async function runOracle({ branch, commit }) {
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
  const since = new Date(Date.now() - 5000).toISOString();
  gh(['workflow', 'run', 'bench-ci.yml', '-R', repository, '--ref', branch]);
  let run;
  for (let i = 0; i < 60; i++) {
    await wait(30_000);
    run ??= JSON.parse(
      gh([
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
    ).find(r => r.headSha === commit && r.createdAt >= since);
    if (!run) continue;
    run = JSON.parse(
      gh([
        'run',
        'view',
        String(run.databaseId),
        '-R',
        repository,
        '--json',
        'databaseId,headSha,createdAt,status,conclusion',
      ]),
    );
    if (run.status === 'completed') break;
  }
  if (run?.status !== 'completed') return { runId: run?.databaseId ?? null, status: 'unfinished' };
  const log = gh(['run', 'view', String(run.databaseId), '-R', repository, '--log']);
  const files = {},
    packages = {};
  for (const line of log.split('\n')) {
    const at = line.indexOf('ORACLE');
    if (at < 0) continue;
    const parts = line.slice(at).trim().split(/\s+/);
    if (parts[0] === 'ORACLE' && parts.length >= 4)
      files[parts[2]] = { status: parts[1], assertions: parts[3] };
    if (parts[0] === 'ORACLE-PACKAGE') packages[parts[1]] = { status: parts[2], tests: parts[3] };
  }
  return { runId: run.databaseId, conclusion: run.conclusion, files, packages };
}

export function grade(tasks, result) {
  const perTask = Object.fromEntries(
    tasks.map(task => [
      task.id,
      task.oracle.testFiles.every(path => result.files?.[path]?.status === 'passed') ? 'passed' : 'failed',
    ]),
  );
  const suiteGreen =
    Object.values(result.packages ?? {}).length === 4 &&
    Object.values(result.packages).every(p => p.status === 'passed');
  return { perTask, strictSuccess: Object.values(perTask).filter(s => s === 'passed').length, suiteGreen };
}

export const loadTasks = path => JSON.parse(readFileSync(path, 'utf8')).tasks;
