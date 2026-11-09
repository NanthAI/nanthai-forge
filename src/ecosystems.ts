// SPDX-License-Identifier: Apache-2.0
/** The one ecosystem registry (Issue 9c0ece48). Every list of ecosystem knowledge (lockfile and
 * manifest names, regenerable and dependency folders, code-file extensions, Actions cache presets,
 * check caches, the merge parse gate, the duplicate-import fix-up, the module graph) is read from
 * these entries; `tests/forge-only-rules.test.mjs` fails on such a list anywhere else. Adding an
 * ecosystem is one entry here plus one fixture repository (docs/agents/ecosystems.md).
 *
 * Pure data and pure derivations: no imports with runtime code, so Convex (V8) and every CLI path
 * can read it. Derived tables are built once at module load; lookups are in memory. */

/** Grammars of the merge parse gate (src/native-merge-syntax.ts and -other.ts load them lazily). */
export type MergeGrammar = 'typescript' | 'python' | 'java' | 'rust' | 'json';
/** Readers of the duplicate-import fix-up (src/native-import-merge.ts, src/native-import-languages.ts). */
export type ImportFixupLanguage = 'javascript' | 'python' | 'java' | 'rust' | 'go' | 'csharp';
/** Analysed languages of the code map and code graph (src/languages.ts). */
export type SourceLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'rust'
  | 'go'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'elixir'
  | 'swift'
  | 'kotlin'
  | 'dart';
/** Readers of the module graph (src/module-graph.ts). */
export type ModuleGraphLanguage = 'python' | 'go' | 'rust' | 'java' | 'kotlin';

/** A file-name extension gate: a regular-expression alternation without the dot (`pyi?`). */
type Extensions = string;

export type EcosystemManager = {
  /** Package manager or build tool (`npm`, `cargo`, `uv`). */
  name: string;
  /** Exact manifest file names the package graph reads (`go.mod`, `Cargo.toml`). Names with a
   * pattern (`*.csproj`, `requirements*.txt`) stay with their reader. */
  manifests?: readonly string[];
  /** Lockfile names that identify this manager and pin a check plan, at the root or in any folder
   * (src/project-lockfile.ts digests every one in the State). */
  lockfiles?: readonly string[];
  /** Lockfiles that pin a plan but do not identify the manager (`npm-shrinkwrap.json`). */
  pinOnly?: readonly string[];
  /** Files recognised as dependency state (preflight learning skips them) that are not lockfiles
   * and so pin no check plan (`vcpkg-configuration.json`). */
  unpinned?: readonly string[];
  /** How Forge installs this manager's dependencies (src/ecosystem-install.ts). `argv` runs no
   * dependency install script or plugin; `scriptFlags` are the words of `argv` that keep them off.
   * `manifestIsCode`: the manifest itself is a program (Gemfile, mix.exs), so any install runs
   * repository code and needs `installScripts` for everything. `runs` names what scripts would do.
   * `allowlisted`: the words of `scriptFlags` dropped when the manager's own allowlist is accepted
   * (Composer itself enforces `config.allow-plugins`). */
  install?: {
    argv: readonly string[];
    scriptFlags?: readonly string[];
    allowlisted?: readonly string[];
    manifestIsCode?: true;
    runs: string;
  };
};

/** One GitHub Actions dependency-cache preset: download caches only, never build output. */
/** Folders a declared toolchain writes into its own install while project code runs. The Candidate
 * user gets a private copy of each (src/candidate-user.ts `toolchainState`); the install itself stays
 * read-only. `root` is the runner's home, or the folder above the first PATH entry holding `binary`. */
export type EcosystemToolState = {
  tool: string;
  root: 'home' | { binary: string };
  paths: readonly string[];
};
export type EcosystemCachePreset = {
  paths: readonly string[];
  /** Lockfile globs hashed into the cache key when the declaration names none. */
  lockfiles: readonly string[];
  /** Candidate-free seed (Issue 432164bf): copy the lockfile and these manifests into an empty
   * folder and run a download-only command there. Presets without one are restored only. */
  seed?: { lockfile: string; manifests: readonly string[]; command: readonly string[] };
};

