// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { cachePresets } from './ecosystems.js';
import { safeRelative } from './safe-relative.js';

/** Optional `actionsToolchains` and `actionsCache` of a check definition
 * (docs/operations/github-actions-checks.md#toolchains-and-dependency-cache). Only these
 * pinned actions, one per tool, and these cache presets exist; nothing else can be declared.
 * Values are validated here, so generated YAML never carries an expression or a quote. */
export const ACTIONS_TOOLS = [
  'go',
  'python',
  'java',
  'dotnet',
  'rust',
  'zig',
  'cmake',
  'elixir',
  'ruby',
  'php',
  'dart',
  'flutter',
] as const;
export type ActionsTool = (typeof ACTIONS_TOOLS)[number];
/** Full commit SHAs of released tags at least two weeks old when pinned. */
export const TOOLCHAIN_ACTIONS: Record<Exclude<ActionsTool, 'rust'>, string> = {
  go: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
  python: 'actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0',
  java: 'actions/setup-java@b843ebf9b913146b38da2eaa7aeddf76074ae1ad # v6.1.0',
  dotnet: 'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0',
  zig: 'mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29 # v2.2.1',
  cmake: 'lukka/get-cmake@fffaaafeea488556c2c12dad60690008bc1caacb # v4.4.2',
  dart: 'dart-lang/setup-dart@6afc89df92d6eb3834022f73cd65adc8cdfcb92d # v1.8.1',
  flutter: 'subosito/flutter-action@1a449444c387b1966244ae4d4f8c696479add0b2 # v2.23.0',
  elixir: 'erlef/setup-beam@54075bcc5e249e4758d363f27d099f55d843f124 # v1.24.1',
  // Never `bundler-cache`: it runs `bundle install`, which runs the Gemfile and builds extensions.
  ruby: 'ruby/setup-ruby@7f797815d8adceb1c412e7abefdd1ab4abc47a5f # v1.335.0',
  php: 'shivammathur/setup-php@eb7c497e18156a6bbabfef1d3a82760b9eda3962 # 2.40.0',
};
/** Tools whose setup step takes a `version` only (no version file the action reads from the Candidate). */
export const VERSION_ONLY_TOOLS: readonly ActionsTool[] = ['zig', 'cmake', 'dart'];
/** Flutter channels: a `version` naming one selects the channel's latest release. */
export const FLUTTER_CHANNELS = ['stable', 'beta', 'master', 'main'];
/** Version files the setup action reads by name (setup-ruby from its working directory; setup-beam
 * with `version-type: strict`). */
const VERSION_FILES: Partial<Record<ActionsTool, readonly string[]>> = {
  elixir: ['.tool-versions', 'mise.toml'],
  ruby: ['.ruby-version', '.tool-versions', 'mise.toml'],
};
const fileName = (file: string) => file.slice(file.lastIndexOf('/') + 1);
const CACHE_SHA = '0057852bfaa89a56745cba8c7296529d2fc39830 # v4';
export const JAVA_DISTRIBUTIONS = [
  'temurin',
  'zulu',
  'corretto',
  'microsoft',
  'liberica',
  'oracle',
  'semeru',
  'sapmachine',
  'dragonwell',
  'graalvm',
] as const;
/** Literal for schema snapshots (scripts/schema-snapshot.mjs); a test keeps it equal to the presets
 * the ecosystem registry (src/ecosystems.ts) declares. */
export const CACHE_PRESET_NAMES = [
  'go',
  'cargo',
  'pip',
  'uv',
  'poetry',
  'maven',
  'gradle',
  'nuget',
  'npm',
  'pnpm',
  'yarn',
  'zig',
  'vcpkg',
  'conan',
  'swiftpm',
  'pub',
  'hex',
  'bundler',
  'composer',
] as const;
export type CachePreset = (typeof CACHE_PRESET_NAMES)[number];
const registeredPresets = cachePresets();
const preset = (name: CachePreset) => {
  const found = registeredPresets.get(name);
  if (!found) throw new Error(`Cache preset ${name} is not in src/ecosystems.ts.`);
  return found;
};
/** Dependency download caches only, never build output or source (src/ecosystems.ts). Lockfile globs
 * are the defaults when the declaration names none. */
export const CACHE_PRESETS = Object.fromEntries(
  CACHE_PRESET_NAMES.map(name => [name, { paths: preset(name).paths, lockfiles: preset(name).lockfiles }]),
) as Record<CachePreset, { paths: readonly string[]; lockfiles: readonly string[] }>;
const presetNames = CACHE_PRESET_NAMES;

