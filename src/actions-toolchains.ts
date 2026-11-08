// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { safeRelative } from './safe-relative.js';

/** Optional `actionsToolchains` and `actionsCache` of a check definition
 * (docs/operations/github-actions-checks.md#toolchains-and-dependency-cache). Only these
 * pinned actions, one per tool, and these cache presets exist; nothing else can be declared.
 * Values are validated here, so generated YAML never carries an expression or a quote. */
export const ACTIONS_TOOLS = ['go', 'python', 'java', 'dotnet', 'rust'] as const;
export type ActionsTool = (typeof ACTIONS_TOOLS)[number];
/** Full commit SHAs of released tags at least two weeks old when pinned. */
export const TOOLCHAIN_ACTIONS: Record<Exclude<ActionsTool, 'rust'>, string> = {
  go: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
  python: 'actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0',
  java: 'actions/setup-java@b843ebf9b913146b38da2eaa7aeddf76074ae1ad # v6.1.0',
  dotnet: 'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0',
};
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
/** Dependency download caches only, never build output or source. Lockfile globs are the
 * defaults when the declaration names none. */
export const CACHE_PRESETS = {
  go: { paths: ['~/go/pkg/mod', '~/.cache/go-build'], lockfiles: ['**/go.sum'] },
  cargo: {
    paths: ['~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db'],
    lockfiles: ['**/Cargo.lock'],
  },
  pip: { paths: ['~/.cache/pip'], lockfiles: ['**/requirements*.txt'] },
  uv: { paths: ['~/.cache/uv'], lockfiles: ['**/uv.lock'] },
  poetry: { paths: ['~/.cache/pypoetry'], lockfiles: ['**/poetry.lock'] },
  maven: { paths: ['~/.m2/repository'], lockfiles: ['**/pom.xml'] },
  gradle: {
    paths: ['~/.gradle/caches', '~/.gradle/wrapper'],
    lockfiles: ['**/*.gradle*', '**/gradle-wrapper.properties'],
  },
  nuget: {
    paths: ['~/.nuget/packages'],
    lockfiles: ['**/packages.lock.json', '**/*.csproj', '**/Directory.Packages.props'],
  },
  npm: { paths: ['~/.npm'], lockfiles: ['**/package-lock.json'] },
  pnpm: { paths: ['~/.local/share/pnpm/store'], lockfiles: ['**/pnpm-lock.yaml'] },
  yarn: { paths: ['~/.cache/yarn'], lockfiles: ['**/yarn.lock'] },
} as const;
export type CachePreset = keyof typeof CACHE_PRESETS;
/** Literal for schema snapshots (scripts/schema-snapshot.mjs); a test keeps it equal to the keys. */
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
] as const satisfies readonly CachePreset[];
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
  })
  .strict()
  .refine(t => (t.version === undefined) !== (t.versionFile === undefined), {
    message: 'Declare exactly one of version or versionFile.',
  })
  .refine(t => t.distribution === undefined || t.tool === 'java', {
    message: 'Only java takes a distribution.',
  })
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
  .max(5) // ACTIONS_TOOLS.length; schema snapshots read literals only
  .refine(list => unique(list.map(t => t.tool)), { message: 'Declare each tool once.' });
export const actionsCacheSchema = z
  .object({
    presets: z
      .array(z.enum(presetNames))
      .min(1)
      .max(11) // CACHE_PRESET_NAMES.length
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
const rustDirectory = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');

/** Literal steps for a workflow committed with the check's source (the export path):
 * values are inlined, so the Candidate checkout supplies version files and lockfiles. */
export function declaredSetupSteps(declaration: ActionsDeclaration | undefined) {
  if (!declaration) return '';
  let text = '';
  for (const t of declaration.toolchains ?? []) {
    if (t.tool === 'rust') {
      text += t.version
        ? `      - run: rustup toolchain install --profile minimal ${q(t.version)} && rustup default ${q(t.version)}\n`
        : `      - run: rustup toolchain install\n        working-directory: ${q(rustDirectory(t.versionFile!))}\n`;
      continue;
    }
    text += `      - uses: ${TOOLCHAIN_ACTIONS[t.tool]}\n        with:\n`;
    if (t.tool === 'go')
      text += `${t.version ? `          go-version: ${q(t.version)}` : `          go-version-file: ${q(t.versionFile!)}`}\n          cache: false\n`;
    else if (t.tool === 'python')
      text += t.version
        ? `          python-version: ${q(t.version)}\n`
        : `          python-version-file: ${q(t.versionFile!)}\n`;
    else if (t.tool === 'java')
      text +=
        `          distribution: ${q(t.distribution ?? 'temurin')}\n` +
        (t.version
          ? `          java-version: ${q(t.version)}\n`
          : `          java-version-file: ${q(t.versionFile!)}\n`);
    else
      text += t.version
        ? `          dotnet-version: ${q(t.version)}\n`
        : `          global-json-file: ${q(t.versionFile!)}\n`;
  }
  const cache = declaration.cache;
  if (cache)
    text +=
      `      - id: forge-deps\n        uses: actions/cache/restore@${CACHE_SHA}\n        with:\n${cachePathInput(cache)}` +
      `          key: ${cacheKeyPrefix(cache)}-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles(${cacheLockfiles(
        cache,
      )
        .map(glob => `'${glob}'`)
        .join(', ')}) }}\n`;
  return text;
}
/** Saved only by a run on the default branch and only after the check passed. */
export function declaredSaveSteps(declaration: ActionsDeclaration | undefined) {
  const cache = declaration?.cache;
  if (!cache) return '';
  return (
    `      - if: steps.forge-deps.outputs.cache-hit != 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\n` +
    `        uses: actions/cache/save@${CACHE_SHA}\n        with:\n${cachePathInput(cache)}` +
    `          key: \${{ steps.forge-deps.outputs.cache-primary-key }}\n`
  );
}
const cachePathInput = (cache: ActionsCache) =>
  `          path: |\n${cachePaths(cache)
    .map(path => `            ${path}\n`)
    .join('')}`;
