// B1.5d Metric 4 ground truth: did two tasks really change the same code? Each task's
// changed files are copied when its agent exits; after the cell, every pair of tasks that
// changed one file is merged three-way against the base (`git merge-file`). A conflict means
// both changed the same hunks (git's own rule: overlapping or touching changed regions with
// different results). A task that synced its sibling's change in carries that change on both
// sides, which merges clean, so only its own overlapping edits count.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffFromBase } from './forge-arm.mjs';

const run = promisify(execFile);
const MAX_FILES = 300,
  MAX_BYTES = 2 << 20;

/** The tree the agent last worked in: its Lane root, or the newest resolve Lane a sync
 * conflict opened under <root>.forge-client/lanes (where the agent resolves and lands). */
export function latestTree(root) {
  const lanes = `${root}.forge-client/lanes`;
  const mtime = d => {
    try {
      return statSync(join(d, '.forge', 'hosted-lane.json')).mtimeMs;
    } catch {
      return -1;
    }
  };
  const candidates = [root, ...(existsSync(lanes) ? readdirSync(lanes).map(d => join(lanes, d)) : [])];
  return candidates.reduce((best, d) => (mtime(d) > mtime(best) ? d : best), root);
}

/** Copy the task's changed files (vs base; build output the tree ignores is left out). */
export async function captureChanges({ arm, meta, baseCommit, root, out, diff = diffFromBase }) {
  const tree = arm === 'forge' ? latestTree(root) : root;
  const marker =
    arm === 'forge' ? JSON.parse(readFileSync(join(tree, '.forge', 'hosted-lane.json'), 'utf8')) : null;
  const scope = marker?.scope ?? null;
  let changes = await diff(meta, baseCommit, tree, scope);
  if (scope !== null)
    changes = changes.filter(c => scope.some(path => c.path === path || c.path.startsWith(path + '/')));
  const added = changes.filter(c => c.status === 'A').map(c => c.path);
  if (added.length) {
    const ignored = await run(
      'git',
      ['-C', meta, `--work-tree=${tree}`, 'check-ignore', '--no-index', ...added],
      {
        maxBuffer: 64 << 20,
      },
    ).then(
      r => new Set(r.stdout.split('\n').filter(Boolean)),
      e =>
        new Set(
          String(e.stdout ?? '')
            .split('\n')
            .filter(Boolean),
        ), // exit 1 = none ignored
    );
    changes = changes.filter(c => !(c.status === 'A' && ignored.has(c.path)));
  }
  const files = [];
  for (const c of changes.slice(0, MAX_FILES)) {
    const entry = { path: c.path, status: c.status };
    if (c.status !== 'D') {
      const size = statSync(join(tree, c.path)).size;
      entry.bytes = size;
      if (size <= MAX_BYTES) {
        await mkdir(dirname(join(out, c.path)), { recursive: true });
        await copyFile(join(tree, c.path), join(out, c.path));
        entry.saved = true;
      }
    }
    files.push(entry);
  }
  return {
    tree: tree === root ? 'lane' : 'resolve-lane',
    dir: out,
    ...(arm === 'forge' ? { scope } : {}),
    files,
    truncated: changes.length > MAX_FILES,
  };
}

/** Three-way merge of two versions of one file over its base: conflict count (0 = clean),
 * or null when git could not merge (a missing input exits 255): no evidence either way. */
export async function mergeConflicts(ours, base, theirs) {
  try {
    await run('git', ['merge-file', '-p', '--quiet', ours, base, theirs], { maxBuffer: 64 << 20 });
    return 0;
  } catch (error) {
    // git merge-file exits with the conflict count, capped at 127; errors exit 128 or more.
    return typeof error.code === 'number' && error.code > 0 && error.code < 128 ? error.code : null;
  }
}

/** One added file's content contains the other's whole content. */
async function carries(x, y) {
  const [a, b] = await Promise.all([readFile(x, 'utf8'), readFile(y, 'utf8')]);
  return a.includes(b) || b.includes(a);
}

/** Every pair of tasks that changed one file, with whether they really conflict. */
export async function realConflicts({ meta, baseCommit, tasks }) {
  const byPath = new Map();
  for (const t of tasks)
    for (const f of t.changes?.files ?? []) {
      if (!byPath.has(f.path)) byPath.set(f.path, []);
      byPath.get(f.path).push({ task: t.task, dir: t.changes.dir, ...f });
    }
  const exists = spec =>
    run('git', ['-C', meta, 'cat-file', '-e', spec]).then(
      () => true,
      () => false,
    );
  // A base commit git cannot read leaves every pair unknown rather than inventing conflicts.
  const baseOk = await exists(`${baseCommit}^{commit}`);
  const tmp = await mkdtemp(join(tmpdir(), 'b15d-merge-'));
  const out = [];
  try {
    for (const [path, entries] of byPath) {
      if (entries.length < 2) continue;
      const basePath = join(tmp, 'base');
      // Not in the base: the tasks added it, so the base is empty. Any other read error: unknown.
      const inBase = baseOk && (await exists(`${baseCommit}:${path}`));
      const shown = inBase
        ? await run('git', ['-C', meta, 'show', `${baseCommit}:${path}`], { maxBuffer: 64 << 20 }).catch(
            () => null,
          )
        : { stdout: '' };
      const baseKnown = baseOk && shown !== null && (inBase || entries.every(e => e.status === 'A'));
      await writeFile(basePath, shown?.stdout ?? '');
      for (let i = 0; i < entries.length; i++)
        for (let j = i + 1; j < entries.length; j++) {
          const [a, b] = [entries[i], entries[j]];
          const pair = { path, tasks: [a.task, b.task] };
          if (!baseKnown) pair.realConflict = null; // base unreadable
          else if (a.status === 'D' || b.status === 'D')
            pair.realConflict = !(a.status === 'D' && b.status === 'D'); // modify/delete
          else if (!a.saved || !b.saved) pair.realConflict = null; // too large to keep
          else if (
            a.status === 'A' &&
            b.status === 'A' &&
            (await carries(join(a.dir, path), join(b.dir, path)))
          ) {
            // Both added it, one on top of the other (it synced the sibling's version in):
            // from an empty base git sees one overlapping insert, but nothing conflicts.
            pair.carried = true;
            pair.realConflict = false;
          } else {
            pair.conflicts = await mergeConflicts(join(a.dir, path), basePath, join(b.dir, path));
            pair.realConflict = pair.conflicts === null ? null : pair.conflicts > 0;
          }
          out.push(pair);
        }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return out;
}
