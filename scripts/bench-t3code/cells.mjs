// SPDX-License-Identifier: Apache-2.0
// Coordination cells of the P6 exit bench (Issue bf130503, plan: docs/research/p6-exit-bench-plan.md):
//   convoy   N agents, each a task in a different workspace package (new files only), one
//            start signal: measures the landing convoy (pass: rework.mjs convoyVerdict);
//   overlap  N agents, each its own package plus one line in one shared hot file: measures
//            rework tokens and conflict repairs per landing; the Forge arm runs twice, stacking
//            offer and auto-stack (D2, Issue 1eb42254), the A/B that picks the default.
// Tasks are generated from the base checkout's own workspace manifest, so the cells work on
// any repository with packages; nothing here names a repository, package or language.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rng } from './plan.mjs';

export const COORDINATION = Object.freeze({
  seed: 'p6-coordination-2026-11-08',
  convoy: Object.freeze({ ns: [4, 8, 16], reps: 2, arms: ['github', 'forge'] }),
  // Forge twice: the stacking A/B (offer = today's default, auto = the D2 setting).
  overlap: Object.freeze({
    ns: [4, 8],
    reps: 2,
    arms: ['github', 'forge:offer', 'forge:auto'],
  }),
  // Convoy pass (owner 2026-11-08, binding at N = 16): time to main <= 1.3 x median Lane
  // check wall + 2 min for every landing, and no order wait against an independent entry.
  passFactor: 1.3,
  passSlackSeconds: 120,
  // The shared file of the overlap cell, relative to the repository root (must exist in the base).
  hotFile: 'README.md',
});

/** Workspace package folders of a checkout: package.json `workspaces` or pnpm-workspace.yaml
 * `packages` entries, exact folders or `dir/*` globs; only folders holding a package.json. */
export function workspacePackages(root) {
  const patterns = [];
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    const w = JSON.parse(readFileSync(pkg, 'utf8')).workspaces;
    patterns.push(...(Array.isArray(w) ? w : (w?.packages ?? [])));
  }
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    let inPackages = false;
    for (const line of readFileSync(pnpm, 'utf8').split('\n')) {
      if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
      const m = inPackages && /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line);
      if (m) patterns.push(m[1]);
    }
  }
  const found = new Set();
  for (const p of patterns) {
    if (p.startsWith('!')) continue;
    const glob = /^(.*?)\/\*$/.exec(p);
    const dirs = glob
      ? existsSync(join(root, glob[1]))
        ? readdirSync(join(root, glob[1]), { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => `${glob[1]}/${d.name}`)
        : []
      : [p.replace(/\/$/, '')];
    for (const d of dirs) if (!d.includes('*') && existsSync(join(root, d, 'package.json'))) found.add(d);
  }
  return [...found].sort();
}

const fnName = (kind, k) => `${kind}Task${k}`;

/** The N tasks of a cell: N distinct packages chosen by the cell seed (the same packages for
 * every arm and rep of that N), one task each. Refuses when the repository has fewer packages. */
export function coordinationTasks(kind, N, packages, { hotFile = COORDINATION.hotFile } = {}) {
  if (!['convoy', 'overlap'].includes(kind)) throw Error(`BENCH_CELL_KIND ${kind}`);
  if (packages.length < N)
    throw Error(
      `BENCH_CELL_PACKAGES: a ${kind} cell at N = ${N} needs ${N} packages; the base has ${packages.length}`,
    );
  const random = rng(`${COORDINATION.seed}/${kind}/n${N}`);
  const pool = [...packages];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, N).map((dir, i) => {
    const k = i + 1,
      fn = fnName(kind, k);
    const hot =
      kind === 'overlap'
        ? `\n\nAlso add exactly one line \`- ${fn}: ${dir}\` at the end of \`${hotFile}\` in the repository root. Other agents add their own line to that file at the same time; keep every line already there.`
        : '';
    return {
      id: `${kind[0]}${String(k).padStart(2, '0')}`,
      overlap: kind === 'convoy' ? `disjoint:${dir}` : `overlap:hot-file ${hotFile}`,
      package: dir,
      prompt: `${kind}: add ${fn} to ${dir}\n\nAdd a small new module to the package in \`${dir}\` and nowhere else: export a function \`${fn}()\` that returns the string \`"${fn}"\`, in a new source file named after the package's conventions, with a new unit test for it next to it that uses the package's existing test setup. Change no existing file of the package.${hot} Every agent of this run starts at the same moment: land your change as soon as it is ready.`,
      scope: { package: dir, hotFile: kind === 'overlap' ? hotFile : null, fn },
    };
  });
}

