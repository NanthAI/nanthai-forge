// SPDX-License-Identifier: Apache-2.0
// Frozen-count allowlist for the test-hygiene lint rules (guard 7, Item 611a1795). The rules in
// scripts/lint/forge-plugin.mjs (test-no-fixed-sleep, test-no-retries, test-no-raised-timeout,
// test-no-unsignaled-polling, test-no-implicit-date) let each tests/ file keep the count it has in
// tests/test-hygiene-allowlist.json and no more. This script writes and lowers that file:
//
//   node scripts/lint-test-hygiene.mjs --init     write the first allowlist from today's counts; refuses to overwrite
//   node scripts/lint-test-hygiene.mjs --update   lower every entry to the current count, drop deleted files; never raises
//
// Counting runs oxlint itself with an empty allowlist, so the numbers are exactly what the rules report.
// A file above its allowance fails lint: fix it, or (a real exception) raise the entry by hand with the
// reason in the landing note. A file below its allowance fails lint too, until --update lowers the entry.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oxcFiles } from './oxc.mjs';

export const ALLOWLIST = 'tests/test-hygiene-allowlist.json';
const KEYS = {
  'test-no-fixed-sleep': 'sleep',
  'test-no-retries': 'retry',
  'test-no-raised-timeout': 'timeout',
  'test-no-unsignaled-polling': 'poll',
  'test-no-implicit-date': 'date',
};
const ORDER = Object.values(KEYS);

/** Per tests/ file, how many times each rule fires with no allowance: { path: { sleep: n, ... } }. */
export function countOccurrences(root) {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-test-hygiene-'));
  try {
    const empty = join(scratch, 'empty.json');
    writeFileSync(empty, '{"version":1,"files":{}}');
    const files = oxcFiles(root, true).filter(path => path.startsWith('tests/'));
    const result = spawnSync(
      process.execPath,
      ['node_modules/oxlint/bin/oxlint', '--threads', '4', '--format', 'json', ...files],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, FORGE_TEST_HYGIENE_ALLOWLIST: empty },
      },
    );
    if (result.error) throw result.error;
    const counts = {};
    for (const diagnostic of JSON.parse(result.stdout).diagnostics) {
      const key = KEYS[/^forge\(([\w-]+)\)$/.exec(diagnostic.code)?.[1]];
      if (!key) throw new Error(`Unexpected diagnostic ${diagnostic.code} in ${diagnostic.filename}`);
      counts[diagnostic.filename] ??= {};
      counts[diagnostic.filename][key] = (counts[diagnostic.filename][key] ?? 0) + 1;
    }
    return counts;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One line per file, so concurrent edits of different files merge cleanly. */
export function serialize(files) {
  const lines = Object.keys(files)
    .sort()
    .map(
      path =>
        `  ${JSON.stringify(path)}: ${JSON.stringify(Object.fromEntries(ORDER.filter(key => files[path][key] > 0).map(key => [key, files[path][key]])))}`,
    );
  return `{\n"version": 1,\n"files": {\n${lines.join(',\n')}\n}\n}\n`;
}

export function readAllowlist(root) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, ALLOWLIST), 'utf8'));
    return parsed?.version === 1 && parsed.files ? parsed.files : {};
  } catch {
    return {};
  }
}

/** The allowlist lowered to `current` (never raised) and the files still above their entry. */
export function lower(allowed, current) {
  const files = {};
  const above = [];
  for (const [path, entry] of Object.entries(allowed)) {
    const now = current[path];
    if (!now) continue; // Deleted, or no occurrence left.
    const next = {};
    for (const key of ORDER) {
      if ((now[key] ?? 0) > (entry[key] ?? 0))
        above.push(`${path}: ${now[key]} ${key}, allowed ${entry[key] ?? 0}`);
      const value = Math.min(entry[key] ?? 0, now[key] ?? 0);
      if (value > 0) next[key] = value;
    }
    if (Object.keys(next).length) files[path] = next;
  }
  for (const path of Object.keys(current))
    if (!allowed[path]) above.push(`${path}: not in the allowlist, ${JSON.stringify(current[path])}`);
  return { files, above };
}

function main(argv) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const mode = argv[0];
  const target = resolve(root, ALLOWLIST);
  if (mode === '--init') {
    if (existsSync(target)) {
      console.error(`${ALLOWLIST} exists; --init only writes the first allowlist. Use --update to lower it.`);
      return 1;
    }
    const current = countOccurrences(root);
    writeFileSync(target, serialize(current));
    console.log(`Wrote ${ALLOWLIST}: ${Object.keys(current).length} files`);
    return 0;
  }
  if (mode === '--update') {
    const allowed = readAllowlist(root);
    const { files, above } = lower(allowed, countOccurrences(root));
    writeFileSync(target, serialize(files));
    console.log(`Lowered ${ALLOWLIST}: ${Object.keys(allowed).length} -> ${Object.keys(files).length} files`);
    for (const line of above) console.error(`above its allowance: ${line}`);
    return above.length ? 1 : 0;
  }
  console.error('Usage: node scripts/lint-test-hygiene.mjs --init | --update');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
