// SPDX-License-Identifier: Apache-2.0
// Zoo cleanup uses current project identities, including prior imports no longer in state.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { exec } from './exec.mjs';

async function projectList(cfg, repos, state) {
  const names = new Set(repos.map(r => `bench-zoo-${r.id}`));
  const ids = new Set(repos.map(r => state.repos[r.id]?.projectId).filter(Boolean));
  const load = path => import(pathToFileURL(join(cfg.forgeCheckout, path)).href);
  const [{ resolveAuthToken }, { deadlineConvexClient }, { makeFunctionReference }] = await Promise.all([
    load('dist/auth-store.js'),
    load('dist/network-convex-client.js'),
    load('node_modules/convex/dist/esm/server/index.js'),
  ]);
  const client = deadlineConvexClient(cfg.deployment, {});
  client.setAuth(resolveAuthToken(cfg.deployment));
  const projects = [];
  let cursor = null;
  do {
    const page = await client.query(makeFunctionReference('projectBackups:list'), {
      paginationOpts: { cursor, numItems: 100 },
    });
    projects.push(...page.page.filter(p => names.has(p.name) || ids.has(p.id)));
    if (page.isDone) break;
    if (page.continueCursor === cursor) throw Error('zoo project list did not advance');
    cursor = page.continueCursor;
  } while (cursor);
  return projects;
}

export async function teardown(
  root,
  repos,
  { projectsOnly = false, list = projectList, run = exec, sleep = wait } = {},
) {
  const zoo = JSON.parse(readFileSync(join(root, 'zoo.json'), 'utf8'));
  const statePath = join(root, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { repos: {} };
  const projects = await list(zoo, repos, state); // One paged metadata read, never one discovery call per repository.
  const journalPath = join(root, 'teardown.json');
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {};
  const out = [];
  for (const entry of repos) {
    const name = `bench-zoo-${entry.id}`;
    const saved = state.repos[entry.id];
    const targets = projects.filter(p => p.id === saved?.projectId || p.name === name);
    if (saved?.projectId && !targets.some(p => p.id === saved.projectId))
      out.push({
        id: entry.id,
        projectId: saved.projectId,
        project: 'NOT DELETED (project unavailable)',
        repo: 'kept',
      });
    for (const target of targets) {
      const prior = journal[target.id];
      const slug = target.slug ?? prior?.slug ?? saved?.slug;
      // A tombstone is already the server's purge confirmation; its slug may have been cleared.
      if (target.removal === 'deleted') {
        out.push({ id: entry.id, projectId: target.id, project: 'deleted', repo: 'kept' });
        continue;
      }
      if (!slug) {
        out.push({
          id: entry.id,
          projectId: target.id,
          project: 'NOT DELETED (slug unavailable)',
          repo: 'kept',
        });
        continue;
      }
      journal[target.id] = { ...prior, slug };
      writeFileSync(journalPath, JSON.stringify(journal, null, 1) + '\n');
      const del = () =>
        run('nforge', [
          'host',
          root,
          '--delete-project',
          target.id,
          '--confirm',
          slug,
          '--deployment',
          zoo.deployment,
          '--json',
        ]);
      let r = await del();
      for (let i = 0; i < 20 && r.code && /HOST_DELETE_PENDING/.test(r.stderr + r.stdout); i++) {
        await sleep(15_000);
        r = await del(); // Same ROOT, project and confirmed slug reconcile the original operation.
      }
      const confirmed = !r.code && r.json?.purgeComplete === true;
      journal[target.id] = { slug, receipt: r.json, confirmed };
      writeFileSync(journalPath, JSON.stringify(journal, null, 1) + '\n');
      out.push({
        id: entry.id,
        projectId: target.id,
        project: confirmed ? 'deleted' : `NOT DELETED (${(r.stderr || r.stdout).slice(-120).trim()})`,
        repo: 'kept',
      });
    }
    if (
      targets.some(p => p.id === saved?.projectId) &&
      !out.some(r => r.id === entry.id && /NOT/.test(r.project))
    )
      delete state.repos[entry.id];
    writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n');
    if (projectsOnly) continue;
    const gone = await run('gh', ['repo', 'delete', entry.fork, '--yes']);
    out.push({
      id: entry.id,
      project: 'none',
      repo:
        gone.code === 0
          ? 'deleted'
          : /Could not resolve|404/.test(gone.stderr)
            ? 'absent'
            : `NOT DELETED (${gone.stderr.slice(-120).trim()})`,
    });
  }
  return out;
}