/** The cells of one (kind, N, rep): sequential (never 2N agents at once), first arm rotating
 * with the rep so no arm always runs first. `slot` names a cell's files in the batch folder. */
export function coordinationBatch(kind, N, rep) {
  const design = COORDINATION[kind];
  const arms = [...design.arms];
  for (let i = 0; i < (rep - 1) % arms.length; i++) arms.push(arms.shift());
  const key = `${kind}-n${N}-r${rep}`;
  return {
    key,
    kind,
    N,
    rep,
    seed: `${COORDINATION.seed}/${kind}/n${N}`,
    mode: 'sequential',
    agentsAtOnce: N,
    // Task ids of coordinationTasks, in dispatch order (all start on one signal).
    order: Array.from({ length: N }, (_, i) => `${kind[0]}${String(i + 1).padStart(2, '0')}`),
    cells: arms.map(a => {
      const [arm, stack = null] = a.split(':');
      const slot = stack ? `${arm}-${stack}` : arm;
      return { key: `${slot}-${key}`, arm, stack, slot, kind, N, rep };
    }),
  };
}

/** Every coordination batch: reps outer, convoy then overlap, N descending (hardest first). */
export function coordinationBatches(reps = [1, 2]) {
  return reps.flatMap(rep =>
    ['convoy', 'overlap'].flatMap(kind =>
      COORDINATION[kind].reps >= rep
        ? [...COORDINATION[kind].ns].sort((a, b) => b - a).map(N => coordinationBatch(kind, N, rep))
        : [],
    ),
  );
}

/** Parse `convoy-n16-r1` (with an optional cell slot prefix). */
export function parseCoordinationKey(key) {
  const m = /^(?:(github|forge(?:-offer|-auto)?)-)?(convoy|overlap)-n(\d+)-r(\d+)$/.exec(String(key));
  return m ? { slot: m[1] ?? null, kind: m[2], N: Number(m[3]), rep: Number(m[4]) } : null;
}

/** Landing-only grade of a coordination cell (the tasks are not graded by hidden tests): a
 * task passes when it landed and its captured changes stay inside its package (plus the hot
 * file in the overlap cell) and name its function. */
export function scopeGrade(tasks, records) {
  const byTask = new Map(records.map(r => [r.task, r]));
  const cases = tasks.map(t => {
    const r = byTask.get(t.id);
    const files = r?.changes?.files ?? null;
    const inside = p => p.startsWith(`${t.scope.package}/`) || p === t.scope.hotFile;
    const outside = files ? files.map(f => f.path).filter(p => !inside(p)) : null;
    // The function is in one of the saved copies of its package's files (hunks.mjs captureChanges).
    const named = (files ?? []).some(f => {
      const copy = f.saved && r.changes.dir ? join(r.changes.dir, f.path) : null;
      return (
        f.path !== t.scope.hotFile &&
        copy &&
        existsSync(copy) &&
        readFileSync(copy, 'utf8').includes(t.scope.fn)
      );
    });
    const ok = Boolean(r?.landing?.landed && files && !outside.length && named);
    return { task: t.id, landed: Boolean(r?.landing?.landed), outside, named, ok };
  });
  return { kind: 'scope', cases, strictSuccess: cases.filter(c => c.ok).length, tasks: tasks.length };
}