export type EcosystemEntry = {
  /** Stable id, also the docs and fixture name. */
  id: string;
  /** Source-code extensions: the code map, test-name stems and the credential-name capture rule. */
  code?: Extensions;
  managers?: readonly EcosystemManager[];
  /** Regenerable folders Lane cleanup reclaims only when .gitignore/.forgeignore ignores them. */
  regenerableDirs?: readonly string[];
  /** Further folders of installed dependencies or tool caches (hard-linked installs are not source). */
  dependencyDirs?: readonly string[];
  /** Build output Lane cleanup always reclaims, ignored or not. */
  buildDirs?: readonly string[];
  /** Build output folders that count only beside a project file matching `beside`. */
  projectOutputDirs?: { dirs: readonly string[]; beside: Extensions };
  /** Folders the module graph never reads as code. */
  nonSourceDirs?: readonly string[];
  /** GitHub Actions: the setup action (`ACTIONS_TOOLS` in src/actions-toolchains.ts), cache presets
   * and the state folders a declared toolchain writes while project code runs. */
  actions?: {
    tool?: string | readonly string[];
    cache?: Readonly<Record<string, EcosystemCachePreset>>;
    state?: readonly EcosystemToolState[];
  };
  /** Per-run check environment (src/check-ecosystem-env.ts). Paths only, never credentials. */
  checkEnv?: {
    /** Pure content caches: `[variable, folder]`, segmented per project. */
    caches?: readonly (readonly [string, string])[];
    /** Tool homes that also read executable configuration: a fresh folder per run with only the
     * named content subfolders linked in from a per-project store. */
    homes?: readonly { name: string; leaf: string; run: string; content: readonly string[] }[];
    /** Toolchain homes passed only when installed at their default location under HOME. */
    toolchains?: readonly (readonly [string, readonly string[]])[];
  };
  /** Merge parse gate, or none (stated in docs/agents/ecosystems.md). */
  mergeGate?: { extensions: Extensions; grammar: MergeGrammar };
  /** Duplicate-import fix-up, or none. */
  importFixup?: { extensions: Extensions; language: ImportFixupLanguage };
  /** Code-map and code-graph analysers, or none. */
  codeMap?: readonly { extensions: Extensions; language: SourceLanguage }[];
  /** Module-graph readers, or none. */
  moduleGraph?: readonly { extensions: Extensions; language: ModuleGraphLanguage }[];
};

/** Entry order is meaningful: root lockfiles pin in this order (npm first, so Forge pins the same
 * bytes as before), and lists keep their historical order. */
