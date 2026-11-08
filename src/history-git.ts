// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { inTestProcess } from './test-isolation.js';
import { gitCommand, gitFailure, gitTimeout } from './work-git-command.js';

/** Imported Git history on this machine: one bare repository per hosted project
 * holding the project's packs exactly as stored, indexed by `git index-pack`
 * (which verifies every object). Disposable: the server checks access on every
 * read before the cache is used. `FORGE_HISTORY_CACHE` moves it. */
export function historyCacheDirectory(address: { url: string; projectId: string }): string {
  const value = process.env.FORGE_HISTORY_CACHE;
  invariant(
    value || !inTestProcess(),
    'HISTORY_CACHE_UNAVAILABLE',
    'Set FORGE_HISTORY_CACHE in tests; the shared machine cache is not used.',
  );
  const base = value
    ? resolve(value)
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'history');
  const key = createHash('sha256').update(`${address.url}\0${address.projectId}`).digest('hex').slice(0, 32);
  return join(base, `${key}.git`);
}

function git(repo: string, args: string[], maxBuffer = 64 * 1024 * 1024): Buffer {
  const command = gitCommand(repo, args);
  try {
    return execFileSync('git', command.args, { env: command.env, timeout: gitTimeout() * 3, maxBuffer });
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT')
      throw new ForgeError('GIT_REQUIRED', 'History reads use the git command; install Git and retry.');
    throw gitFailure(error, args);
  }
}

export function ensureHistoryRepository(repo: string) {
  if (existsSync(join(repo, 'HEAD'))) return;
  mkdirSync(dirname(repo), { recursive: true, mode: 0o700 });
  git(dirname(repo), ['init', '--bare', '-q', repo]);
  // Never collect: every object here is history someone may read.
  git(repo, ['config', 'gc.auto', '0']);
}

/** Pack checksums already indexed here (an .idx exists only after index-pack finished). */
export function cachedPacks(repo: string): string[] {
  const directory = join(repo, 'objects', 'pack');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => /^pack-([0-9a-f]{40})\.idx$/.exec(name)?.[1])
    .filter((id): id is string => !!id);
}

/** Streams one pack's chunks into `git index-pack --stdin`; each chunk is checked
 * against its pin first and the resulting pack name must equal `packSha1`. */