const version = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/, 'Select a version such as 1.23, 3.12, 21, 8.0.x or stable.');
const plainPath = (path: string) => safeRelative(path) && /^[A-Za-z0-9._/-]+$/.test(path);
const versionFile = z
  .string()
  .max(200)
  .refine(plainPath, 'Select a repository-relative file such as go.mod or .python-version.');
const lockfileGlob = z
  .string()
  .max(200)
  .refine(
    glob =>
      !glob.startsWith('/') &&
      !glob.split('/').some(s => s === '..' || s === '.' || s === '') &&
      /^[A-Za-z0-9._*/-]+$/.test(glob),
    'Select repository-relative lockfile globs such as **/go.sum (letters, digits, . _ - / and *).',
  );
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const actionsToolchainSchema = z
  .object({
    tool: z.enum(ACTIONS_TOOLS),
    version: version.optional(),
    versionFile: versionFile.optional(),
    distribution: z.enum(JAVA_DISTRIBUTIONS).optional(),
    /** Erlang/OTP beside an Elixir `version` (setup-beam installs both). */
    otpVersion: version.optional(),
  })
  .strict()
  .refine(t => (t.version === undefined) !== (t.versionFile === undefined), {
    message: 'Declare exactly one of version or versionFile.',
  })
  .refine(t => t.distribution === undefined || t.tool === 'java', {
    message: 'Only java takes a distribution.',
  })
  .refine(t => !VERSION_ONLY_TOOLS.includes(t.tool) || t.version !== undefined, {
    message:
      'Zig, CMake and Dart declare a version (Dart: stable, beta or a release such as 3.5); they read no version file.',
  })
  .refine(t => (t.tool === 'elixir' && t.version !== undefined) === (t.otpVersion !== undefined), {
    message: 'Elixir by version also takes otpVersion; only elixir takes one.',
  })
  .refine(
    t => t.tool !== 'flutter' || t.versionFile === undefined || /(?:^|\/)pubspec\.yaml$/.test(t.versionFile),
    {
      message: 'Flutter reads its version from pubspec.yaml (environment.flutter).',
    },
  )
  .refine(
    t =>
      t.versionFile === undefined ||
      !VERSION_FILES[t.tool] ||
      VERSION_FILES[t.tool]!.includes(fileName(t.versionFile)),
    {
      message:
        'Elixir reads .tool-versions or mise.toml; Ruby reads .ruby-version, .tool-versions or mise.toml.',
    },
  )
  .refine(
    t =>
      t.tool !== 'rust' ||
      t.versionFile === undefined ||
      /(?:^|\/)rust-toolchain(?:\.toml)?$/.test(t.versionFile),
    { message: 'Rust reads its version from rust-toolchain.toml or rust-toolchain.' },
  );
export const actionsToolchainsSchema = z
  .array(actionsToolchainSchema)
  .min(1)
  .max(12) // ACTIONS_TOOLS.length; schema snapshots read literals only
  .refine(list => unique(list.map(t => t.tool)), { message: 'Declare each tool once.' });
export const actionsCacheSchema = z
  .object({
    presets: z
      .array(z.enum(presetNames))
      .min(1)
      .max(19) // CACHE_PRESET_NAMES.length
      .refine(unique, { message: 'Declare each preset once.' }),
    lockfiles: z
      .array(lockfileGlob)
      .min(1)
      .max(16)
      .refine(unique, { message: 'Declare each lockfile once.' })
      .optional(),
  })
  .strict();
export type ActionsToolchain = z.infer<typeof actionsToolchainSchema>;
export type ActionsCache = z.infer<typeof actionsCacheSchema>;
/** The part of `actions` the workflow acts on; pinned in plans and recipes when declared. */
export type ActionsDeclaration = {
  toolchains?: ActionsToolchain[] | undefined;
  cache?: ActionsCache | undefined;
};

/** A check definition's `actionsToolchains` and `actionsCache`, or undefined when neither is declared. */
export function actionsDeclaration(
  check:
    | { actionsToolchains?: ActionsToolchain[] | undefined; actionsCache?: ActionsCache | undefined }
    | undefined,
): ActionsDeclaration | undefined {
  if (!check?.actionsToolchains && !check?.actionsCache) return undefined;
  return {
    ...(check.actionsToolchains ? { toolchains: check.actionsToolchains } : {}),
    ...(check.actionsCache ? { cache: check.actionsCache } : {}),
  };
}
export const cachePaths = (cache: ActionsCache) => [
  ...new Set(cache.presets.flatMap(preset => CACHE_PRESETS[preset].paths)),
];
export const cacheLockfiles = (cache: ActionsCache) =>
  cache.lockfiles ?? [...new Set(cache.presets.flatMap(preset => [...CACHE_PRESETS[preset].lockfiles]))];