export const ECOSYSTEMS: readonly EcosystemEntry[] = [
  {
    id: 'js',
    code: '[cm]?[jt]sx?',
    managers: [
      {
        name: 'npm',
        manifests: ['package.json'],
        lockfiles: ['package-lock.json'],
        pinOnly: ['npm-shrinkwrap.json'],
      },
      { name: 'pnpm', manifests: ['pnpm-workspace.yaml'], lockfiles: ['pnpm-lock.yaml'] },
      { name: 'yarn', lockfiles: ['yarn.lock'] },
      { name: 'bun', lockfiles: ['bun.lock', 'bun.lockb'] },
    ],
    dependencyDirs: ['.pnpm-store'],
    buildDirs: ['node_modules', 'dist', 'build', 'coverage', '.next', '.turbo'],
    nonSourceDirs: ['node_modules', 'build', 'dist'],
    actions: {
      cache: {
        npm: {
          paths: ['~/.npm'],
          lockfiles: ['**/package-lock.json'],
          seed: {
            lockfile: 'package-lock.json',
            manifests: ['package.json'],
            command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          },
        },
        pnpm: {
          paths: ['~/.local/share/pnpm/store'],
          lockfiles: ['**/pnpm-lock.yaml'],
          seed: {
            lockfile: 'pnpm-lock.yaml',
            manifests: [],
            command: ['pnpm', 'fetch', '--ignore-scripts', '--ignore-pnpmfile'],
          },
        },
        yarn: { paths: ['~/.cache/yarn'], lockfiles: ['**/yarn.lock'] },
      },
    },
    mergeGate: { extensions: '[cm]?[jt]s|[jt]sx', grammar: 'typescript' },
    importFixup: { extensions: '[cm]?[jt]s|[jt]sx', language: 'javascript' },
    codeMap: [
      { extensions: 'ts|tsx|mts|cts', language: 'typescript' },
      { extensions: 'js|jsx|mjs|cjs', language: 'javascript' },
    ],
  },
  {
    id: 'rust',
    code: 'rs',
    managers: [{ name: 'cargo', manifests: ['Cargo.toml'], lockfiles: ['Cargo.lock'] }],
    regenerableDirs: ['target'],
    nonSourceDirs: ['target'],
    actions: {
      tool: 'rust',
      cache: {
        cargo: {
          paths: ['~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db'],
          lockfiles: ['**/Cargo.lock'],
        },
      },
    },
    checkEnv: {
      homes: [
        { name: 'CARGO_HOME', leaf: 'check-cargo-home', run: 'cargo-home', content: ['registry', 'git'] },
      ],
      toolchains: [['RUSTUP_HOME', ['.rustup']]],
    },
    mergeGate: { extensions: 'rs', grammar: 'rust' },
    importFixup: { extensions: 'rs', language: 'rust' },
    codeMap: [{ extensions: 'rs', language: 'rust' }],
    moduleGraph: [{ extensions: 'rs', language: 'rust' }],
  },
  {
    id: 'go',
    code: 'go',
    managers: [{ name: 'go', manifests: ['go.mod', 'go.work'], lockfiles: ['go.sum'] }],
    nonSourceDirs: ['vendor', 'testdata'],
    actions: {
      tool: 'go',
      cache: {
        go: {
          paths: ['~/go/pkg/mod', '~/.cache/go-build'],
          lockfiles: ['**/go.sum'],
          seed: { lockfile: 'go.sum', manifests: ['go.mod'], command: ['go', 'mod', 'download'] },
        },
      },
    },
    checkEnv: {
      caches: [
        ['GOMODCACHE', 'check-go-mod-cache'],
        ['GOCACHE', 'check-go-build-cache'],
      ],
    },
    importFixup: { extensions: 'go', language: 'go' },
    codeMap: [{ extensions: 'go', language: 'go' }],
    moduleGraph: [{ extensions: 'go', language: 'go' }],
  },
  {
    id: 'python',
    code: 'py',
    managers: [
      { name: 'uv', lockfiles: ['uv.lock'] },
      { name: 'poetry', lockfiles: ['poetry.lock'] },
      { name: 'pipenv', lockfiles: ['Pipfile.lock'] },
      { name: 'pip' },
    ],
    regenerableDirs: ['.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache'],
    dependencyDirs: ['site-packages', '.tox', '.nox'],
    nonSourceDirs: ['__pycache__', 'site-packages', 'venv'],
    actions: {
      tool: 'python',
      cache: {
        pip: {
          paths: ['~/.cache/pip'],
          lockfiles: ['**/requirements*.txt'],
          // Binary wheels only: building a source distribution would run its setup code.
          seed: {
            lockfile: 'requirements*.txt',
            manifests: [],
            command: [
              'python3',
              '-m',
              'pip',
              'download',
              '--only-binary=:all:',
              '--dest',
              'wheels',
              '-r',
              '{lockfile}',
            ],
          },
        },
        uv: { paths: ['~/.cache/uv'], lockfiles: ['**/uv.lock'] },
        poetry: { paths: ['~/.cache/pypoetry'], lockfiles: ['**/poetry.lock'] },
      },
    },
    checkEnv: {
      caches: [
        ['PIP_CACHE_DIR', 'check-pip-cache'],
        ['UV_CACHE_DIR', 'check-uv-cache'],
      ],
      toolchains: [['PYENV_ROOT', ['.pyenv']]],
    },
    mergeGate: { extensions: 'pyi?', grammar: 'python' },
    importFixup: { extensions: 'pyi?', language: 'python' },
    codeMap: [{ extensions: 'py', language: 'python' }],
    moduleGraph: [{ extensions: 'py', language: 'python' }],
  },
  {
    id: 'ruby',
    code: 'rb',
    managers: [
      {
        name: 'bundler',
        manifests: ['Gemfile'],
        lockfiles: ['Gemfile.lock'],
        install: {
          argv: ['bundle', 'install'],
          manifestIsCode: true,
          runs: 'the Gemfile (Ruby code) and gem native extension builds',
        },
      },
    ],
    regenerableDirs: ['vendor'],
    nonSourceDirs: ['vendor'],
    actions: {
      tool: 'ruby',
      // Restored only: resolving a Gemfile runs it (Ruby code), so no seed is Candidate-free.
      cache: { bundler: { paths: ['~/.bundle/cache'], lockfiles: ['**/Gemfile.lock'] } },
      // `bundle install` and `gem install` write gems and binstubs into the toolchain itself.
      state: [{ tool: 'ruby', root: { binary: 'ruby' }, paths: ['lib/ruby/gems', 'bin'] }],
    },
    checkEnv: {
      caches: [['BUNDLE_USER_CACHE', 'check-bundle-cache']],
      toolchains: [['RBENV_ROOT', ['.rbenv']]],
    },
    codeMap: [{ extensions: 'rb', language: 'ruby' }],
  },
  {
    id: 'php',
    code: 'php',
    managers: [
      {
        name: 'composer',
        manifests: ['composer.json'],
        lockfiles: ['composer.lock'],
        install: {
          argv: ['composer', 'install', '--no-interaction', '--no-scripts', '--no-plugins'],
          scriptFlags: ['--no-scripts', '--no-plugins'],
          allowlisted: ['--no-plugins'],
          runs: 'composer scripts and plugins',
        },
      },
    ],
    regenerableDirs: ['vendor'],
    nonSourceDirs: ['vendor'],
    actions: {
      tool: 'php',
      cache: {
        composer: {
          paths: ['~/.cache/composer'],
          lockfiles: ['**/composer.lock'],
          // composer.json is data: with scripts and plugins off, nothing from the repository runs.
          seed: {
            lockfile: 'composer.lock',
            manifests: ['composer.json'],
            command: [
              'composer',
              'install',
              '--no-interaction',
              '--no-scripts',
              '--no-plugins',
              '--no-autoloader',
              '--no-progress',
              '--ignore-platform-reqs',
            ],
          },
        },
      },
    },
    checkEnv: { caches: [['COMPOSER_CACHE_DIR', 'check-composer-cache']] },
    codeMap: [{ extensions: 'php', language: 'php' }],
  },
  {
    id: 'jvm',
    code: 'java|kts?|scala',
    managers: [
      { name: 'maven' },
      {
        name: 'gradle',
        lockfiles: ['gradle.lockfile'],
        install: {
          argv: ['gradle', 'dependencies'],
          manifestIsCode: true,
          runs: 'the build and settings scripts (Groovy or Kotlin code), buildSrc and applied plugins',
        },
      },
    ],
    // Gradle's project cache, Kotlin 2's project folder and the Android native build folder.
    regenerableDirs: ['.gradle', '.kotlin', '.cxx'],
    actions: {
      tool: 'java',
      cache: {
        maven: { paths: ['~/.m2/repository'], lockfiles: ['**/pom.xml'] },
        gradle: {
          paths: ['~/.gradle/caches', '~/.gradle/wrapper'],
          lockfiles: ['**/*.gradle*', '**/gradle-wrapper.properties'],
        },
      },
    },
    checkEnv: {
      homes: [
        {
          name: 'GRADLE_USER_HOME',
          leaf: 'check-gradle-home',
          run: 'gradle-home',
          content: ['caches', 'wrapper'],
        },
      ],
      // Kotlin/Native compilers and the Android SDK at their default places (macOS, then Linux).
      toolchains: [
        ['KONAN_DATA_DIR', ['.konan']],
        ['ANDROID_HOME', ['Library', 'Android', 'sdk']],
        ['ANDROID_HOME', ['Android', 'Sdk']],
      ],
    },
    mergeGate: { extensions: 'java', grammar: 'java' },
    importFixup: { extensions: 'java', language: 'java' },
    codeMap: [
      { extensions: 'java', language: 'java' },
      { extensions: 'kts?', language: 'kotlin' },
    ],
    moduleGraph: [
      { extensions: 'java', language: 'java' },
      { extensions: 'kt', language: 'kotlin' },
    ],
  },
  {
    id: 'dotnet',
    code: 'cs',
    managers: [{ name: 'nuget', lockfiles: ['packages.lock.json'] }],
    projectOutputDirs: { dirs: ['bin', 'obj'], beside: '(cs|fs|vb)proj' },
    actions: {
      tool: 'dotnet',
      cache: {
        nuget: {
          paths: ['~/.nuget/packages'],
          lockfiles: ['**/packages.lock.json', '**/*.csproj', '**/Directory.Packages.props'],
        },
      },
    },
    checkEnv: { caches: [['NUGET_PACKAGES', 'check-nuget-packages']] },
    importFixup: { extensions: 'cs', language: 'csharp' },
    codeMap: [{ extensions: 'cs', language: 'csharp' }],
  },
  {
    id: 'swift',
    code: 'swift',
    managers: [
      {
        name: 'swiftpm',
        manifests: ['Package.swift'],
        lockfiles: ['Package.resolved'],
        install: {
          argv: ['swift', 'package', 'resolve'],
          manifestIsCode: true,
          runs: 'Package.swift (Swift code SwiftPM compiles and runs); package plugins run when the check builds',
        },
      },
      // Xcode projects (`*.xcodeproj`) are patterned names: src/package-graph-swift.ts reads them.
      {
        name: 'cocoapods',
        lockfiles: ['Podfile.lock'],
        install: {
          argv: ['pod', 'install'],
          manifestIsCode: true,
          runs: 'the Podfile (Ruby code), its hooks and pod prepare_command scripts',
        },
      },
    ],
    regenerableDirs: ['.build', '.swiftpm', 'DerivedData', 'Pods'],
    nonSourceDirs: ['DerivedData', 'Pods', 'Carthage'],
    actions: {
      // The runner image's Swift (Xcode on macOS runners, swift.org on Ubuntu): no setup action.
      cache: {
        swiftpm: {
          paths: ['~/Library/Caches/org.swift.swiftpm', '~/.cache/org.swift.swiftpm'],
          lockfiles: ['**/Package.resolved'],
        },
      },
    },
    codeMap: [{ extensions: 'swift', language: 'swift' }],
  },
  {
    id: 'elixir',
    code: 'exs?',
    managers: [
      {
        name: 'mix',
        manifests: ['mix.exs'],
        lockfiles: ['mix.lock'],
        install: {
          argv: ['mix', 'deps.get'],
          manifestIsCode: true,
          runs: 'mix.exs (Elixir code) and dependency build steps',
        },
      },
    ],
    regenerableDirs: ['_build', 'deps'],
    nonSourceDirs: ['_build', 'deps'],
    actions: {
      tool: 'elixir',
      // Restored only: resolving mix.exs runs it (Elixir code), so no seed is Candidate-free.
      cache: { hex: { paths: ['~/.hex/packages'], lockfiles: ['**/mix.lock'] } },
      // setup-beam installs Hex and rebar3 into the runner's Mix home; mix reads and updates them.
      state: [{ tool: 'elixir', root: 'home', paths: ['.mix'] }],
    },
    // Hex's own home holds its API key, so it is never shared; Mix's home holds installed archives.
    checkEnv: { toolchains: [['MIX_HOME', ['.mix']]] },
    codeMap: [{ extensions: 'exs?', language: 'elixir' }],
  },
  {
    id: 'dart',
    code: 'dart',
    managers: [
      {
        name: 'pub',
        manifests: ['pubspec.yaml'],
        lockfiles: ['pubspec.lock'],
        // pubspec.yaml is data and pub runs no package scripts; build hooks run when the check builds.
        install: { argv: ['dart', 'pub', 'get'], runs: 'no package scripts' },
      },
    ],
    regenerableDirs: ['.dart_tool'],
    actions: {
      // Flutter apps and packages (`sdk: flutter`) take Flutter, which bundles its own Dart.
      tool: ['dart', 'flutter'],
      cache: { pub: { paths: ['~/.pub-cache'], lockfiles: ['**/pubspec.lock'] } },
      // The flutter tool writes stamps, locks and downloaded engine artifacts into its SDK.
      state: [{ tool: 'flutter', root: { binary: 'flutter' }, paths: ['bin/cache'] }],
    },
    checkEnv: {
      // The pub cache also holds globally activated executables (`bin/`): only packages link in.
      homes: [{ name: 'PUB_CACHE', leaf: 'check-pub-cache', run: 'pub-cache', content: ['hosted', 'git'] }],
    },
    codeMap: [{ extensions: 'dart', language: 'dart' }],
  },
  {
    // C and C++ (Issue 345ebcb9). No package graph: the build file is a manifest Forge does not read, so
    // affected tests widen to a full run with the stated reason (docs/agents/ecosystems.md).
    id: 'c',
    code: 'c|cc|cpp|cxx|h|hh|hpp|hxx',
    managers: [
      { name: 'cmake', manifests: ['CMakeLists.txt'] },
      { name: 'meson', manifests: ['meson.build'] },
      { name: 'conan', manifests: ['conanfile.txt', 'conanfile.py'], lockfiles: ['conan.lock'] },
      { name: 'vcpkg', manifests: ['vcpkg.json'], unpinned: ['vcpkg-configuration.json'] },
    ],
    regenerableDirs: [
      'cmake-build-debug',
      'cmake-build-release',
      'cmake-build-relwithdebinfo',
      'cmake-build-minsizerel',
      'builddir',
      'vcpkg_installed',
    ],
    actions: {
      tool: 'cmake',
      // Restore only: a recipe or port can run repository code, so Forge never seeds these.
      cache: {
        vcpkg: {
          paths: ['~/.cache/vcpkg/archives'],
          lockfiles: ['**/vcpkg.json', '**/vcpkg-configuration.json'],
        },
        conan: {
          paths: ['~/.conan2/p'],
          lockfiles: ['**/conan.lock', '**/conanfile.txt', '**/conanfile.py'],
        },
      },
    },
  },
  {
    // Zig (Issue 345ebcb9). `build.zig.zon` pins every dependency by content hash, so it is the lockfile.
    id: 'zig',
    code: 'zig',
    managers: [{ name: 'zig', manifests: ['build.zig', 'build.zig.zon'], lockfiles: ['build.zig.zon'] }],
    regenerableDirs: ['.zig-cache', 'zig-out'],
    actions: {
      tool: 'zig',
      cache: {
        zig: {
          paths: ['~/.cache/zig/p'],
          lockfiles: ['**/build.zig.zon'],
          // `zig build --fetch` only fetches and hash-checks the dependency tree; it never compiles or
          // runs build.zig (checked with a build.zig that cannot compile), so no repository code runs.
          seed: { lockfile: 'build.zig.zon', manifests: ['build.zig'], command: ['zig', 'build', '--fetch'] },
        },
      },
    },
  },
  {
    // Delphi, light (Issue 345ebcb9): recognised source and regenerable output only. No toolchain setup
    // (the compiler is licensed and Windows-only), no package manager, no check environment.
    id: 'delphi',
    code: 'pas|dpr|dpk|dfm|fmx',
    regenerableDirs: ['__history', '__recovery'],
    projectOutputDirs: {
      dirs: [
        'Win32',
        'Win64',
        'Win64x',
        'OSX64',
        'OSXARM64',
        'Linux64',
        'Android',
        'Android64',
        'iOSDevice64',
      ],
      beside: 'dproj',
    },
  },
  { id: 'json', mergeGate: { extensions: 'json', grammar: 'json' } },
];