export async function indexPack(
  repo: string,
  packSha1: string,
  chunks: AsyncIterable<{ bytes: Uint8Array; sha256: string; size: number }>,
) {
  const command = gitCommand(repo, ['index-pack', '--stdin']);
  const child = spawn('git', command.args, { env: command.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', part => (stdout += part));
  child.stderr.on('data', part => (stderr += part));
  const exited = new Promise<number>((done, fail) => {
    child.on('error', error =>
      fail(
        (error as { code?: string }).code === 'ENOENT'
          ? new ForgeError('GIT_REQUIRED', 'History reads use the git command; install Git and retry.')
          : error,
      ),
    );
    child.on('close', code => done(code ?? 1));
  });
  try {
    for await (const chunk of chunks) {
      invariant(
        chunk.bytes.length === chunk.size &&
          createHash('sha256').update(chunk.bytes).digest('hex') === chunk.sha256,
        'SOURCE_HASH_MISMATCH',
        'A downloaded history chunk differs from its pin.',
      );
      if (!child.stdin.write(chunk.bytes))
        await new Promise<void>(done => child.stdin.once('drain', () => done()));
    }
    child.stdin.end();
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
  const code = await exited;
  if (code !== 0) throw gitFailure({ stderr, status: code }, ['index-pack']);
  const name = /([0-9a-f]{40})\s*$/.exec(stdout)?.[1];
  invariant(name === packSha1, 'GIT_PACK_INVALID', 'The indexed history pack differs from its record.');
}

/** Full commit id for a hex id or prefix present in this cache; never a revision expression. */
export function resolveCommit(repo: string, commit: string): string {
  invariant(/^[0-9a-f]{4,40}$/.test(commit), 'BAD_ARGUMENT', 'Select a commit by its hex id.');
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`])
      .toString()
      .trim();
  } catch {
    throw new ForgeError('NOT_FOUND', `Commit ${commit} is not in this project's stored history.`);
  }
}

export type HistoryEntry = {
  commit: string;
  parents: string[];
  author: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
};
export function historyLog(
  repo: string,
  commit: string,
  options: { path?: string | undefined; limit: number; skip: number },
): { entries: HistoryEntry[]; more: boolean } {
  const out = git(repo, [
    'log',
    '--no-color',
    '--format=%H%x00%P%x00%an%x00%aI%x00%cI%x00%s%x1e',
    `--max-count=${options.limit + 1}`,
    `--skip=${options.skip}`,
    commit,
    '--',
    ...(options.path ? [`:(literal)${options.path}`] : []),
  ]).toString('utf8');
  const entries = out
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map(record => {
      const [id, parents, author, authoredAt, committedAt, subject] = record.split('\0');
      return {
        commit: id!,
        parents: parents ? parents.split(' ') : [],
        author: author!,
        authoredAt: authoredAt!,
        committedAt: committedAt!,
        subject: subject ?? '',
      };
    });
  return { entries: entries.slice(0, options.limit), more: entries.length > options.limit };
}

export type BlameRange = { commit: string; start: number; end: number; originalStart: number; path: string };
/** `git blame --porcelain`, grouped into ranges of consecutive final lines per commit. */
export function historyBlame(
  repo: string,
  commit: string,
  path: string,
  lines?: { start: number; end?: number | undefined },
) {
  const out = git(repo, [
    'blame',
    '--porcelain',
    ...(lines ? ['-L', `${lines.start},${lines.end ?? ''}`] : []),
    commit,
    '--',
    path,
  ]).toString('utf8');
  const commits: Record<string, { author: string; authoredAt: string; summary: string }> = {};
  const ranges: BlameRange[] = [];
  let current: { commit: string; original: number; final: number } | null = null;
  const pathOf = new Map<string, string>();
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = { commit: header[1]!, original: Number(header[2]), final: Number(header[3]) };
      commits[current.commit] ??= { author: '', authoredAt: '', summary: '' };
      continue;
    }
    if (!current) continue;
    const info = commits[current.commit]!;
    if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('author-time '))
      info.authoredAt = new Date(Number(line.slice(12)) * 1000).toISOString();
    else if (line.startsWith('summary ')) info.summary = line.slice(8);
    else if (line.startsWith('filename ')) pathOf.set(current.commit, line.slice(9));
    else if (line.startsWith('\t')) {
      const last = ranges.at(-1);
      const file = pathOf.get(current.commit) ?? path;
      if (last && last.commit === current.commit && last.end + 1 === current.final && last.path === file)
        last.end = current.final;
      else
        ranges.push({
          commit: current.commit,
          start: current.final,
          end: current.final,
          originalStart: current.original,
          path: file,
        });
      current = null;
    }
  }
  return { ranges, commits };
}

/** Exact bytes of one file at a commit; a directory, gitlink or absent path is NOT_FOUND. */
export function historyFile(repo: string, commit: string, path: string, maxBytes: number | null) {
  const row = git(repo, ['ls-tree', '-z', commit, '--', `:(literal)${path}`])
    .toString('utf8')
    .split('\0')
    .find(entry => entry.slice(entry.indexOf('\t') + 1) === path);
  invariant(row, 'NOT_FOUND', `${path} is absent at commit ${commit}.`);
  const [mode, type, blob] = row.slice(0, row.indexOf('\t')).split(' ');
  invariant(type === 'blob' && blob, 'NOT_FOUND', `${path} is not a file at commit ${commit}.`);
  const size = Number(git(repo, ['cat-file', '-s', blob]).toString().trim());
  invariant(
    maxBytes === null || size <= maxBytes,
    'FILE_LIMIT',
    'File exceeds 1 MiB; use force:true to read exact bytes.',
  );
  return { mode: mode!, blob, bytes: git(repo, ['cat-file', 'blob', blob], Math.max(size + 1, 4096)) };
}
