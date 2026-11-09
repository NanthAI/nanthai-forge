// SPDX-License-Identifier: Apache-2.0
import { ecosystemEntry, managerLockfiles, nonSourceDirPattern } from './ecosystems.js';
import { globRegExp } from './path-glob.js';
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
  type PackageCommand,
} from './package-graph-types.js';

const RUBY_SKIP = nonSourceDirPattern([ecosystemEntry('ruby')]);
const PHP_SKIP = nonSourceDirPattern([ecosystemEntry('php')]);
const COMPOSER_LOCKS = new Set(managerLockfiles([ecosystemEntry('php')]).get('composer'));
export const gemspecManifest = (path: string) => /\.gemspec$/.test(path) && !RUBY_SKIP.test(path);
const at = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const within = (dir: string, path: string) => !dir || path.startsWith(`${dir}/`);
/** The deepest package of `packages` whose folder holds `path`. */
const ownerOf = (packages: GraphPackage[], path: string) =>
  packages.filter(pkg => within(pkg.dir, path)).sort((a, b) => b.dir.length - a.dir.length)[0];
/** Ruby is read as text, never evaluated; comments are dropped first. */
const ruby = (text: string) => text.replace(/(^|\s)#[^\n]*/g, '$1');

type Gem = { pkg: GraphPackage; texts: string[]; rspec?: true; minitest?: true; rake: boolean };

/** Ruby: a folder with a Gemfile or a `*.gemspec` is one package, named by its gemspec. A package
 * depends on the in-repository gem a Gemfile `path:` (or `path "dir" do` block) or `gemspec path:`
 * points at, and on any in-repository gem its Gemfile or gemspec names. A path with no package Forge
 * read, or a Gemfile that evaluates another file (`eval_gemfile`), marks it unresolved. Tests:
 * `spec/**\/*_spec.rb` runs `bundle exec rspec`; `test/**\/test_*.rb` or `*_test.rb` runs `bundle exec
 * rake test` beside a Rakefile, and has no command without one (the selection is then full). */
export function bundlerGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(
    path => (basename(path) === 'Gemfile' && !RUBY_SKIP.test(path)) || gemspecManifest(path),
  );
  if (!manifests.length) return null;
  const present = new Set(paths);
  const gems = new Map<string, Gem>();
  for (const manifest of manifests) {
    const text = read(manifest);
    if (text === undefined) return { ecosystem: 'bundler', refusal: `${manifest} is unreadable` };
    const dir = dirname(manifest);
    const gem = gems.get(dir) ?? {
      pkg: {
        ecosystem: 'bundler' as const,
        dir,
        name: dir ? basename(dir) : '.',
        manifest,
        dependsOn: [],
        testable: false,
        declared: false,
      },
      texts: [],
      rake: present.has(at(dir, 'Rakefile')),
    };
    const code = ruby(text);
    if (manifest.endsWith('.gemspec')) {
      gem.pkg.name = /\.name\s*=\s*["']([^"']+)["']/.exec(code)?.[1] ?? basename(manifest).slice(0, -8);
      gem.pkg.manifest = manifest;
    }
    gem.texts.push(code);
    gems.set(dir, gem);
  }
  const packages = [...gems.values()].map(gem => gem.pkg);
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  for (const path of paths) {
    if (RUBY_SKIP.test(path) || !path.endsWith('.rb')) continue;
    const owner = ownerOf(packages, path);
    if (!owner) continue;
    const rest = path.slice(owner.dir ? owner.dir.length + 1 : 0);
    if (/^spec\/(?:.*\/)?[^/]+_spec\.rb$/.test(rest)) gems.get(owner.dir)!.rspec = true;
    else if (/^test\/(?:.*\/)?(?:test_[^/]*|[^/]+_test)\.rb$/.test(rest))
      gems.get(owner.dir)!.minitest = true;
  }
  for (const gem of gems.values()) {
    const { pkg } = gem;
    const edges = new Set<string>();
    const to = (target: GraphPackage | undefined) =>
      target && target !== pkg && edges.add(packageKey(target));
    for (const code of gem.texts) {
      if (/^\s*(?:eval_gemfile|instance_eval)\b/m.test(code))
        pkg.unresolved ??= `${pkg.manifest} evaluates another file, which Forge does not read`;
      for (const [, word, rest] of code.matchAll(
        /^\s*(?:\w+\.)?(gem|gemspec|path|add_(?:runtime_|development_)?dependency)\b[ \t(]*([^\n]*)/gm,
      )) {
        const name = /^["']([^"']+)["']/.exec(rest!)?.[1];
        const option = /(?:\bpath:|:path\s*=>)\s*["']([^"']+)["']/.exec(rest!)?.[1];
        const where = word === 'path' ? name : option;
        if (word !== 'gemspec' && word !== 'path') to(name === undefined ? undefined : byName.get(name));
        if (where === undefined) continue;
        const local = joinPath(pkg.dir, where);
        if (local === null) continue;
        // A path source serves the gemspecs in its folder and the folders below it.
        const served = packages.filter(other => other.dir === local || within(local, other.dir));
        if (word === 'path') served.forEach(to);
        else to(served.find(other => other.dir === local));
        if (!served.length)
          pkg.unresolved ??= `${pkg.manifest} takes a gem from ${local || '.'}, which has no Gemfile or gemspec Forge read`;
      }
    }
    pkg.dependsOn = [...edges].sort();
    pkg.testable = !!gem.rspec || (!!gem.minitest && gem.rake);
    if (gem.minitest && !gem.rake) pkg.hiddenTests = at(pkg.dir, 'test');
  }
  return {
    ecosystem: 'bundler',
    // The root's command tests the root's own tests only, so a root reached as a dependent is one
    // more package.
    rootScoped: true,
    packages,
    commands: selected =>
      [...selected]
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .flatMap(pkg => {
          const gem = gems.get(pkg.dir)!;
          const run = (argv: string[]): PackageCommand => ({
            ecosystem: 'bundler',
            cwd: pkg.dir,
            argv,
            packages: [packageKey(pkg)],
          });
          return [
            ...(gem.rspec ? [run(['bundle', 'exec', 'rspec'])] : []),
            ...(gem.minitest && gem.rake ? [run(['bundle', 'exec', 'rake', 'test'])] : []),
          ];
        }),
  };
}

const PHPUNIT_CONFIGS = ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** PHP: every composer.json is a package, named by its `name`. A package depends on the
 * in-repository packages its `require` or `require-dev` names; a `path` repository whose folder has
 * no composer.json Forge read marks it unresolved. A package with a PHPUnit configuration runs
 * `vendor/bin/phpunit` (a Pest one, `tests/Pest.php`, `vendor/bin/pest`) where its dependencies are
 * installed: its own folder when it has a lockfile or nothing above it does, else from the nearest
 * enclosing package with one, with `--configuration`. `*Test.php` files and no runner: no command. */
export function composerGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(path => basename(path) === 'composer.json' && !PHP_SKIP.test(path));
  if (!manifests.length) return null;
  const present = new Set(paths);
  const found: { pkg: GraphPackage; json: Record<string, unknown> }[] = [];
  for (const manifest of manifests) {
    const text = read(manifest);
    let json: unknown;
    try {
      json = text === undefined ? undefined : JSON.parse(text);
    } catch {
      /* Reported below. */
    }
    if (!record(json)) return { ecosystem: 'composer', refusal: `${manifest} is not a JSON object` };
    const dir = dirname(manifest);
    found.push({
      pkg: {
        ecosystem: 'composer',
        dir,
        name: typeof json.name === 'string' ? json.name.toLowerCase() : dir || '.',
        manifest,
        dependsOn: [],
        testable: false,
        declared: false,
      },
      json,
    });
  }
  const packages = found.map(item => item.pkg);
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const locked = (dir: string) => [...COMPOSER_LOCKS].some(lock => present.has(at(dir, lock)));
  const runners = new Map<string, { cwd: string; argv: string[] }>();
  for (const { pkg, json } of found) {
    const edges = new Set<string>();
    for (const table of ['require', 'require-dev'])
      for (const name of Object.keys(record(json[table]) ? (json[table] as object) : {})) {
        const target = byName.get(name.toLowerCase());
        if (target && target !== pkg) edges.add(packageKey(target));
      }
    const repositories = Array.isArray(json.repositories)
      ? json.repositories
      : record(json.repositories)
        ? Object.values(json.repositories)
        : [];
    for (const repository of repositories) {
      if (!record(repository) || repository.type !== 'path' || typeof repository.url !== 'string') continue;
      const local = joinPath(pkg.dir, repository.url.replace(/\/$/, ''));
      if (local === null) continue;
      const pattern = globRegExp(local);
      if (!packages.some(other => pattern.test(other.dir)))
        pkg.unresolved ??= `${pkg.manifest} has a path repository ${repository.url}, which has no composer.json Forge read`;
    }
    pkg.dependsOn = [...edges].sort();
    const config = PHPUNIT_CONFIGS.find(file => present.has(at(pkg.dir, file)));
    const pest = present.has(at(pkg.dir, 'tests/Pest.php'));
    if (!config && !pest) continue;
    const home = locked(pkg.dir)
      ? pkg.dir
      : packages
          .filter(other => other !== pkg && within(other.dir, pkg.dir) && locked(other.dir))
          .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir;
    if (home === undefined || home === pkg.dir)
      runners.set(pkg.dir, { cwd: pkg.dir, argv: [pest ? 'vendor/bin/pest' : 'vendor/bin/phpunit'] });
    // Pest has no option to run another folder's configuration: no command, so the selection is full.
    else if (!pest)
      runners.set(pkg.dir, {
        cwd: home,
        argv: [
          'vendor/bin/phpunit',
          `--configuration=${at(pkg.dir.slice(home ? home.length + 1 : 0), config!)}`,
        ],
      });
    if (runners.has(pkg.dir)) pkg.testable = true;
  }
  for (const path of paths) {
    if (PHP_SKIP.test(path) || !/Test\.php$/.test(path)) continue;
    const owner = ownerOf(packages, path);
    if (owner && !owner.testable) owner.hiddenTests ??= path;
  }
  return {
    ecosystem: 'composer',
    // The root's command tests the root's own tests only, so a root reached as a dependent is one
    // more package.
    rootScoped: true,
    packages,
    commands: selected =>
      [...selected]
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .map(pkg => ({
          ecosystem: 'composer' as const,
          ...runners.get(pkg.dir)!,
          packages: [packageKey(pkg)],
        })),
  };
}