/** The entry with this id. */
export const ecosystemEntry = (id: string, entries = ECOSYSTEMS) => {
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`Ecosystem ${id} is not in src/ecosystems.ts.`);
  return entry;
};
const all = <T>(pick: (entry: EcosystemEntry) => readonly T[] | undefined, entries = ECOSYSTEMS) =>
  entries.flatMap(entry => pick(entry) ?? []);
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const ending = (extensions: Extensions, flags = '') => new RegExp(`\\.(?:${extensions})$`, flags);

/** Lockfile names that pin a check plan: each manager's own, then its pin-only ones. */
export const pinLockfiles = (entries = ECOSYSTEMS) =>
  unique(all(entry => entry.managers?.flatMap(m => [...(m.lockfiles ?? []), ...(m.pinOnly ?? [])]), entries));
/** Lockfiles that identify a manager, by manager name. */
export const managerLockfiles = (entries = ECOSYSTEMS) =>
  new Map(all(entry => entry.managers, entries).map(m => [m.name, [...(m.lockfiles ?? [])]]));
/** Exact manifest names the package graph reads. */
export const manifestNames = (entries = ECOSYSTEMS) =>
  new Set(all(entry => entry.managers?.flatMap(m => m.manifests ?? []), entries));
export const regenerableDirs = (entries = ECOSYSTEMS) =>
  new Set(all(entry => entry.regenerableDirs, entries));
