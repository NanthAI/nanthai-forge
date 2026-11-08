// SPDX-License-Identifier: Apache-2.0
import {
  basename,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
} from './package-graph-types.js';

const GRADLE_SETTINGS = ['settings.gradle', 'settings.gradle.kts'];
const GRADLE_BUILD = ['build.gradle', 'build.gradle.kts'];
export const jvmManifest = (path: string) =>
  [...GRADLE_SETTINGS, ...GRADLE_BUILD, 'pom.xml'].includes(basename(path)) &&
  !/(?:^|\/)(?:build|target|src)\//.test(path);

const uncomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** `:a:b-c` → `projects.a.bC`, the type-safe accessor Gradle generates for that project. */
const accessor = (path: string) =>
  `projects.${path
    .split(':')
    .filter(Boolean)
    .map(part => part.replace(/[-_]+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase()))
    .join('.')}`;

/** Gradle: the root settings file's `include` lists the projects (`:a:b` lives in `a/b`). A project
 * depends on every `project(":x")` or `projects.x` accessor its build file names; one the root build
 * file names is a dependency of every project. Anything that moves a project folder (`projectDir`,
 * `includeFlat`) or a settings file Forge cannot read makes the layout unknown. Tests run as
 * `./gradlew :a:test` (or `gradle` without the wrapper) for projects that have a build file. */
export function gradleGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const settings = GRADLE_SETTINGS.find(path => paths.includes(path));
  if (!settings) return null;
  const text = uncomment(read(settings) ?? '');
  if (/\bprojectDir\b|\bincludeFlat\b|\brootProject\.children\b/.test(text))
    return { ecosystem: 'gradle', refusal: `${settings} moves project folders (projectDir/includeFlat)` };
  const present = new Set(paths);
  const projects = new Map<string, GraphPackage>();
  for (const statement of text.matchAll(/\binclude\b\s*(?:\(([^)]*)\)|([^\n]*))/g))
    for (const quoted of (statement[1] ?? statement[2]!).matchAll(/["']([^"'$]+)["']/g)) {
      const path = quoted[1]!.startsWith(':') ? quoted[1]! : `:${quoted[1]}`;
      const dir = path.split(':').filter(Boolean).join('/');
      const build = GRADLE_BUILD.map(file => `${dir}/${file}`).find(file => present.has(file));
      projects.set(path, {
        ecosystem: 'gradle',
        dir,
        name: path,
        manifest: build ?? settings,
        dependsOn: [],
        testable: !!build,
        declared: true,
      });
    }
  if (/\binclude\b[^\n]*\$/.test(text))
    return { ecosystem: 'gradle', refusal: `${settings} computes project names` };
  if (!projects.size) return null;
  const references = (source: string) => {
    const found = new Set<string>();
    for (const match of source.matchAll(/\bproject\s*\(\s*(?:path\s*[:=]\s*)?["'](:[^"']*)["']/g))
      found.add(match[1]!);
    for (const [path] of projects) if (source.includes(accessor(path))) found.add(path);
    return found;
  };
  const rootBuild = GRADLE_BUILD.find(file => present.has(file));
  const shared = rootBuild ? references(uncomment(read(rootBuild) ?? '')) : new Set<string>();
  for (const pkg of projects.values()) {
    const source = pkg.manifest === settings ? '' : uncomment(read(pkg.manifest) ?? '');
    if (
      /\bprojects\.[A-Za-z]/.test(source) &&
      ![...projects.keys()].some(path => source.includes(accessor(path)))
    )
      return {
        ecosystem: 'gradle',
        refusal: `${pkg.manifest} names a project accessor Forge cannot resolve`,
      };
    pkg.dependsOn = [...new Set([...references(source), ...shared])]
      .filter(path => path !== pkg.name && projects.has(path))
      .map(path => packageKey(projects.get(path)!))
      .sort();
  }
  const gradle = present.has('gradlew') ? './gradlew' : 'gradle';
  return {
    ecosystem: 'gradle',
    packages: [...projects.values()],
    commands: selected => [
      {
        ecosystem: 'gradle',
        cwd: '',
        argv: [gradle, ...selected.map(pkg => `${pkg.name}:test`).sort()],
        packages: selected.map(packageKey),
      },
    ],
  };
}

