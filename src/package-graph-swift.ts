// SPDX-License-Identifier: Apache-2.0
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
} from './package-graph-types.js';
import { nonSourceDirPattern } from './ecosystems.js';

/** The registry's folders of other people's packages and build output, and dot folders: never this
 * repository's packages. */
const OUTSIDE = nonSourceDirPattern();
const uncomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Swift Package Manager: every Package.swift is a package. Package.swift is Swift code that SwiftPM
 * compiles and runs, so Forge never evaluates it: it reads the literal `.package(path: "…")` local
 * dependencies (an edge to the package there, or unresolved when Forge read none there, or when the
 * path is computed) and whether a `.testTarget(` is declared. A package with test targets runs
 * `swift test` in its folder; a package with test sources under `Tests/` and no test target is
 * tested some other way (hidden tests). A plugin (`.plugin(`) or a package that applies one
 * (`plugins:`) is repository code that runs at build time: it adds no edge, and the check runs it
 * under the check environment like any build script. */
export function swiftpmGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(path => basename(path) === 'Package.swift' && !OUTSIDE.test(path));
  if (!manifests.length) return null;
  const packages = new Map<string, { pkg: GraphPackage; locals: string[] }>();
  for (const manifest of manifests) {
    const text = read(manifest);
    if (text === undefined) return { ecosystem: 'swiftpm', refusal: `${manifest} is unreadable` };
    const source = uncomment(text);
    const dir = dirname(manifest);
    const pkg: GraphPackage = {
      ecosystem: 'swiftpm',
      dir,
      name: /\bPackage\s*\(\s*name\s*:\s*"([^"\\]+)"/.exec(source)?.[1] ?? (dir || 'Package.swift'),
      manifest,
      dependsOn: [],
      testable: /\.testTarget\s*\(/.test(source),
      declared: false,
    };
    const locals: string[] = [];
    for (const call of source.matchAll(/\.package\s*\(([^()]*)\)/g)) {
      const path = /\bpath\s*:\s*("(?:[^"\\]|\\.)*"|[^,)\s]+)/.exec(call[1]!)?.[1];
      if (path === undefined) continue;
      if (!/^"[^"\\]*"$/.test(path)) {
        pkg.unresolved ??= `${manifest} computes a local package path`;
        continue;
      }
      const target = joinPath(dir, path.slice(1, -1));
      if (target !== null) locals.push(target);
    }
    packages.set(dir, { pkg, locals });
  }
  for (const { pkg, locals } of packages.values()) {
    for (const dir of locals) {
      const there = packages.get(dir);
      if (there) pkg.dependsOn.push(packageKey(there.pkg));
      else
        pkg.unresolved ??= `${pkg.manifest} uses the local package ${dir || '.'}, which has no Package.swift Forge read`;
    }
    pkg.dependsOn = [...new Set(pkg.dependsOn)].filter(key => key !== packageKey(pkg)).sort();
  }
  const owner = (path: string) =>
    [...packages.values()]
      .map(item => item.pkg)
      .filter(pkg => !pkg.dir || path.startsWith(`${pkg.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  for (const path of paths) {
    if (!/(?:^|\/)Tests\/.+\.swift$/.test(path) || OUTSIDE.test(path)) continue;
    const pkg = owner(path);
    if (pkg && !pkg.testable) pkg.hiddenTests ??= path;
  }
  return {
    ecosystem: 'swiftpm',
    packages: [...packages.values()].map(item => item.pkg),
    commands: selected =>
      selected
        .map(pkg => ({
          ecosystem: 'swiftpm' as const,
          cwd: pkg.dir,
          argv: ['swift', 'test'],
          packages: [packageKey(pkg)],
        }))
        .sort((a, b) => a.cwd.localeCompare(b.cwd)),
  };
}

/** An Xcode project or workspace container: `DIR/NAME.xcodeproj/…` or `DIR/NAME.xcworkspace/…`. */
const CONTAINER = /^(?:(.*)\/)?([^/]+\.xc(?:odeproj|workspace))\/(.+)$/;
/** A shared scheme of a container (`xcshareddata/xcschemes/NAME.xcscheme`). */
const SCHEME = /^xcshareddata\/xcschemes\/([^/]+)\.xcscheme$/;

/** Xcode: each folder with an `.xcodeproj` (outside Pods/ and DerivedData/) is a package, read from
 * paths alone (project.pbxproj is not read). `xcodebuild test` needs a scheme and, for iOS, tvOS,
 * watchOS and visionOS, a simulator destination that only the repository knows, so an Xcode package
 * has no default command: selecting it makes the selection full and names the `preflight.tests`
 * declaration that gives Forge the command (run on a macOS runner the check declares). An Xcode
 * project can take any local Swift package of the repository (`XCLocalSwiftPackageReference` lives
 * in project.pbxproj), so it depends on every SwiftPM package. */
export function xcodeGraph(paths: string[]): EcosystemResult {
  const containers = new Map<string, { names: Set<string>; schemes: Set<string> }>();
  for (const path of paths) {
    const match = CONTAINER.exec(path);
    if (
      !match ||
      OUTSIDE.test(path) ||
      match[1]?.split('/').some(part => /\.xc(?:odeproj|workspace)$/.test(part))
    )
      continue;
    // A workspace inside a project (`App.xcodeproj/project.xcworkspace`) is that project's own.
    const dir = match[1] ?? '';
    const entry = containers.get(dir) ?? { names: new Set<string>(), schemes: new Set<string>() };
    entry.names.add(match[2]!);
    const scheme = SCHEME.exec(match[3]!)?.[1];
    if (scheme) entry.schemes.add(scheme);
    containers.set(dir, entry);
  }
  const projects = [...containers].filter(([, entry]) =>
    [...entry.names].some(name => name.endsWith('.xcodeproj')),
  );
  if (!projects.length) return null;
  const swiftpm = paths
    .filter(path => basename(path) === 'Package.swift' && !OUTSIDE.test(path))
    .map(path => `swiftpm:${dirname(path)}`);
  const containersOf = new Map(projects);
  return {
    ecosystem: 'xcode',
    packages: projects.map(([dir, entry]) => ({
      ecosystem: 'xcode',
      dir,
      name: [...entry.names].sort()[0]!,
      manifest: `${dir ? `${dir}/` : ''}${[...entry.names].sort()[0]!}`,
      dependsOn: [...swiftpm].sort(),
      testable: true,
      declared: false,
    })),
    commands(selected) {
      const pkg = selected[0]!;
      const entry = containersOf.get(pkg.dir)!;
      const container =
        [...entry.names].find(name => name.endsWith('.xcworkspace')) ?? [...entry.names].sort()[0]!;
      const scheme = entry.schemes.size === 1 ? [...entry.schemes][0]! : 'SCHEME';
      const flag = container.endsWith('.xcworkspace') ? '-workspace' : '-project';
      return {
        refusal:
          `xcodebuild test in ${pkg.dir || '.'} needs a scheme and a destination Forge cannot read; declare ` +
          `preflight.tests in forge.json, for example {"glob":["**/*Tests.swift"],"command":["xcodebuild","test","${flag}","${container}","-scheme","${scheme}","-destination","platform=iOS Simulator,name=iPhone 16"]}`,
      };
    },
  };
}