export const dependencyDirs = (entries = ECOSYSTEMS) =>
  new Set([...regenerableDirs(entries), ...all(entry => entry.dependencyDirs, entries)]);
export const buildDirs = (entries = ECOSYSTEMS) => new Set(all(entry => entry.buildDirs, entries));
export const projectOutputDirs = (entries = ECOSYSTEMS) =>
  all(entry => (entry.projectOutputDirs ? [entry.projectOutputDirs] : []), entries).map(output => ({
    dirs: new Set(output.dirs),
    beside: ending(output.beside, 'i'),
  }));
/** `(?:^|/)(?:DIR|…|.hidden)/`: a path below a folder the module graph never reads as code. */
export const nonSourceDirPattern = (entries = ECOSYSTEMS) =>
  new RegExp(`(?:^|\\/)(?:${unique(all(entry => entry.nonSourceDirs, entries)).join('|')}|\\.[^/]+)\\/`);
const codeAlternation = (entries: readonly EcosystemEntry[]) =>
  all(entry => (entry.code ? [entry.code] : []), entries).join('|');
/** Source-code file names in every listed language; group 1 is the name without its extension. */
export const codeFilePattern = (entries = ECOSYSTEMS) =>
  new RegExp(`^(.+)\\.(?:${codeAlternation(entries)})$`, 'i');