/** The first `<tag>` of `xml` outside the named nested blocks. */
function tag(xml: string, name: string) {
  return new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1];
}
const outside = (xml: string, blocks: string[]) =>
  blocks.reduce((text, block) => text.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`, 'g'), ''), xml);

/** Maven: the root pom.xml's `<modules>` (recursively) are the projects. A module depends on modules
 * named by its `<dependency>` and `<parent>` coordinates. Tests run as `mvn -pl a,b -am test` (also
 * making the modules they need, with `./mvnw` when the wrapper is present). */
export function mavenGraph(paths: string[], read: ManifestReader): EcosystemResult {
  if (!paths.includes('pom.xml')) return null;
  const present = new Set(paths);
  const modules = new Map<string, { pkg: GraphPackage; xml: string; group?: string }>();
  const visit = (dir: string, declared: boolean): string | null => {
    const manifest = dir ? `${dir}/pom.xml` : 'pom.xml';
    const raw = read(manifest);
    if (raw === undefined) return `${manifest} is unreadable`;
    const xml = raw.replace(/<!--[\s\S]*?-->/g, '');
    const own = outside(xml, [
      'parent',
      'dependencies',
      'dependencyManagement',
      'build',
      'profiles',
      'plugins',
    ]);
    const artifact = tag(own, 'artifactId');
    if (!artifact) return `${manifest} has no artifactId`;
    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(xml)?.[1] ?? '';
    const group = tag(own, 'groupId') ?? tag(parent, 'groupId');
    modules.set(dir, {
      pkg: { ecosystem: 'maven', dir, name: artifact, manifest, dependsOn: [], testable: true, declared },
      xml,
      ...(group ? { group } : {}),
    });
    const list = /<modules>([\s\S]*?)<\/modules>/.exec(outside(xml, ['profiles']))?.[1] ?? '';
    for (const module of list.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const child = joinPath(dir, module[1]!.replace(/\/pom\.xml$/, ''));
      if (child === null) return `${manifest} names a module outside the repository`;
      if (!present.has(child ? `${child}/pom.xml` : 'pom.xml'))
        return `${manifest} names missing module ${child}`;
      if (!modules.has(child)) {
        const failed = visit(child, true);
        if (failed) return failed;
      }
    }
    return null;
  };
  const failed = visit('', false);
  if (failed) return { ecosystem: 'maven', refusal: failed };
  const byArtifact = new Map([...modules.values()].map(item => [item.pkg.name, item]));
  for (const item of modules.values()) {
    const edges = new Set<string>();
    const blocks = [...item.xml.matchAll(/<(?:dependency|parent)>([\s\S]*?)<\/(?:dependency|parent)>/g)];
    for (const block of blocks) {
      const target = byArtifact.get(tag(block[1]!, 'artifactId') ?? '');
      const group = tag(block[1]!, 'groupId');
      // An unresolved `${…}` group may still name the module: over-select, never miss it.
      if (
        target &&
        target !== item &&
        (!group || group.includes('${') || !target.group || group === target.group)
      )
        edges.add(packageKey(target.pkg));
    }
    item.pkg.dependsOn = [...edges].sort();
  }
  const mvn = present.has('mvnw') ? './mvnw' : 'mvn';
  return {
    ecosystem: 'maven',
    packages: [...modules.values()].map(item => item.pkg),
    commands: selected => [
      {
        ecosystem: 'maven',
        cwd: '',
        argv: [
          mvn,
          '-pl',
          selected
            .map(pkg => pkg.dir)
            .sort()
            .join(','),
          '-am',
          'test',
        ],
        packages: selected.map(packageKey),
      },
    ],
  };
}