/** Readable, stable key prefix. Every entry name starts `forge-deps-v1-`. */
export const cacheKeyPrefix = (cache: ActionsCache) => `forge-deps-v1-${cache.presets.join('+')}`;

const q = (value: string) => JSON.stringify(value);
const fileDirectory = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');

/** Literal steps for a workflow committed with the check's source (the export path):
 * values are inlined, so the Candidate checkout supplies version files and lockfiles. */
export function declaredSetupSteps(declaration: ActionsDeclaration | undefined) {
  if (!declaration) return '';
  let text = '';
  for (const t of declaration.toolchains ?? []) {
    if (t.tool === 'rust') {
      text += t.version
        ? `      - run: rustup toolchain install --profile minimal ${q(t.version)} && rustup default ${q(t.version)}\n`
        : `      - run: rustup toolchain install\n        working-directory: ${q(fileDirectory(t.versionFile!))}\n`;
      continue;
    }
    text += `      - uses: ${TOOLCHAIN_ACTIONS[t.tool]}\n        with:\n`;
    if (t.tool === 'go')
      text += `${t.version ? `          go-version: ${q(t.version)}` : `          go-version-file: ${q(t.versionFile!)}`}\n          cache: false\n`;
    else if (t.tool === 'python')
      text += t.version
        ? `          python-version: ${q(t.version)}\n`
        : `          python-version-file: ${q(t.versionFile!)}\n`;
    else if (t.tool === 'elixir')
      text += t.version
        ? `          elixir-version: ${q(t.version)}\n          otp-version: ${q(t.otpVersion!)}\n`
        : `          version-file: ${q(t.versionFile!)}\n          version-type: strict\n`;
    else if (t.tool === 'ruby')
      text += t.version
        ? `          ruby-version: ${q(t.version)}\n`
        : `          ruby-version: ${q(fileName(t.versionFile!))}\n          working-directory: ${q(fileDirectory(t.versionFile!))}\n`;
    // An empty token: setup-php otherwise writes the workflow token into Composer's auth.json, which
    // the check's repository code could read.
    else if (t.tool === 'php')
      text +=
        (t.version
          ? `          php-version: ${q(t.version)}\n`
          : `          php-version-file: ${q(t.versionFile!)}\n`) + `          github-token: ''\n`;
    else if (t.tool === 'java')
      text +=
        `          distribution: ${q(t.distribution ?? 'temurin')}\n` +
        (t.version
          ? `          java-version: ${q(t.version)}\n`
          : `          java-version-file: ${q(t.versionFile!)}\n`);
    else if (t.tool === 'zig') text += `          version: ${q(t.version!)}\n          use-cache: false\n`;
    else if (t.tool === 'cmake')
      text += `          cmakeVersion: ${q(t.version!)}\n          useCloudCache: false\n`;
    else if (t.tool === 'dart') text += `          sdk: ${q(t.version!)}\n`;
    else if (t.tool === 'flutter')
      text += !t.version
        ? `          flutter-version-file: ${q(t.versionFile!)}\n`
        : FLUTTER_CHANNELS.includes(t.version)
          ? `          channel: ${q(t.version)}\n`
          : `          flutter-version: ${q(t.version)}\n`;
    else
      text += t.version
        ? `          dotnet-version: ${q(t.version)}\n`
        : `          global-json-file: ${q(t.versionFile!)}\n`;
  }
  const cache = declaration.cache;
  if (cache)
    text +=
      // A download stalled for 1 min is a miss, so the check installs normally (friction d99fcf3a).
      `      - id: forge-deps\n        uses: actions/cache/restore@${CACHE_SHA}\n        env:\n          SEGMENT_DOWNLOAD_TIMEOUT_MINS: '1'\n        with:\n${cachePathInput(cache)}` +
      `          key: ${cacheKeyPrefix(cache)}-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles(${cacheLockfiles(
        cache,
      )
        .map(glob => `'${glob}'`)
        .join(', ')}) }}\n`;
  return text;
}
/** Candidate-free seeds (Issue 432164bf): a dependency cache is saved only from a download that
 * runs no repository code. Forge copies just the named manifest files beside each lockfile into an
 * empty temporary folder (no repository configuration such as .npmrc or .pnpmfile.cjs comes along)
 * and runs a download-only command there. Presets with no such command (cargo, uv, poetry, maven,
 * gradle, nuget, yarn, hex, bundler: resolution there can run repository code or configured programs)
 * are restored only, never seeded. */