/** A value ending in a source-code extension of any listed language (case-insensitive). */
export const codeExtensionPattern = (entries = ECOSYSTEMS) => ending(codeAlternation(entries), 'i');
/** Code files of one entry (`js`), case-sensitive. */
export const codeFileOf = (id: string, entries = ECOSYSTEMS) => {
  const code = entries.find(entry => entry.id === id)?.code;
  if (!code) throw new Error(`Ecosystem ${id} has no code extensions.`);
  return ending(code);
};
const byExtension = <T extends string>(
  pick: (entry: EcosystemEntry) => readonly { extensions: Extensions; value: T }[] | undefined,
  entries: readonly EcosystemEntry[],
): [RegExp, T][] => all(pick, entries).map(({ extensions, value }) => [ending(extensions), value]);
/** `[file pattern, grammar]` of the merge parse gate. */
export const mergeGates = (entries = ECOSYSTEMS) =>
  byExtension(
    entry =>
      entry.mergeGate ? [{ extensions: entry.mergeGate.extensions, value: entry.mergeGate.grammar }] : [],
    entries,
  );
/** `[file pattern, language]` of the duplicate-import fix-up. */
export const importFixups = (entries = ECOSYSTEMS) =>
  byExtension(
    entry =>
      entry.importFixup
        ? [{ extensions: entry.importFixup.extensions, value: entry.importFixup.language }]
        : [],
    entries,
  );
