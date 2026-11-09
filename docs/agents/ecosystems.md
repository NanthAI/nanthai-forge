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
  change, so an owner checks the workflow diff.
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
| Kotlin, Scala, Swift, Dart, Elixir, Ruby, PHP, C/C++ | none | none |

"None" means a text merge is accepted on the check's evidence alone. An entry adds a gate when a
small grammar exists.
