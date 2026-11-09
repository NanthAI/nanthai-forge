// SPDX-License-Identifier: Apache-2.0
// Guard (Issue 63d241db, audits 1bb0d8e6 and 875a57cc): no new Forge-only or JS-only fast path in product code. Every hit of a
// literal that hid one before must be listed in docs/forge-only-rules.md with why and what other
// repositories get; a new hit, a changed count or a stale row fails the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const folder = String.raw`(?:src|web|web\\\/src|convex|netlify|scripts|tests|dist)`;
const listed = String.raw`'(?:src|web|web\/src|convex|netlify|scripts|tests|dist)\/?'`;
const RULES = {
  'check-entry': /scripts\/forge-check\.mjs/,
  'standard-from-args': /\.args\[0\]\s*===|\.args\.length\s*===\s*1\b|executable\s*===\s*['"]node['"]/,
  // A regular expression anchored on `^tests/`, a `startsWith('tests/')` prefix test, or a `.test.mjs` string.
  'tests-folder': /\/\^tests\\\/|startsWith\(['"`]tests\/|\.test\\?\.mjs['"$\/]/,
  // A `docs/` prefix test: Forge's own documentation folder, not every repository's.
  'docs-folder': /\/\^docs\\\/|startsWith\(['"`]docs\//,
  'forge-folders': new RegExp(
    String.raw`\((?:\?:)?${folder}(?:\|[^)]*)?\|${folder}\b|\[\s*${listed},\s*${listed}`,
  ),
  'npm-lockfile': /package-lock\.json/,
  'node-test': /['"`]--test['"`]/,
};
// JS/npm-only assumptions (audit 875a57cc), scanned in src/, convex/ and the shipped scripts.
const buildFolder = String.raw`['"](?:dist|build|coverage)\/?['"]`;
const PRODUCT_RULES = {
  // A folder list or alternation with `dist`, `build` or `coverage`, as used to skip or drop paths.
  'build-folders': new RegExp(
    String.raw`\[[^\]]*(?:,\s*${buildFolder}|${buildFolder}\s*,)|^\s*${buildFolder},?\s*$|\(\?:(?:[\w.\\\/-]+\|)*(?:dist|build|coverage)(?:\|[\w.\\\/-]+)*\)`,
  ),
  // A JavaScript/TypeScript extension pattern such as /\.[cm]?[jt]sx?$/, as used to gate a feature.
  'js-extension': /\[cm\]\?\[jt\]s|\[jt\]sx/,
  // package.json read as a config source.
  'package-json-config': /['"`]package\.json['"`]/,
};

// Ecosystem knowledge lives in one registry (Issue 9c0ece48, src/ecosystems.ts). The names come from
// the registry itself, so a new entry's lockfiles, folders and extensions are guarded too.
const registry = await import('../dist/ecosystems.js');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = values =>
  [...new Set(values)]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
// Also in a regular expression (`Cargo\\.lock`).
const lockfileNames = words(registry.pinLockfiles().filter(name => name !== 'package-lock.json')).replace(
  /\\\./g,
  String.raw`\\?\.`,
);
// Plain words (`target`, `build`, `bin`) name many other things; only distinctive names
// (`.venv`, `__pycache__`, `node_modules`, `site-packages`) mark a folder list.
const folderNames = words(
  [
    ...registry.regenerableDirs(),
    ...registry.dependencyDirs(),
    ...registry.buildDirs(),
    ...registry.ECOSYSTEMS.flatMap(entry => [
      ...(entry.nonSourceDirs ?? []),
      ...(entry.projectOutputDirs?.dirs ?? []),
    ]),
  ].filter(name => !/^[a-z]+$/.test(name)),
);
const extensionNames = words(
  registry.ECOSYSTEMS.flatMap(entry => (entry.code ?? '').split('|')).filter(ext => /^\w+$/.test(ext)),
);
const dirName = name => String.raw`(?<![\w.-])(?${name}${folderNames})(?![\w.-])`;
/** Code, not prose: comments that name a lockfile or folder are not lists. */
const code = pattern => ({ test: line => !/^\s*(?:\/\/|\/?\*)/.test(line) && pattern.test(line) });
const ECOSYSTEM_RULES = {
  // A registry lockfile name (npm's own is `npm-lockfile`), quoted or in a regular expression.
  'ecosystem-lockfile': code(new RegExp(String.raw`(?<![\w-])(?:${lockfileNames})(?![\w])`)),
  // Two different registry folder names on one line, or one alone as a list row: a folder list.
  'ecosystem-folders': code(
    new RegExp(
      String.raw`${dirName('<first>')}.*(?!\k<first>(?![\w.-]))${dirName(':')}|^\s*['"](?:${folderNames})['"],?\s*$`,
    ),
  ),
  // Two registry extensions joined as alternatives (`py|go`), or a `[/\.ext$/, …]` table row.
  'ecosystem-extensions': code(
    new RegExp(
      String.raw`(?<![\w])(?:${extensionNames})\??\|(?:${extensionNames})(?![\w])|^\s*\[\/\\\.\w+\??\$\/,`,
    ),
  ),
};
/** Forge-only rules still apply to the registry; ecosystem and JS/npm literals are its job. */
const FORGE_RULES = Object.fromEntries(
  Object.entries(RULES).filter(([rule]) => rule !== 'npm-lockfile' && rule !== 'node-test'),
);
/** The registry itself is the one place these lists may live. */
const REGISTRY = 'src/ecosystems.ts';

/** Product code: src/, convex/ (not generated) and the scripts the package ships. */
function productFiles() {
  const files = [];
  for (const directory of ['src', 'convex'])
    for (const entry of readdirSync(join(repo, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const path = relative(repo, join(entry.parentPath ?? entry.path, entry.name))
        .split('\\')
        .join('/');
      if (!path.includes('/_generated/')) files.push(path);
    }
  const shipped = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).files;
  for (const path of shipped) if (/^scripts\/[^*]+\.mjs$/.test(path)) files.push(path);
  return files.sort();
}

/** `file rule` → lines that match, one per line. */
function scanHits(files, read, rules = { ...RULES, ...PRODUCT_RULES }) {
  const hits = new Map();
  for (const file of files) {
    const lines = read(file).split('\n');
    for (const [rule, pattern] of Object.entries(rules)) {
      const count = lines.filter(line => pattern.test(line)).length;
      if (count) hits.set(`${file} ${rule}`, count);
    }
  }
  return hits;
}

function allowlist() {
  const text = readFileSync(join(repo, 'docs/forge-only-rules.md'), 'utf8');
  const section = text.split('\n## Allowlist\n')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map();
  for (const line of section.split('\n')) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| (\d+) \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (!row) continue;
    const [, file, rule, hits, why, others] = row;
    assert(!rows.has(`${file} ${rule}`), `duplicate allowlist row: ${file} ${rule}`);
    assert(
      rule in RULES || rule in PRODUCT_RULES || rule in ECOSYSTEM_RULES,
      `unknown rule in docs/forge-only-rules.md: ${rule}`,
    );
    assert(why.trim().length >= 10 && others.trim().length >= 1, `explain ${file} ${rule}`);
    rows.set(`${file} ${rule}`, Number(hits));
  }
  return rows;
}

test('each rule finds the literal it names and nothing else', () => {
  const samples = {
    'check-entry': "const entry = 'scripts/forge-check.mjs';",
    'standard-from-args': "const standard = check.args[0] === 'x';",
    'tests-folder': String.raw`const test = path => /^tests\/[^/]+\.test\.mjs$/.test(path);`,
    'docs-folder': "const docs = path.startsWith('docs/');",
    'forge-folders': String.raw`const product = /^(?:src|web\/src|convex|netlify)\//;`,
    'npm-lockfile': "readFileSync('package-lock.json');",
    'node-test': "spawn(node, ['--test', file]);",
    'build-folders': "const skip = new Set(['node_modules', 'dist']);",
    'js-extension': String.raw`if (!/\.[cm]?[jt]sx?$/.test(path)) return;`,
    'package-json-config': "const manifest = files.get('package.json');",
  };
  for (const [rule, line] of Object.entries(samples))
    assert.deepEqual(
      [...scanHits(['src/x.ts'], () => line).keys()],
      [`src/x.ts ${rule}`],
      `${rule}: ${line}`,
    );
  // The other forms of a tests-folder gate: a prefix test and a `.test.mjs` string literal.
  for (const line of [
    "const test = path => path.startsWith('tests/');",
    'const test = path => path.startsWith("tests/");',
    "const test = path => path.endsWith('.test.mjs');",
    "const glob = 'tests/*.test.mjs';",
  ])
    assert.deepEqual([...scanHits(['src/x.ts'], () => line).keys()], ['src/x.ts tests-folder'], line);
  // The list form and a plain folder name in prose are distinct.
  assert.equal(scanHits(['src/x.ts'], () => "const dirs = ['src', 'web', 'convex'];").size, 1);
  // Shipped scripts are product code: every rule applies to them too.
  assert.deepEqual(
    [...scanHits(['scripts/x.mjs'], () => "files.get('package.json');").keys()],
    ['scripts/x.mjs package-json-config'],
  );
  // Other string shapes that name Forge's test layout (M2-08, M2-16).
  for (const line of [
    "if (path.startsWith('tests/')) return;",
    "const spec = 'run.test.mjs';",
    String.raw`const spec = /\.test\.mjs$/;`,
  ])
    assert.deepEqual([...scanHits(['src/x.ts'], () => line).keys()], ['src/x.ts tests-folder'], line);
  for (const line of [
    "if (path.startsWith('src/')) return;",
    "const glob = 'tests/**/*.test.ts';",
    "if (name.endsWith('.test.ts')) return;",
    'const glob = `packages/*/src/**/*.test.ts`;',
    '/^(?:packages|apps)\\//.test(path);',
    "const lock = 'pnpm-lock.yaml';",
    "const entry = join(root, 'dist', 'cli-entry.js');",
    "type Coverage = Records['coverage'];",
    'const ok = /\\.(?:py|go|rs)$/.test(path);',
  ])
    assert.equal(scanHits(['src/x.ts'], () => line).size, 0, line);
});

test('product code has no Forge-only literal that docs/forge-only-rules.md does not list', () => {
  const read = file => readFileSync(join(repo, file), 'utf8');
  const others = productFiles().filter(file => file !== REGISTRY);
  const hits = new Map([
    ...scanHits(others, read),
    ...scanHits(others, read, ECOSYSTEM_RULES),
    ...scanHits([REGISTRY], read, FORGE_RULES),
  ]);
  const rows = allowlist();
  const unlisted = [...hits].filter(([key]) => !rows.has(key)).map(([key, n]) => `${key} (${n})`);
  const changed = [...hits]
    .filter(([key, n]) => rows.has(key) && rows.get(key) !== n)
    .map(([key, n]) => `${key}: ${n} hits, listed ${rows.get(key)}`);
  const stale = [...rows.keys()].filter(key => !hits.has(key));
  assert.deepEqual(
    { unlisted, changed, stale },
    { unlisted: [], changed: [], stale: [] },
    'Route a Forge-only branch through isStandardForgeCheck (src/standard-check.ts) or the project ' +
      'test runner (src/project-test-runner.ts). Only Forge’s own recipe is listed in ' +
      'docs/forge-only-rules.md, with why and what other repositories get; update its count or ' +
      'remove a stale row.',
  );
});

test('ecosystem rules find literal lists outside the registry, not prose or one name', () => {
  const hit = line => [...scanHits(['src/x.ts'], () => line, ECOSYSTEM_RULES).keys()];
  for (const [line, rule] of [
    ["const LOCKS = ['Cargo.lock', 'go.sum'];", 'ecosystem-lockfile'],
    [String.raw`const lock = /(?:^|\/)(?:Cargo\.lock|go\.sum)$/;`, 'ecosystem-lockfile'],
    ["  'Gemfile.lock',", 'ecosystem-lockfile'],
    ["const skip = new Set(['.venv', '__pycache__']);", 'ecosystem-folders'],
    ["  '__pycache__',", 'ecosystem-folders'],
    [String.raw`const code = /\.(?:py|go|rs)$/;`, 'ecosystem-extensions'],
    [String.raw`  [/\.py$/, 'python'],`, 'ecosystem-extensions'],
  ])
    assert.deepEqual(hit(line), [`src/x.ts ${rule}`], line);
  for (const line of [
    '// uv.lock and poetry.lock pick the runner',
    ' * bun.lock: the keys of its workspaces object',
    "if (key.startsWith('node_modules/') && !key.includes('/node_modules/')) return;",
    "const target = 'target';",
    String.raw`if (/\.go$/.test(path)) return goFacts(path);`,
    "const lock = 'package-lock.json';",
  ])
    assert.deepEqual(hit(line), [], line);
});

test('the registry is pure data and every consumer reads it: a new entry is picked up everywhere', async () => {
  // Convex (V8) and the CLI both load it: only type imports.
  const source = readFileSync(join(repo, REGISTRY), 'utf8');
  assert.deepEqual(source.match(/^import (?!type ).*$/gm), null);
  const [lockfiles, toolchains, codeFiles, dependencyDirs, languages] = await Promise.all(
    ['project-lockfile', 'actions-toolchains', 'code-files', 'dependency-dirs', 'languages'].map(
      name => import(`../dist/${name}.js`),
    ),
  );
  // Consumers equal the registry's derivations.
  assert.deepEqual([...lockfiles.PROJECT_LOCKFILES], registry.pinLockfiles());
  assert.deepEqual(new Set(toolchains.CACHE_PRESET_NAMES), new Set(registry.cachePresets().keys()));
  assert.deepEqual(new Set(toolchains.ACTIONS_TOOLS), new Set(registry.actionsTools()));
  for (const entry of registry.ECOSYSTEMS) {
    for (const ext of (entry.code ?? '').split('|').filter(ext => /^\w+$/.test(ext)))
      assert.equal(codeFiles.codeFileName.exec(`name.${ext}`)?.[1], 'name', `${entry.id} .${ext}`);
    for (const dir of entry.regenerableDirs ?? []) assert.ok(dependencyDirs.ECOSYSTEM_DIRS.has(dir), dir);
    for (const { language } of entry.codeMap ?? [])
      assert.ok(
        registry.codeMapLanguages().some(([, found]) => found === language),
        language,
      );
  }
  // src/junit-report.ts ships self-contained in the check payload, so it writes the list out.
  const { JUNIT_CODE_FILE } = await import('../dist/junit-report.js');
  assert.equal(JUNIT_CODE_FILE.source, registry.codeExtensionPattern().source);
  assert.equal(JUNIT_CODE_FILE.flags, registry.codeExtensionPattern().flags);
  assert.equal(languages.sourceLanguage('a/b.pyi'), undefined);
  assert.equal(languages.sourceLanguage('a/b.mts'), 'typescript');

  // A synthetic ecosystem: one entry reaches every derived table.
  const extra = {
    id: 'zz',
    code: 'zz|zzi',
    managers: [{ name: 'zzpm', manifests: ['zz.toml'], lockfiles: ['zz.lock'], unpinned: ['zz.state'] }],
    regenerableDirs: ['_zzbuild'],
    dependencyDirs: ['.zzdeps'],
    buildDirs: ['.zzout'],
    projectOutputDirs: { dirs: ['zzbin'], beside: 'zzproj' },
    nonSourceDirs: ['zzvendor'],
    actions: { tool: 'zz', cache: { zz: { paths: ['~/.zz'], lockfiles: ['**/zz.lock'] } } },
    checkEnv: {
      caches: [['ZZ_CACHE', 'check-zz-cache']],
      homes: [{ name: 'ZZ_HOME', leaf: 'check-zz-home', run: 'zz-home', content: ['pkgs'] }],
      toolchains: [['ZZUP_HOME', ['.zzup']]],
    },
    mergeGate: { extensions: 'zz', grammar: 'json' },
    importFixup: { extensions: 'zz', language: 'go' },
    codeMap: [{ extensions: 'zz', language: 'go' }],
    moduleGraph: [{ extensions: 'zz', language: 'go' }],
  };
  const entries = [...registry.ECOSYSTEMS, extra];
  assert.equal(registry.pinLockfiles(entries).at(-1), 'zz.lock');
  assert.ok(registry.knownLockfiles(entries).includes('zz.state'));
  assert.deepEqual(registry.managerLockfiles(entries).get('zzpm'), ['zz.lock']);
  assert.ok(registry.manifestNames(entries).has('zz.toml'));
  assert.ok(registry.regenerableDirs(entries).has('_zzbuild'));
  assert.ok(
    registry.dependencyDirs(entries).has('.zzdeps') && registry.dependencyDirs(entries).has('_zzbuild'),
  );
  assert.ok(registry.buildDirs(entries).has('.zzout'));
  assert.ok(registry.projectOutputDirs(entries).some(o => o.dirs.has('zzbin') && o.beside.test('a.ZZPROJ')));
  assert.ok(registry.nonSourceDirPattern(entries).test('zzvendor/a.zz'));
  assert.equal(registry.codeFilePattern(entries).exec('x.zzi')?.[1], 'x');
  assert.ok(registry.codeExtensionPattern(entries).test('x.ZZ'));
  assert.ok(registry.codeFileOf('zz', entries).test('x.zz'));
  for (const table of ['mergeGates', 'importFixups', 'codeMapLanguages', 'moduleGraphLanguages'])
    assert.ok(
      registry[table](entries).some(([pattern]) => pattern.test('a/b.zz')),
      table,
    );
  assert.deepEqual(registry.cachePresets(entries).get('zz').paths, ['~/.zz']);
  assert.ok(registry.actionsTools(entries).includes('zz'));
  assert.ok(registry.checkEnvCaches(entries).some(([name]) => name === 'ZZ_CACHE'));
  assert.ok(registry.checkEnvHomes(entries).some(home => home.name === 'ZZ_HOME'));
  assert.ok(registry.checkEnvToolchains(entries).some(([name]) => name === 'ZZUP_HOME'));
});

// Native-code fixtures (Issue 345ebcb9): C/C++, Zig and Delphi each have one small fixture repository
// under tests/fixtures/ecosystems/. These assertions read it through the real consumers, so they fail
// when the registry entry is missing.
function fixtureFiles(id) {
  const root = fileURLToPath(new URL(`./fixtures/ecosystems/${id}/`, import.meta.url));
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    // Stored as NAME.fixture so Forge's own repository never mistakes a fixture for a real build file.
    files.set(
      relative(root, path)
        .split('\\')
        .join('/')
        .replace(/\.fixture$/, ''),
      readFileSync(path, 'utf8'),
    );
  }
  return files;
}
test('C/C++, Zig and Delphi fixtures are recognised through the registry', async () => {
  const [lockfiles, codeFiles, dependencyDirs, graphModule, runnerModule, toolchains] = await Promise.all(
    [
      'project-lockfile',
      'code-files',
      'dependency-dirs',
      'package-graph',
      'project-test-runner',
      'actions-toolchains',
    ].map(name => import(`../dist/${name}.js`)),
  );
  const stem = path => codeFiles.codeFileName.exec(path)?.[1];
  const graphOf = files => graphModule.buildPackageGraph(files.keys(), path => files.get(path));
  // The repository's own test command (forge.json), or why the whole suite runs.
  const runnerOf = (files, withForgeJson = true) =>
    runnerModule.projectTestRunner(undefined, () => files.keys(), {
      forgeJson: withForgeJson ? files.get('forge.json') : undefined,
      packages: () => graphOf(files),
    });
  const output = name =>
    registry
      .projectOutputDirs()
      .some(candidate => candidate.dirs.has(name) && candidate.beside.test('A.dproj'));

  const c = fixtureFiles('c');
  assert.equal([...c.keys()].find(lockfiles.isProjectLockfile), 'conan.lock');
  for (const [path, name] of [
    ['tests/greeter_test.cpp', 'tests/greeter_test'],
    ['src/greeter.c', 'src/greeter'],
    ['include/greeter.h', 'include/greeter'],
    ['a/b.hxx', 'a/b'],
  ])
    assert.equal(stem(path), name, path);
  for (const dir of ['cmake-build-debug', 'cmake-build-release', 'builddir', 'vcpkg_installed'])
    assert.ok(dependencyDirs.ECOSYSTEM_DIRS.has(dir), dir);
  assert.ok(dependencyDirs.inDependencyDirectory('vcpkg_installed/x64-linux/lib/libfmt.a'));
  assert.ok(registry.knownLockfiles().includes('vcpkg-configuration.json'));
  const cGraph = graphOf(c);
  assert.equal(cGraph.status, 'unknown');
  assert.match(cGraph.reason, /CMakeLists\.txt.*conanfile\.txt.*whole suite/);
  assert.deepEqual(runnerOf(c).runner.command.slice(0, 1), ['ctest']);
  const noDeclaration = new Map([...c].filter(([path]) => path !== 'forge.json'));
  assert.match(runnerOf(noDeclaration, false).reason, /package graph unknown: .*whole suite/);
  assert.equal(registry.actionsTools().includes('cmake'), true);
  assert.deepEqual(
    [...registry.cachePresets().keys()].filter(name => /vcpkg|conan/.test(name)),
    ['vcpkg', 'conan'],
  );

  const zig = fixtureFiles('zig');
  assert.equal([...zig.keys()].find(lockfiles.isProjectLockfile), 'build.zig.zon');
  assert.equal(stem('src/greeter.zig'), 'src/greeter');
  assert.ok(dependencyDirs.ECOSYSTEM_DIRS.has('.zig-cache') && dependencyDirs.ECOSYSTEM_DIRS.has('zig-out'));
  assert.match(graphOf(zig).reason, /build\.zig, build\.zig\.zon.*whole suite/);
  assert.deepEqual(runnerOf(zig).runner.command, ['zig', 'build', 'test']);
  assert.equal(toolchains.CACHE_SEEDS.zig.command.join(' '), 'zig build --fetch');
  assert.equal(registry.actionsTools().includes('zig'), true);

  // Delphi stays light: recognised files and regenerable folders, no lockfile, no toolchain setup.
  const delphi = fixtureFiles('delphi');
  assert.equal([...delphi.keys()].find(lockfiles.isProjectLockfile), undefined);
  for (const [path, name] of [
    ['GreeterUnit.pas', 'GreeterUnit'],
    ['Greeter.dpr', 'Greeter'],
    ['MainForm.dfm', 'MainForm'],
    ['tests/GreeterTests.pas', 'tests/GreeterTests'],
  ])
    assert.equal(stem(path), name, path);
  assert.ok(
    dependencyDirs.ECOSYSTEM_DIRS.has('__history') && dependencyDirs.ECOSYSTEM_DIRS.has('__recovery'),
  );
  assert.ok(output('Win32') && output('Win64'));
  // `Win32` beside no project file is not build output (it only counts beside a .dproj).
  assert.ok(
    !registry
      .projectOutputDirs()
      .some(candidate => candidate.beside.test('A.csproj') && candidate.dirs.has('Win32')),
  );
  assert.equal(graphOf(delphi).status, 'unknown');
  assert.deepEqual(runnerOf(delphi).runner.command, ['build-and-test.cmd']);
  assert.ok(!toolchains.ACTIONS_TOOLS.some(tool => /delphi|pascal/.test(tool)));
});