/** `[file pattern, language]` of the code map and code graph. */
export const codeMapLanguages = (entries = ECOSYSTEMS) =>
  byExtension(entry => entry.codeMap?.map(m => ({ extensions: m.extensions, value: m.language })), entries);
/** Every lockfile name Forge recognises: pinned ones first, then those not pinned yet. */
export const knownLockfiles = (entries = ECOSYSTEMS) =>
  unique([
    ...pinLockfiles(entries),
    ...all(entry => entry.managers?.flatMap(m => m.unpinned ?? []), entries),
  ]);
/** `[file pattern, language]` of the module graph. */
export const moduleGraphLanguages = (entries = ECOSYSTEMS) =>
  byExtension(
    entry => entry.moduleGraph?.map(m => ({ extensions: m.extensions, value: m.language })),
    entries,
  );
/** Actions cache presets by name, in entry order. */
export const cachePresets = (entries = ECOSYSTEMS) =>
  new Map(all(entry => Object.entries(entry.actions?.cache ?? {}), entries));
/** Actions setup tools named by entries. */
export const actionsTools = (entries = ECOSYSTEMS) =>
  all(entry => [entry.actions?.tool ?? []].flat(), entries);
/** Toolchain state folders by declared tool. */
export const actionsToolState = (entries = ECOSYSTEMS) => all(entry => entry.actions?.state, entries);
export const checkEnvCaches = (entries = ECOSYSTEMS) => all(entry => entry.checkEnv?.caches, entries);
export const checkEnvHomes = (entries = ECOSYSTEMS) => all(entry => entry.checkEnv?.homes, entries);
export const checkEnvToolchains = (entries = ECOSYSTEMS) => all(entry => entry.checkEnv?.toolchains, entries);
