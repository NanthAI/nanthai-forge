// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitlinkGitDirectory } from './gitlink-workspace.js';
import {
  SubmoduleFetcher,
  submoduleCountLimit,
  submoduleDepthLimit,
  submoduleGit,
  vetted,
} from './submodule-materialize.js';

const fetchTimeoutMs = 10 * 60_000;
export type SubmoduleReportLists = {
  materialized: string[];
  refused: { path: string; commit: string; url: string | null; reason: string }[];
};

const cacheOptions = (cache: string) => ({ cache });
/** A submodule checkout with its own small `.git`: objects come from the shared cache through
 * `alternates`, HEAD is detached at the pinned commit and the index matches the tree, so
 * `git -C PATH status` is clean and `git -C PATH checkout --detach SHA` bumps the pointer. */
export async function checkoutRepository(
  fetcher: SubmoduleFetcher,
  cache: string,
  url: string,
  commit: string,
  target: string,
  report: SubmoduleReportLists,
  label: string,
  depth = 0,
) {
  const repository = fetcher.repository(url),
    gitDirectory = join(target, '.git'),
    options = cacheOptions(cache);
  await submoduleGit(null, ['init', '--quiet', '--template=', target], options);
  await mkdir(join(gitDirectory, 'objects', 'info'), { recursive: true });
  await writeFile(join(gitDirectory, 'objects', 'info', 'alternates'), `${join(repository, 'objects')}\n`);
  const shallow = await readFile(join(repository, 'shallow'), 'utf8').catch(() => '');
  if (shallow.split('\n').includes(commit)) await writeFile(join(gitDirectory, 'shallow'), `${commit}\n`);
  await submoduleGit(gitDirectory, ['config', 'remote.origin.url', url], options);
  await submoduleGit(
    gitDirectory,
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    options,
  );
  await submoduleGit(gitDirectory, ['update-ref', '--no-deref', 'HEAD', commit], options);
  await submoduleGit(
    gitDirectory,
    ['--work-tree', target, 'read-tree', '--reset', '-u', 'HEAD'],
    options,
    fetchTimeoutMs,
  );
  if (depth + 1 >= submoduleDepthLimit) return;
  for (const nested of await fetcher.nested(url, commit)) {
    if (report.materialized.length >= submoduleCountLimit) return;
    const path = `${label}/${nested.path}`,
      chosen = vetted({ url: nested.url, origin: url });
    // As in a non-recursive Git clone, an unavailable nested submodule stays an empty directory.
    const pinned = 'url' in chosen ? await fetcher.pin(chosen.url, nested.commit) : chosen.reason;
    if (!('url' in chosen) || typeof pinned === 'string') {
      report.refused.push({
        path,
        commit: nested.commit,
        url: nested.url,
        reason: 'url' in chosen ? (pinned as string) : chosen.reason,
      });
      continue;
    }
    const inner = join(target, nested.path);
    if (existsSync(inner)) {
      if (readdirSync(inner).length) continue;
      await rm(inner, { recursive: true });
    }
    await checkoutRepository(fetcher, cache, chosen.url, nested.commit, inner, report, path, depth + 1);
    report.materialized.push(path);
  }
}
/** Move a parked checkout to `commit` (fetched into the shared cache first). Local changes that
 * the checkout would overwrite refuse; the directory then stays parked and is reported. */
export async function moveCheckout(
  fetcher: SubmoduleFetcher,
  cache: string,
  url: string,
  commit: string,
  parkDirectory: string,
  id: string,
) {
  const directory = join(parkDirectory, id),
    gitDirectory = gitlinkGitDirectory(parkDirectory, id),
    repository = fetcher.repository(url),
    options = cacheOptions(cache);
  const present = await submoduleGit(gitDirectory, ['cat-file', '-e', `${commit}^{commit}`], options).then(
    () => true,
    () => false,
  );
  if (!present)
    await submoduleGit(
      gitDirectory,
      ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', repository, commit],
      options,
      fetchTimeoutMs,
      {},
      ['protocol.file.allow=always'],
    );
  else {
    // Objects reached through the shared cache's alternates: mirror its shallow boundary.
    const shallow = await readFile(join(repository, 'shallow'), 'utf8').catch(() => '');
    const local = await readFile(join(gitDirectory, 'shallow'), 'utf8').catch(() => '');
    if (shallow.split('\n').includes(commit) && !local.split('\n').includes(commit))
      await appendFile(join(gitDirectory, 'shallow'), `${commit}\n`);
  }
  await submoduleGit(
    gitDirectory,
    ['--work-tree', directory, 'checkout', '--quiet', '--detach', commit],
    options,
    fetchTimeoutMs,
  );
}
