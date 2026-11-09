# Adding an ecosystem

Everything Forge knows about a language or package ecosystem lives in one registry,
[`src/ecosystems.ts`](../../src/ecosystems.ts). Lockfile pins, Lane cleanup, the code map, the
merge parse gate, the duplicate-import fix-up, the module graph, Actions caches and the check
environment all read their lists from it. `tests/forge-only-rules.test.mjs` fails when a lockfile
name, a folder list or an extension list appears anywhere else
([`ecosystem-*` rules](../forge-only-rules.md#the-guard)).

Adding an ecosystem means adding **one entry and one fixture repository**:

1. Add an entry to `ECOSYSTEMS`. Fill in only the fields that apply; leave out the rest.
2. Add a small synthetic fixture repository under `tests/fixtures/` with its manifest, lockfile, one
   source file and one test file, plus a test that fails without the entry.
3. The registry test in `tests/forge-only-rules.test.mjs` checks that every consumer picks up the
   entry. Run it with the fixture's test.

## Entry fields

| Field | What reads it |
| --- | --- |
| `id` | docs and fixture names |
| `code` | source-file extensions (`exs?`): test-name stems, JUnit code labels, the credential-name capture rule |
| `managers[]` | `name`, exact `manifests` (package graph), `lockfiles` (identify the manager and pin check plans, at the root or in any folder), `pinOnly`, `unpinned` (recognised as dependency state but not lockfiles, so they pin nothing) and `install` (the install argv without scripts or plugins, the flags that keep them off, and `manifestIsCode` when the manifest is a program; `src/ecosystem-install.ts`) |
| `regenerableDirs` | Lane cleanup reclaims them only when ignored |
| `dependencyDirs` | installs and tool caches: hard-linked files there are not source |
| `buildDirs` | build output that Lane cleanup always reclaims |
| `projectOutputDirs` | output folders that count only beside a project file (.NET `bin`/`obj`) |
| `nonSourceDirs` | folders the module graph never reads as code |
| `actions` | the Actions setup `tool` and dependency-cache presets (paths, lockfile globs, an optional Candidate-free `seed`) |
| `checkEnv` | per-run content caches, tool homes and toolchain homes in the check environment |
| `mergeGate` | the extensions and grammar of the merge parse gate |
| `importFixup` | the extensions and reader of the duplicate-import fix-up |
| `codeMap` | the code map's analysed languages |
| `moduleGraph` | the module graph's readers |

Entry order matters only for the order of root lockfile names (`PROJECT_LOCKFILES`). A check plan's
lockfile digest (`lockfileDigest`, `src/project-lockfile.ts`) covers every registry lockfile in the
pinned State at any depth: no lockfile is the empty-input digest, a repository whose only lockfile is
one root file keeps the digest of its bytes, and anything else is the digest of the sorted path and
blob lines, so a change to a nested lockfile (or moving one) changes the plan and its cache key, and
an unrelated file does not. It reads State records only, never file bytes. Repositories with a nested
lockfile, a second root lockfile or a `gradle.lockfile`, `packages.lock.json` or `Podfile.lock` got a
different plan digest once, when this landed.

## Code that is not data

Some fields name code that lives in a module of its own. A new value there needs that code too:

- A new `mergeGate` grammar: a lazily loaded parser in `src/native-merge-syntax-other.ts`. It must
  load on compose only and never enter the Convex bundle.
- A new `importFixup` language: a reader in `READERS` in `src/native-import-languages.ts`.
- A new `moduleGraph` or `codeMap` language: its reader (`src/module-graph-*.ts`, the analysers). With no
  bundled grammar, a declaration scanner (`src/structural-scan-*.ts`, registered in
  `src/structural-scanned.ts`) reads declaration headers and import lines with comments and literals
  masked, as Ruby, PHP and Elixir do.
- A new `install`: its repository allowlist reader in `MANAGER_REQUESTS` of `src/ecosystem-install.ts`
  when the manager keeps one (Composer `config.allow-plugins`).
- A package-graph reader: `src/package-graph-*.ts` and `READERS` in `src/package-graph.ts`. The
  reader owns the test command and its patterned manifest names.
- A new cache preset: add its name to `CACHE_PRESET_NAMES` and raise the `.max()` beside it in
  `src/actions-toolchains.ts`. Schema snapshots read literals only; a test keeps the names equal to
  the registry's.
- A new Actions `tool`: `ACTIONS_TOOLS`, its pinned action and its setup steps. Generated workflows
  change, so an owner checks the workflow diff. A tool added after a runner repository installed its
  `forge-check.yml` (Zig, CMake, Dart, Flutter, Elixir, Ruby, PHP) gets its own hosted blocks in `HOSTED_LATE_TOOLS`
  (`src/actions-toolchains-hosted.ts`) instead of changing `hostedWorkflowBlocks()`: the installed
  workflow stays valid for every other declaration, and a declaration naming the tool is refused with
  `ACTIONS_WORKFLOW_OUTDATED` until the workflow carries its blocks.
- Build inputs that make a first check risky: the next `first-check-risk` rule version. Earlier
  versions are frozen because plans pin them.

## Parse gate and import fix-up coverage

| Ecosystem | Merge parse gate | Duplicate-import fix-up |
| --- | --- | --- |
| JS/TS | TypeScript parser | yes |
| Python | Lezer | yes |
| Java | Lezer | yes |
| Rust | Lezer | yes |
| JSON | `JSON.parse` | — |
| Go | none | yes |
| C# | none | yes |
| Kotlin, Scala, Swift, Dart, Elixir, Ruby, PHP, C/C++, Zig, Delphi | none | none |

Ruby, PHP and Elixir have a code map (declaration scanners) and a package graph: Mix umbrella apps
with `in_umbrella` and `path` deps (`mix test` per app), Bundler Gemfile `path` gems and gemspec
dependencies (`bundle exec rspec`, or `bundle exec rake test` beside a Rakefile), and Composer
packages by `require` names with `path` repositories checked (`vendor/bin/phpunit` or
`vendor/bin/pest` where the dependencies are installed). Their fixtures live in
`tests/fixtures/ecosystems/` and `tests/ecosystem-fixtures.test.mjs` tests them.

"None" means a text merge is accepted on the check's evidence alone. An entry adds a gate when a
small grammar exists.

## C/C++, Zig and Delphi

Fixtures: `tests/fixtures/ecosystems/{c,zig,delphi}` (every file stored as `NAME.fixture`, so Forge's own
repository never mistakes a fixture for a real build file), read by the last test of
`tests/forge-only-rules.test.mjs`; the Actions side is in `tests/actions-toolchains.test.mjs`.

| | C/C++ (`c`) | Zig (`zig`) | Delphi (`delphi`) |
| --- | --- | --- | --- |
| Source files | `c cc cpp cxx h hh hpp hxx` | `zig` | `pas dpr dpk dfm fmx` |
| Detected by | `CMakeLists.txt`, `meson.build`, `conanfile.txt`/`.py`, `vcpkg.json` | `build.zig`, `build.zig.zon` | the source files above |
| Lockfile (pins a check plan) | `conan.lock` | `build.zig.zon` (pins each dependency by hash) | none |
| Dependency state, not pinned | `vcpkg-configuration.json` | | |
| Regenerable (only when ignored) | `cmake-build-*`, `builddir`, `vcpkg_installed` (`build` is already reclaimed with other build output) | `.zig-cache`, `zig-out` | `__history`, `__recovery`; `Win32`, `Win64` and the other platform folders beside a `.dproj` |
| Test command | the repo's own: declare it in `forge.json` `preflight.tests` (`ctest --test-dir build`, `meson test -C builddir`) | the repo's own (`zig build test`) | the repo's own |
| Actions tool | `cmake` (`lukka/get-cmake`: CMake and Ninja), `version` only | `zig` (`mlugg/setup-zig`), `version` only | none |
| Actions cache | `vcpkg` (`~/.cache/vcpkg/archives`), `conan` (`~/.conan2/p`): restored, never seeded | `zig` (`~/.cache/zig/p`), seeded with `zig build --fetch` | none |

**No package graph.** Forge reads no CMake, Meson, Conan, vcpkg, Zig or Delphi manifest, so affected
tests cannot be narrowed: the package graph is unknown and the whole suite runs. The reason is stated
where the selection is reported (`package graph unknown: no package in the manifests Forge read
(CMakeLists.txt, …): Forge has no package graph for them, so every change runs the whole suite`).
Declare the project's own test command in `forge.json` `preflight.tests` to run it as the preflight
runner; Forge never guesses `ctest` or `zig build test`.

**Cache trust.** The vcpkg and Conan entries hold dependency packages that the package manager
fetched or built from the declared dependencies (never the project's own `build/`). Their resolvers
(ports, recipes) can run repository code, so Forge only restores them; a project that wants them warm
saves them from its own default-branch workflow. The Zig seed is safe to run Candidate-free:
`zig build --fetch` fetches and hash-checks the dependency tree and never compiles or runs
`build.zig` (checked with a `build.zig` that cannot compile).

**Zig and CMake actions** take `version` only (`0.14.0`, `3.31.6`, `latest`); their own caches are
turned off (`use-cache: false`, `useCloudCache: false`) so that Forge's cache step is the only
writer.

**Delphi is light, and these are its limits.**

- Forge recognises Delphi source and form files (they count as code for test-name matching and
  change classification) and reclaims its regenerable folders. Nothing more.
- No toolchain setup: the Delphi compiler is licensed and Windows-only, so Forge installs none and
  declares no Actions tool for it. A project runs its tests with its own command on a runner that
  already has the compiler (declare it in `forge.json` `preflight.tests`), typically a self-hosted
  Windows runner.
- No lockfile and no package manager (GetIt and Boss are not read), no code map beyond file
  recognition, no merge parse gate and no duplicate-import fix-up.
- Compiled output is recognised by folder only (`Win32/Debug`, `Win64/Release` under the platform
  folders beside a `.dproj`). Loose `*.dcu`, `*.exe` and `*.res` files are not reclaimed by name:
  keep them in the project's `.gitignore`.
- A Delphi build file (`.dproj`, `.groupproj`) is not yet a first-check risk input
  (`first-check-risk-v4` names none), so a first check after one changes is not flagged.

## Swift, Kotlin and Dart

Issue 870791c3; fixtures in `tests/fixtures/ecosystem-repos/{swift,kotlin,dart}.json` (path → text
trees, so this repository holds no live manifest), tests in `tests/ecosystem-fixtures.test.mjs`.

| | Swift | Kotlin / Android | Dart / Flutter |
| --- | --- | --- | --- |
| Entry | `swift` | the `jvm` entry (one per toolchain) | `dart` |
| Detection | `Package.swift`, `Package.resolved` (pinned), `*.xcodeproj`, `Podfile.lock` (pinned) | Gradle Kotlin DSL, `settings.gradle.kts`, Android modules | `pubspec.yaml`, `pubspec.lock` (pinned) |
| Package graph | `src/package-graph-swift.ts`: literal `.package(path:)` edges; an Xcode project depends on every SwiftPM package | `src/package-graph-jvm.ts`: `project(":x")` edges | `src/package-graph-pub.ts`: `path:` dependencies, overrides, `workspace:` members |
| Test command | `swift test` per package; Xcode has none Forge can read (scheme, simulator) and names the `preflight.tests` declaration with an `xcodebuild test` example | `gradle :p:test` (`*Test.kt`, `src/test`, `src/androidTest`) | `flutter test` when the package takes `sdk: flutter`, else `dart test` (`test/*_test.dart`; `integration_test/` needs a device) |
| Regenerable | `.build`, `.swiftpm`, `DerivedData`, `Pods` | `.gradle`, `.kotlin`, `.cxx` | `.dart_tool` |
| Actions | runner image's Swift (no setup action); `swiftpm` cache preset | `java` tool; `gradle` preset | `dart` and `flutter` tools (`dart-lang/setup-dart`, `subosito/flutter-action`, pinned digests); `pub` preset |
| Check env | — | `KONAN_DATA_DIR`, `ANDROID_HOME` when installed at the default place | `PUB_CACHE`: a fresh run home with `hosted/` and `git/` linked from the shared cache |
| Code map | declaration scanner (`src/structural-brace*.ts`): types, functions, properties; `import M` → `Sources/M/` | the same scanner for `.kt`/`.kts`; imports → package or declaring file | the same scanner; relative and `package:` imports |

A macOS runner is used only when the project's Actions runner sets `runsOn` to a macOS label (public
repositories run free). Xcode project contents, `*.xcconfig`, Gradle script plugins and Dart tool
configuration are build inputs from `first-check-risk-v6`.

### Install scripts and build code

Forge never runs repository code to read a repository: `Package.swift`, `build.gradle(.kts)`,
`settings.gradle(.kts)` and `pubspec.yaml` are read as text, never evaluated. Lane `start` shares JS
installs only (`npm ci --ignore-scripts`); it never runs `swift`, `gradle` or `pub`. The SwiftPM,
Gradle and pub caches are restore-only presets with no seed step.

SwiftPM package plugins (`.plugin(`, `plugins:`), Gradle build scripts, script plugins and
`buildSrc/`, CocoaPods `Podfile` hooks and Dart build hooks (`hook/build.dart`) are repository code.
They run only inside the repository's own declared check, in the check environment, like any build
script the check command runs; nothing runs them elsewhere, and a change to them makes the first
check risky.

Their registry `install` (`src/ecosystem-install.ts`) follows the same install-script policy as
Bundler and Mix: `swift package resolve`, `pod install` and `gradle dependencies` run repository code
(the manifest is a program), so they run only when start passes `installScripts:true` or this
machine's installScripts setting accepts forge.json `install.scripts`. `dart pub get` runs no package
scripts and needs no permission.
