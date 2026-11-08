// SPDX-License-Identifier: Apache-2.0
/** Rule v4 of the first-check global-risk list (src/first-check-risk.ts): files that can change how
 * every test, build or check of a repository behaves, matched by shape at any depth for every
 * ecosystem, not by Forge's layout. Paths only, any CI. A false match costs one recheck; a miss
 * lands a change on a check that never saw the new harness, so doubtful shapes are included. */

/** Folders that hold tests: a harness-shaped file inside one is loaded by the runner. */
const TEST_DIR = '(?:tests?|specs?|__tests__|testing|e2e|integration|cypress|playwright)';
/** A test file itself is never harness (it runs only itself). */
const NOT_A_TEST = '(?![^/]*[._-](?:test|spec)\\.)';
const any = (alternatives: string[]) => new RegExp(`(?:^|/)(?:${alternatives.join('|')})$`);

export const HARNESS_RISK_V4: readonly RegExp[] = [
  // Runner-loaded harness by tool name: vitest.setup.ts, jest.preset.js, vitest.workspace.ts,
  // karma.conf.js, jest.config.json, playwright.global-setup.ts.
  any([
    '(?:vitest|jest|mocha|karma|playwright|cypress|ava|jasmine|uvu|tap|wdio|nightwatch|protractor|testem|web-test-runner|wtr)[.-](?:[\\w-]+[.-])?(?:setup|teardown|globals?|preset|workspace|projects|bootstrap|env|shim|polyfills?|conf|config)(?:\\.[^/]+)?',
    // Create React App and common setup names: setupTests.ts, global-setup.ts, test-setup.js.
    'setupTests?\\.[^/]+|setup(?:Files|Env)[^/]*\\.[^/]+',
    '(?:global|test)[-_.]?(?:setup|teardown)\\.[^/]+|global(?:Setup|Teardown)\\.[^/]+|setup[-_](?:tests?|jest|vitest|env)\\.[^/]+',
  ]),
  // Inside a test folder: spec/spec_helper.rb, spec/rails_helper.rb, test/test_helper.exs,
  // test/setup.ts, tests/bootstrap.php, tests/globals.d.ts.
  new RegExp(
    `(?:^|/)${TEST_DIR}/(?:[^/]+/)*${NOT_A_TEST}(?:[\\w-]+[_-])?(?:helper|setup|teardown|bootstrap|globals?)(?:\\.[^/]+)?$`,
  ),
  // Support and setup folders every test loads: spec/support/**, test/support/** (Elixir),
  // cypress/support/**, tests/setup/**.
  new RegExp(`(?:^|/)${TEST_DIR}/(?:[^/]+/)*(?:support|setup)/`),
  // Jest manual mocks apply to every test that imports the mocked module.
  /(?:^|\/)__mocks__\//,
  // Runner and tool rc files at any depth: .mocharc.yml, .nycrc, .c8rc.json, .rspec, .coveragerc.
  any([
    '\\.[\\w-]*rc(?:\\.[\\w]+)?',
    '\\.rspec(?:-local)?',
    'phpunit(?:\\.dist)?\\.xml(?:\\.dist)?',
    'pylintrc|\\.flake8|\\.?ruff\\.toml|pyrightconfig\\.json|\\.pdbrc',
    // Environment files the runner or compose file loads.
    '\\.env(?:\\.[^/]+)?|\\.envrc',
    '(?:docker-)?compose(?:[.-][^/]+)?\\.ya?ml',
    '(?:Containerfile|Dockerfile\\.[^/]+|[^/]+\\.[Dd]ockerfile)',
    '[^/]+\\.config\\.[^/]+',
  ]),
  // Build, dependency and task files of ecosystems the v1-v3 lists do not name.
  any([
    // Ruby
    'Rakefile|[^/]+\\.rake|[^/]+\\.gemspec|\\.ruby-version|Gemfile\\.[^/]+',
    // Elixir and Erlang
    'mix\\.(?:exs|lock)|rebar\\.(?:config|lock)|\\.formatter\\.exs',
    // Swift and Apple
    'Package\\.(?:swift|resolved)|Podfile(?:\\.lock)?|Cartfile(?:\\.resolved)?|[^/]+\\.podspec|project\\.yml',
    // Dart and Flutter
    'pubspec\\.(?:yaml|lock)|analysis_options\\.yaml',
    // Scala, Clojure and JVM wrappers
    'build\\.sbt|project/[^/]+\\.(?:sbt|scala)|project/build\\.properties|deps\\.edn|project\\.clj|gradlew|mvnw|\\.mvn/.+',
    // Deno, Bun and JS workspace tools
    'deno\\.jsonc?|deno\\.lock|bunfig\\.toml|turbo\\.json|nx\\.json|project\\.json|lerna\\.json|rush\\.json|\\.pnpmfile\\.cjs|\\.pnp\\.c?js',
    // Python
    'constraints[^/]*\\.txt|pdm\\.lock|hatch\\.toml|pixi\\.(?:toml|lock)|environment\\.ya?ml|\\.pre-commit-config\\.ya?ml',
    // Nix
    'flake\\.(?:nix|lock)|default\\.nix|shell\\.nix',
    // Haskell, OCaml, Zig, Elm
    'stack\\.yaml|cabal\\.project(?:\\.[^/]+)?|[^/]+\\.cabal|dune-project|dune|[^/]+\\.opam|build\\.zig(?:\\.zon)?|elm\\.json',
    // C and C++ build systems and package managers
    'GNUmakefile|makefile|[^/]+\\.mk|meson\\.build|meson_options\\.txt|meson\\.options|configure(?:\\.ac)?|Makefile\\.(?:am|in)|SConstruct|SConscript|conanfile\\.(?:py|txt)|vcpkg\\.json|xmake\\.lua',
    // Task runners
    '[Jj]ustfile|\\.justfile|Taskfile\\.ya?ml|Earthfile|Tiltfile',
  ]),
];

/** Root `.txt` names that are prose; any other root `.txt` is a build or dependency input. */
const PROSE_ROOT_TEXT =
  /^(?:README|LICEN[CS]E|COPYING|NOTICE|THIRD[_-]PARTY[_-]NOTICES|CHANGELOG|CHANGES|HISTORY|AUTHORS|CONTRIBUTORS|CREDITS|SECURITY|CODE_OF_CONDUCT|llms(?:-full)?|robots|humans)(?:[._-][^/]*)?\.txt$/i;
export const proseRootText = (path: string) => PROSE_ROOT_TEXT.test(path);