export const CACHE_SEEDS: Partial<
  Record<CachePreset, { lockfile: string; manifests: readonly string[]; command: readonly string[] }>
> = Object.fromEntries(
  // Key order is part of the seed program's bytes in generated workflows: the first seeds keep their
  // historical order; seeds added later follow in registry order.
  [...new Set<CachePreset>(['go', 'npm', 'pnpm', 'pip', ...CACHE_PRESET_NAMES])].flatMap(name => {
    const seed = registeredPresets.get(name)?.seed;
    return seed ? [[name, seed]] : [];
  }),
);
/** The seeded presets of a declaration, space-separated ('' when none). */
export const cacheSeedPresets = (cache: ActionsCache) =>
  cache.presets.filter(preset => CACHE_SEEDS[preset]).join(' ');
/**
 * The seed program, plain CommonJS for `node -e PROGRAM ROOT PRESETS`: walks ROOT (skipping
 * dependency, build and VCS folders; at most 64 lockfiles), copies each lockfile and its manifests
 * into a fresh temporary folder and runs the preset's command there. A failed or missing tool skips
 * that lockfile with a line; the program always exits 0, so a seed never fails a check.
 */
export const DEPS_SEED_PROGRAM = `const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const seeds = ${JSON.stringify(CACHE_SEEDS)};
const root = path.resolve(process.argv[1]), presets = String(process.argv[2] || '').split(' ').filter(p => seeds[p]);
const skip = new Set(['.git', '.forge', 'node_modules', 'vendor', 'target', 'build', 'dist', '.venv', 'venv']);
const match = (glob, name) => { const [head, tail = ''] = glob.split('*'); return glob.includes('*') ? name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail) : name === glob; };
const found = [];
(function walk(dir, depth) {
  if (depth > 8 || found.length >= 64) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !skip.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
    else if (entry.isFile()) for (const p of presets) if (match(seeds[p].lockfile, entry.name)) found.push([p, path.join(dir, entry.name)]);
  }
})(root, 0);
for (const [preset, lockfile] of found.slice(0, 64)) {
  const seed = seeds[preset], dir = path.dirname(lockfile), label = preset + ' ' + (path.relative(root, lockfile) || '.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-seed-'));
  try {
    for (const name of [path.basename(lockfile), ...seed.manifests]) if (fs.existsSync(path.join(dir, name))) fs.copyFileSync(path.join(dir, name), path.join(temp, name));
    const args = seed.command.map(a => (a === '{lockfile}' ? path.basename(lockfile) : a));
    const result = spawnSync(args[0], args.slice(1), { cwd: temp, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
    console.log('Forge seed: ' + label + (result.status === 0 ? ' downloaded' : ' skipped (' + (result.error ? result.error.code : 'exit ' + result.status) + ')'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
console.log('Forge seed: ' + found.length + ' lockfile' + (found.length === 1 ? '' : 's') + ' for ' + (presets.join(', ') || 'no seeded preset'));
`;
/** The export workflow's static job, on the default branch after a cache miss: the Candidate-free
 * seed, then the save, both before the check command runs (never after it). */
export function declaredSeedSteps(declaration: ActionsDeclaration | undefined) {
  const cache = declaration?.cache;
  if (!cache || !cacheSeedPresets(cache)) return '';
  const when = `steps.forge-deps.outputs.cache-hit != 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`;
  return (
    `      - if: ${when}\n        timeout-minutes: 15\n        run: node -e "$FORGE_SEED_PROGRAM" . ${q(cacheSeedPresets(cache))}\n` +
    `        env:\n          FORGE_SEED_PROGRAM: |\n${DEPS_SEED_PROGRAM.split('\n')
      .filter(Boolean)
      .map(line => `            ${line}\n`)
      .join('')}` +
    `      - if: ${when}\n        uses: actions/cache/save@${CACHE_SHA}\n        with:\n${cachePathInput(cache)}` +
    `          key: \${{ steps.forge-deps.outputs.cache-primary-key }}\n`
  );
}
const cachePathInput = (cache: ActionsCache) =>
  `          path: |\n${cachePaths(cache)
    .map(path => `            ${path}\n`)
    .join('')}`;
