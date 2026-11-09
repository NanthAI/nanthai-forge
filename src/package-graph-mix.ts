// SPDX-License-Identifier: Apache-2.0
import { ecosystemEntry, nonSourceDirPattern } from './ecosystems.js';
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
} from './package-graph-types.js';

/** Paths below Mix's dependency and build folders (src/ecosystems.ts) or a hidden folder. */
const SKIP = nonSourceDirPattern([ecosystemEntry('elixir')]);
/** An ExUnit test file: `*_test.exs` below a project's `test/` folder. */
const testFile = (path: string) => /(?:^|\/)test\/(?:.*\/)?[^/]+_test\.exs$/.test(path);
/** mix.exs is Elixir code: it is read as text, never evaluated. Comments are dropped first. */
const code = (text: string) => text.replace(/#[^\n]*/g, '');

/** Elixir: every mix.exs is a Mix project, named by its `app:`. An umbrella (`apps_path:`) builds
 * nothing of its own (virtual); each project in its apps folder is declared. A project depends on the
 * project an `in_umbrella: true` or `path:` dependency names (a dependency named like an in-repository
 * app is over-, never under-selected); a `path:` inside the repository with no mix.exs Forge read, or
 * an `in_umbrella` app the umbrella lacks, marks it unresolved. Each project runs `mix test` in its
 * folder (umbrella apps build into the umbrella's `_build`); one without test files has nothing to run. */
export function mixGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(path => basename(path) === 'mix.exs' && !SKIP.test(path));
  if (!manifests.length) return null;
  const projects: { pkg: GraphPackage; text: string; umbrella?: string | undefined }[] = [];
  for (const manifest of manifests) {
    const raw = read(manifest);
    if (raw === undefined) return { ecosystem: 'mix', refusal: `${manifest} is unreadable` };
    const text = code(raw);
    const dir = dirname(manifest);
    const apps = /\bapps_path:\s*"([^"]+)"/.exec(text)?.[1];
    const app = /\bapp:\s*:"?([\w?!]+)"?/.exec(text)?.[1];
    projects.push({
      pkg: {
        ecosystem: 'mix',
        dir,
        name: app ?? (dir || '.'),
        manifest,
        dependsOn: [],
        testable: false,
        declared: false,
        ...(apps !== undefined ? { virtual: true as const } : {}),
      },
      text,
      ...(apps !== undefined ? { umbrella: joinPath(dir, apps) ?? undefined } : {}),
    });
  }
  const byDir = new Map(projects.map(item => [item.pkg.dir, item.pkg]));
  const byName = new Map(projects.map(item => [item.pkg.name, item.pkg]));
  /** The umbrella whose apps folder holds `dir` directly. */
  const umbrellaOf = (dir: string) =>
    projects.find(item => item.umbrella !== undefined && dirname(dir) === item.umbrella);
  for (const item of projects) if (umbrellaOf(item.pkg.dir)) item.pkg.declared = true;
  for (const test of paths.filter(path => testFile(path) && !SKIP.test(path))) {
    const owner = projects
      .map(item => item.pkg)
      .filter(pkg => !pkg.dir || test.startsWith(`${pkg.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner) owner.testable = true;
  }
  for (const item of projects) {
    const edges = new Set<string>();
    const umbrella = umbrellaOf(item.pkg.dir);
    for (const [, name, options] of item.text.matchAll(/\{\s*:([\w?!]+)\s*,([^{}]*)\}/g)) {
      const path = /\bpath:\s*"([^"]+)"/.exec(options!)?.[1];
      const local = path === undefined ? null : joinPath(item.pkg.dir, path);
      if (/\bin_umbrella:\s*true\b/.test(options!)) {
        const sibling = byName.get(name!);
        if (sibling && umbrella && umbrellaOf(sibling.dir) === umbrella) edges.add(packageKey(sibling));
        else
          item.pkg.unresolved ??= `${item.pkg.manifest} takes ${name} from its umbrella, which has no such app Forge read`;
        continue;
      }
      const target = (local !== null && byDir.get(local)) || byName.get(name!);
      if (target && target !== item.pkg) edges.add(packageKey(target));
      if (local !== null && !byDir.has(local))
        item.pkg.unresolved ??= `${item.pkg.manifest} depends on ${name} at ${local || '.'}, which has no mix.exs Forge read`;
    }
    item.pkg.dependsOn = [...edges].sort();
  }
  return {
    ecosystem: 'mix',
    // The root's command tests the root's own tests only, so a root reached as a dependent is one
    // more package.
    rootScoped: true,
    packages: projects.map(item => item.pkg),
    commands: selected =>
      [...selected]
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .map(pkg => ({ ecosystem: 'mix', cwd: pkg.dir, argv: ['mix', 'test'], packages: [packageKey(pkg)] })),
  };
}
