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
| `managers[]` | `name`, exact `manifests` (package graph), `lockfiles` (identify the manager and pin check plans, first present wins), `pinOnly`, and `unpinned` (recognised as dependency state, not pinned yet) |
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

Entry order matters only for lockfile pins: JS comes first, so a project with `package-lock.json`
pins the same bytes as before.

## Code that is not data

Some fields name code that lives in a module of its own. A new value there needs that code too:

- A new `mergeGate` grammar: a lazily loaded parser in `src/native-merge-syntax-other.ts`. It must
  load on compose only and never enter the Convex bundle.
- A new `importFixup` language: a reader in `READERS` in `src/native-import-languages.ts`.
- A new `moduleGraph` or `codeMap` language: its reader (`src/module-graph-*.ts`, the analysers).
- A package-graph reader: `src/package-graph-*.ts` and `READERS` in `src/package-graph.ts`. The
  reader owns the test command and its patterned manifest names.
- A new cache preset: add its name to `CACHE_PRESET_NAMES` and raise the `.max()` beside it in
  `src/actions-toolchains.ts`. Schema snapshots read literals only; a test keeps the names equal to
  the registry's.
- A new Actions `tool`: `ACTIONS_TOOLS`, its pinned action and its setup steps. Generated workflows
  change, so an owner checks the workflow diff. A tool added after a runner repository installed its
  `forge-check.yml` (Zig, CMake) gets its own hosted blocks in `HOSTED_LATE_TOOLS`
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
