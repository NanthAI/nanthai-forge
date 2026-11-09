// SPDX-License-Identifier: Apache-2.0
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

const join = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);

/** Plugins Gradle and the Kotlin/Android toolchains ship: they add no repository project edges. */
const CORE_PLUGIN =
  /^(?:java(?:-library|-platform|-gradle-plugin|-test-fixtures)?|application|groovy|scala|antlr|base|distribution|war|ear|idea|eclipse|jacoco|checkstyle|pmd|codenarc|signing|(?:maven|ivy)-publish|version-catalog|jvm-test-suite|(?:test|jacoco)-report-aggregation|project-report|build-dashboard|kotlin-dsl|(?:org\.gradle|org\.jetbrains\.kotlin|com\.android)\..+)$/;
/** Plugin ids a build file applies (`id("…")`, `id '…'`, `apply plugin: '…'`); version-catalog aliases
 * and `kotlin("…")` name published plugins. */
const appliedPlugins = (source: string) => [
  ...[...source.matchAll(/\bid\s*\(?\s*["']([^"'$]+)["']/g)].map(match => match[1]!),
  ...[...source.matchAll(/\bapply\s*\(?\s*plugin\s*[:=]\s*["']([^"'$]+)["']/g)].map(match => match[1]!),
];
/** A script plugin a build file applies from the repository (`apply from: 'gradle/x.gradle'`). */
const appliedScript = (source: string) =>
  [...source.matchAll(/\bapply\s*\(?\s*from\s*[:=]\s*["']?([^"')\s]+)/g)]
    .map(match => match[1]!)
    .find(path => !/^https?:/.test(path));
/** The project folder of a test source path (`DIR/src/test…/`). */
const TEST_SOURCE = /^(?:(.*)\/)?src\/(?:test|androidTest|integrationTest)\w*\//;
/** A build file that applies the Kotlin Multiplatform plugin (`kotlin("multiplatform")`, its id or a
 * catalog alias), not only declares it (`apply false`). */
const multiplatform = (source: string) =>
  source.split('\n').some(line => /multiplatform/i.test(line) && !/\bapply\s*\(?\s*false\b/.test(line));
/** A project's source set folders (`DIR/src/NAME/`). */
const SOURCE_SET = /^(?:(.*)\/)?src\/([A-Za-z]\w*)\//;
/** Source sets `:p:test` covers: `test` and its variants (Android `testDebug`), fixtures, and Android
 * instrumented tests (`androidTest`, which need a device and run under no test task). */
const PLAIN_TEST = /^(?:test|androidTest|testFixtures)\w*$/;
const quoted = (text: string) => [...text.matchAll(/["']([^"'$]+)["']/g)].map(match => match[1]!);

type GradleBuild = {
  dir: string;
  settings: string;
  text: string;
  projects: Map<string, GraphPackage>;
  root: GraphPackage | null;
  includes: string[];
};

/** One Gradle build from its settings file, or why Forge cannot read it. Its `include` lists the
 * projects (`:a:b` lives in `DIR/a/b`); a build in a subfolder is also a package itself (`root`), so a
 * change to its own build files selects every project of that build. */
function gradleBuild(settings: string, present: Set<string>, read: ManifestReader): GradleBuild | string {
  const dir = dirname(settings);
  const text = uncomment(read(settings) ?? '');
  if (/\bprojectDir\b|\bincludeFlat\b|\brootProject\.children\b/.test(text))
    return `${settings} moves project folders (projectDir/includeFlat)`;
  const projects = new Map<string, GraphPackage>();
  for (const statement of text.matchAll(/\binclude\b\s*(?:\(([^)]*)\)|([^\n]*))/g))
    for (const name of quoted(statement[1] ?? statement[2]!)) {
      const path = name.startsWith(':') ? name : `:${name}`;
      const folder = join(dir, path.split(':').filter(Boolean).join('/'));
      const build = GRADLE_BUILD.map(file => `${folder}/${file}`).find(file => present.has(file));
      projects.set(path, {
        ecosystem: 'gradle',
        dir: folder,
        name: path,
        manifest: build ?? settings,
        dependsOn: [],
        testable: !!build,
        declared: true,
      });
    }
  if (/\binclude\b[^\n]*\$/.test(text)) return `${settings} computes project names`;
  const includes: string[] = [];
  for (const statement of text.matchAll(/\bincludeBuild\b\s*\(?([^)\n]*)/g)) {
    if (statement[1]!.includes('$') || !quoted(statement[1]!).length)
      return `${settings} computes an included build path`;
    const target = joinPath(dir, quoted(statement[1]!)[0]!);
    if (target === null) return `${settings} includes a build outside the repository`;
    includes.push(target);
  }
  const build = GRADLE_BUILD.map(file => join(dir, file)).find(file => present.has(file));
  const named = /\brootProject\.name\s*=\s*["']([^"'$]+)["']/.exec(text)?.[1];
  // The repository root is never a package of a multi-project build: a root file runs everything.
  const root =
    dir || !projects.size
      ? {
          ecosystem: 'gradle' as const,
          dir,
          name: named ?? (dir || 'root project'),
          manifest: build ?? settings,
          dependsOn: [],
          testable: !projects.size && !!build,
          declared: false,
        }
      : null;
  return { dir, settings, text, projects, root, includes };
}

/** Gradle: every settings.gradle(.kts) outside build/, src/ and buildSrc/ is the root of its own build
 * (a subfolder `android/` build included). A project depends on every `project(":x")` or `projects.x`
 * accessor its build file names, on any project its build's root build file names, on its build's
 * own folder, and on every package of a build its settings `includeBuild`. Edges Forge does not read
 * mark a project unresolved: a script it applies from the repository (`apply from:`), or a plugin
 * that is not a Gradle/Kotlin/Android one while the build has its own plugin sources (buildSrc/ or
 * an included build, where convention plugins add project dependencies); the root build file's
 * `subprojects`/`allprojects` blocks count for every project. A project with test sources but no
 * build file of its own is configured from elsewhere (hidden tests). Anything that moves a
 * project folder (`projectDir`, `includeFlat`) or a settings file Forge cannot read makes the layout
 * unknown. Tests run in the build's folder as `./gradlew :a:test` (or `gradle` without the wrapper);
 * a single-project build runs `test`. A Kotlin Multiplatform project runs `:a:allTests`; a project
 * with another test source set (`src/integrationTest`) that `test` does not run has no command. */
export function gradleGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const present = new Set(paths);
  const settingsFiles = new Map<string, string>();
  for (const settings of GRADLE_SETTINGS.flatMap(name => paths.filter(path => basename(path) === name)))
    if (jvmManifest(settings) && basename(dirname(settings)) !== 'buildSrc')
      if (!settingsFiles.has(dirname(settings))) settingsFiles.set(dirname(settings), settings);
  if (!settingsFiles.size) {
    const orphan = paths.find(path => GRADLE_BUILD.includes(basename(path)) && jvmManifest(path));
    return orphan
      ? { ecosystem: 'gradle', unplaced: `${orphan} has no settings.gradle(.kts) in its folder` }
      : null;
  }
  const builds: GradleBuild[] = [];
  for (const settings of [...settingsFiles.values()].sort()) {
    const build = gradleBuild(settings, present, read);
    if (typeof build === 'string') return { ecosystem: 'gradle', refusal: build };
    builds.push(build);
  }
  const owner = new Map<string, GradleBuild>();
  for (const build of builds)
    for (const pkg of [...(build.root ? [build.root] : []), ...build.projects.values()]) {
      if (owner.has(pkg.dir))
        return {
          ecosystem: 'gradle',
          refusal: `${pkg.dir} is a project of two Gradle builds (${build.settings})`,
        };
      owner.set(pkg.dir, build);
    }
  const byDir = new Map(builds.map(build => [build.dir, build]));
  let tests: Map<string, string> | undefined;
  const testSources = () => {
    if (!tests) {
      tests = new Map();
      for (const path of paths) {
        const match = TEST_SOURCE.exec(path);
        if (match && !tests.has(match[1] ?? '')) tests.set(match[1] ?? '', path);
      }
    }
    return tests;
  };
  let sets: Map<string, Set<string>> | undefined;
  const sourceSets = (dir: string) => {
    if (!sets) {
      sets = new Map();
      for (const path of paths) {
        const match = SOURCE_SET.exec(path);
        if (match) sets.set(match[1] ?? '', (sets.get(match[1] ?? '') ?? new Set()).add(match[2]!));
      }
    }
    return sets.get(dir) ?? new Set<string>();
  };
  /** The task that runs one project's tests: `allTests` for Kotlin Multiplatform, `test` otherwise;
   * null when the project has test sources `test` does not run and Forge cannot name their task.
   * With only Gradle/Kotlin/Android plugins the build file says it all (Multiplatform applied, or a
   * test suite it names); a plugin from elsewhere may apply either, so the folders decide: a
   * `commonMain`/`commonTest` source set is Multiplatform, another test source set is unnamed. */
  const wholeTasks = new Map<string, string | null>();
  const wholeTask = (pkg: GraphPackage, source: string) => {
    if (multiplatform(source)) return 'allTests';
    const own = sourceSets(pkg.dir);
    const extra = [...own].filter(name => /Test$/.test(name) && !PLAIN_TEST.test(name));
    if (appliedPlugins(source).every(id => CORE_PLUGIN.test(id)))
      return extra.some(name => new RegExp(`\\b${name}\\b`).test(source)) ? null : 'test';
    if (own.has('commonMain') || own.has('commonTest')) return 'allTests';
    return extra.length ? null : 'test';
  };
  const all = (build: GradleBuild) => [...(build.root ? [build.root] : []), ...build.projects.values()];
  for (const build of builds) {
    const references = (source: string) => {
      const found = new Set<string>();
      for (const match of source.matchAll(/\bproject\s*\(\s*(?:path\s*[:=]\s*)?["'](:[^"']*)["']/g))
        found.add(match[1]!);
      for (const [path] of build.projects) if (source.includes(accessor(path))) found.add(path);
      return found;
    };
    const rootBuild = GRADLE_BUILD.map(file => join(build.dir, file)).find(file => present.has(file));
    const rootText = rootBuild ? uncomment(read(rootBuild) ?? '') : '';
    const shared = references(rootText);
    const included = build.includes.flatMap(dir => (byDir.get(dir) ? all(byDir.get(dir)!) : []));
    const pluginSources =
      build.includes.length > 0 || paths.some(path => path.startsWith(join(build.dir, 'buildSrc/')));
    /** Why a build file may add project edges Forge does not read. */
    const hidden = (file: string, source: string) => {
      const script = appliedScript(source);
      if (script) return `${file} applies ${script}, which Forge does not read`;
      const plugin = pluginSources && appliedPlugins(source).find(id => !CORE_PLUGIN.test(id));
      return plugin
        ? `${file} applies plugin ${plugin}, which may come from the build's own plugin sources (buildSrc/ or includeBuild) that Forge does not read`
        : undefined;
    };
    const everywhere =
      rootBuild && /\b(?:subprojects|allprojects)\b/.test(rootText) ? hidden(rootBuild, rootText) : undefined;
    for (const pkg of build.projects.values()) {
      const source = pkg.manifest === build.settings ? '' : uncomment(read(pkg.manifest) ?? '');
      const unresolved = everywhere ?? (source ? hidden(pkg.manifest, source) : undefined);
      wholeTasks.set(pkg.dir, wholeTask(pkg, source));
      if (unresolved) pkg.unresolved = unresolved;
      const test = pkg.testable ? undefined : testSources().get(pkg.dir);
      if (test) pkg.hiddenTests = test;
      if (
        /\bprojects\.[A-Za-z]/.test(source) &&
        ![...build.projects.keys()].some(path => source.includes(accessor(path)))
      )
        return {
          ecosystem: 'gradle',
          refusal: `${pkg.manifest} names a project accessor Forge cannot resolve`,
        };
      pkg.dependsOn = [
        ...new Set([
          ...[...references(source), ...shared]
            .filter(path => path !== pkg.name && build.projects.has(path))
            .map(path => packageKey(build.projects.get(path)!)),
          ...(build.root ? [packageKey(build.root)] : []),
          ...included.map(packageKey),
        ]),
      ].sort();
    }
    if (build.root) {
      build.root.dependsOn = [...new Set(included.map(packageKey))].sort();
      wholeTasks.set(build.root.dir, wholeTask(build.root, rootText));
    }
  }
  return {
    ecosystem: 'gradle',
    packages: builds.flatMap(all),
    commands(selected, _changed, narrowed) {
      const groups = new Map<GradleBuild, GraphPackage[]>();
      const tool = (build: GradleBuild) => (present.has(join(build.dir, 'gradlew')) ? './gradlew' : 'gradle');
      const task = (build: GradleBuild, pkg: GraphPackage, name: string) =>
        pkg.dir === build.root?.dir ? name : `${pkg.name}:${name}`;
      const unnamed = selected.find(
        pkg => !narrowed?.has(packageKey(pkg)) && wholeTasks.get(pkg.dir) === null,
      );
      if (unnamed)
        return {
          refusal: `${unnamed.name} has test source sets ${[...sourceSets(unnamed.dir)].filter(name => /Test$/.test(name)).join(', ')} that its test task does not run, and Forge cannot name the task that does`,
        };
      // A narrowed project (src/module-selection.ts) runs only the test classes that reach the change.
      const targeted: PackageCommand[] = [];
      for (const pkg of selected) {
        const build = owner.get(pkg.dir)!;
        const classes = narrowed?.get(packageKey(pkg));
        if (classes) {
          // `TASK:Class` units belong to a Kotlin Multiplatform target's test task; `--tests` filters
          // the task it follows.
          const byTask = new Map<string, string[]>();
          for (const unit of classes) {
            const at = unit.indexOf(':');
            const name = at < 0 ? 'test' : unit.slice(0, at);
            byTask.set(name, [...(byTask.get(name) ?? []), unit.slice(at + 1)]);
          }
          targeted.push({
            ecosystem: 'gradle',
            cwd: build.dir,
            argv: [
              tool(build),
              ...[...byTask]
                .sort(([a], [b]) => a.localeCompare(b))
                .flatMap(([name, list]) => [
                  task(build, pkg, name),
                  ...list.flatMap(item => ['--tests', item]),
                ]),
            ],
            packages: [packageKey(pkg)],
          });
        } else groups.set(build, [...(groups.get(build) ?? []), pkg]);
      }
      return [
        ...[...groups]
          .sort(([a], [b]) => a.dir.localeCompare(b.dir))
          .map(([build, pkgs]) => ({
            ecosystem: 'gradle' as const,
            cwd: build.dir,
            argv: [
              tool(build),
              ...pkgs.map(pkg => task(build, pkg, wholeTasks.get(pkg.dir) ?? 'test')).sort(),
            ],
            packages: pkgs.map(packageKey),
          })),
        ...targeted,
      ];
    },
  };
}

/** The first `<tag>` of `xml` outside the named nested blocks. */
function tag(xml: string, name: string) {
  return new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1];
}
const outside = (xml: string, blocks: string[]) =>
  blocks.reduce((text, block) => text.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`, 'g'), ''), xml);

/** `to` relative to `from` (both repository folders), `../x` for a sibling. */
function relative(from: string, to: string) {
  const a = from ? from.split('/') : [];
  const b = to ? to.split('/') : [];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return [...a.slice(same).map(() => '..'), ...b.slice(same)].join('/') || '.';
}
const modulesOf = (xml: string) =>
  [
    ...(/<modules>([\s\S]*?)<\/modules>/.exec(xml)?.[1] ?? '').matchAll(/<module>\s*([^<]+?)\s*<\/module>/g),
  ].map(module => module[1]!.replace(/\/pom\.xml$/, ''));
const moduleList = (xml: string) => modulesOf(outside(xml, ['profiles']));
/** Modules a `<profile>` adds to the reactor, with the profile id. */
const profileModules = (xml: string) =>
  [
    ...(/<profiles>([\s\S]*?)<\/profiles>/.exec(xml)?.[1] ?? '').matchAll(/<profile>([\s\S]*?)<\/profile>/g),
  ].flatMap(profile => {
    const id = tag(outside(profile[1]!, ['modules', 'build', 'dependencies', 'activation']), 'id') ?? '?';
    return modulesOf(profile[1]!).map(module => ({ module, id }));
  });

/** Maven: every pom.xml that no other pom lists as a module is the root of its own build (a
 * subfolder `server/` build included), and its `<modules>` (recursively) are the projects, those a
 * `<profile>` adds included (the default build leaves them out, so selecting one runs full). A module
 * depends on modules named by its `<dependency>` and `<parent>` coordinates. Tests run in the build's
 * folder as `mvn -pl a,b -am test` (also making the modules they need, with `./mvnw` when the wrapper
 * is present), or `mvn test` when the build's own root pom is selected. */
export function mavenGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const poms = paths.filter(path => basename(path) === 'pom.xml' && jvmManifest(path));
  if (!poms.length) return null;
  const present = new Set(paths);
  const texts = new Map<string, string>();
  const listed = new Set<string>();
  for (const pom of poms) {
    const raw = read(pom);
    if (raw === undefined) return { ecosystem: 'maven', refusal: `${pom} is unreadable` };
    const xml = raw.replace(/<!--[\s\S]*?-->/g, '');
    texts.set(pom, xml);
    for (const module of [...moduleList(xml), ...profileModules(xml).map(item => item.module)]) {
      const child = joinPath(dirname(pom), module);
      if (child !== null && child !== dirname(pom)) listed.add(child);
    }
  }
  type Module = { pkg: GraphPackage; xml: string; group?: string; build: string };
  const modules = new Map<string, Module>();
  /** Modules only a profile adds, with the profile id. */
  const profileOnly = new Map<string, string>();
  const visit = (dir: string, declared: boolean, build: string, profile?: string): string | null => {
    const manifest = dir ? `${dir}/pom.xml` : 'pom.xml';
    const xml = texts.get(manifest);
    if (xml === undefined) return `${manifest} is unreadable`;
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
      build,
      ...(group ? { group } : {}),
    });
    if (profile) profileOnly.set(dir, profile);
    const children = [
      ...moduleList(xml).map(module => ({ module, id: profile })),
      ...profileModules(xml).map(item => ({ module: item.module, id: profile ?? item.id })),
    ];
    for (const { module, id } of children) {
      const child = joinPath(dir, module);
      if (child === null) return `${manifest} names a module outside the repository`;
      if (!present.has(child ? `${child}/pom.xml` : 'pom.xml'))
        return `${manifest} names missing module ${child}`;
      if (!modules.has(child)) {
        const failed = visit(child, true, build, id);
        if (failed) return failed;
      }
    }
    return null;
  };
  for (const root of poms.map(dirname).filter(dir => !listed.has(dir))) {
    if (modules.has(root)) continue;
    const failed = visit(root, false, root);
    if (failed) return { ecosystem: 'maven', refusal: failed };
  }
  const byArtifact = new Map<string, Module[]>();
  for (const item of modules.values())
    byArtifact.set(item.pkg.name, [...(byArtifact.get(item.pkg.name) ?? []), item]);
  for (const item of modules.values()) {
    const edges = new Set<string>();
    const blocks = [...item.xml.matchAll(/<(?:dependency|parent)>([\s\S]*?)<\/(?:dependency|parent)>/g)];
    for (const block of blocks) {
      const group = tag(block[1]!, 'groupId');
      for (const target of byArtifact.get(tag(block[1]!, 'artifactId') ?? '') ?? [])
        // An unresolved `${…}` group may still name the module: over-select, never miss it.
        if (target !== item && (!group || group.includes('${') || !target.group || group === target.group))
          edges.add(packageKey(target.pkg));
    }
    item.pkg.dependsOn = [...edges].sort();
  }
  return {
    ecosystem: 'maven',
    packages: [...modules.values()].map(item => item.pkg),
    commands(selected, _changed, narrowed) {
      const groups = new Map<string, GraphPackage[]>();
      const targeted: PackageCommand[] = [];
      const mvn = (build: string) => (present.has(build ? `${build}/mvnw` : 'mvnw') ? './mvnw' : 'mvn');
      const optional = selected.find(pkg => profileOnly.has(pkg.dir));
      if (optional)
        return {
          refusal: `${optional.manifest} is a module only profile ${profileOnly.get(optional.dir)} adds; the default build leaves it out`,
        };
      for (const pkg of selected) {
        const build = modules.get(pkg.dir)!.build;
        // A narrowed module (src/module-selection.ts) runs only the test classes that reach the change;
        // modules built with it (-am) have none of them, which Surefire must not treat as a failure.
        const classes = narrowed?.get(packageKey(pkg));
        // `TASK:Class` units name a Gradle target task Maven has no equivalent for: the module runs whole.
        if (classes && !classes.some(unit => unit.includes(':')))
          targeted.push({
            ecosystem: 'maven',
            cwd: build,
            argv: [
              mvn(build),
              ...(pkg.dir === build ? [] : ['-pl', relative(build, pkg.dir), '-am']),
              'test',
              `-Dtest=${classes.join(',')}`,
              '-Dsurefire.failIfNoSpecifiedTests=false',
            ],
            packages: [packageKey(pkg)],
          });
        else groups.set(build, [...(groups.get(build) ?? []), pkg]);
      }
      return [
        ...[...groups].sort().map(([build, pkgs]) => ({
          ecosystem: 'maven' as const,
          cwd: build,
          argv: [
            mvn(build),
            ...(pkgs.some(pkg => pkg.dir === build)
              ? ['test']
              : [
                  '-pl',
                  pkgs
                    .map(pkg => relative(build, pkg.dir))
                    .sort()
                    .join(','),
                  '-am',
                  'test',
                ]),
          ],
          packages: pkgs.map(packageKey),
        })),
        ...targeted,
      ];
    },
  };
}
