// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// SPDX header guard (Item ffb6cc49): every original JS/TS, CSS, Python and shell source starts with
// `SPDX-License-Identifier: AGPL-3.0-only` and the owner's copyright line, before any import (an
// optional shebang may precede them). Apache-2.0 is no longer a project licence. Agents adding an import
// at line 1 pushed the header below imports in ~470 files (f44ac5e0). `--fix` moves, adds or converts it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreQueuePath } from './core-queue-paths.mjs';

export const SPDX_SOURCE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
// Other kinds carrying the header, each with its comment syntax. Fixtures stay byte-exact test inputs.
const COMMENT = { '.css': ['/* ', ' */'], '.py': ['# ', ''], '.sh': ['# ', ''] };
export const COPYRIGHT = 'Copyright 2026 Ferdinando Valsecchi';
export const LICENSE_ID = 'AGPL-3.0-only';
// Convex writes these (convex/_generated/ and each component's _generated/); they are regenerated on every codegen. Vendored third-party notices keep their own text.
// The brand mark styles and component stay all-rights-reserved (web/src/assets/NOTICE.md).
// Temporary: core queue paths (Guard 4, scripts/core-queue-paths.mjs) need a replay proof and review per path
// for any edit, so their headers move in their own Item; the exemption goes away with it (Item ffb6cc49).
const EXEMPT =
  /^(?:(?:[^/]+\/)*_generated\/|docs\/vendor-notices\/|node_modules\/|web\/src\/ui\/(?:mark\.css|brand\.tsx)$)/;
const exempt = path => EXEMPT.test(path) || coreQueuePath(path);

const wrap = path => COMMENT[extname(path)] ?? ['// ', ''];
const spdxLine = path => `${wrap(path)[0]}SPDX-License-Identifier: ${LICENSE_ID}${wrap(path)[1]}`;
const copyLine = path => `${wrap(path)[0]}${COPYRIGHT}${wrap(path)[1]}`;
const APACHE = /SPDX-License-Identifier:\s*Apache-2\.0\b/;
const SEARCH_LINES = 60; // a misplaced header sits among the first imports, never deep in the file

export const spdxApplies = path =>
  !exempt(path) &&
  (SPDX_SOURCE.has(extname(path)) || (extname(path) in COMMENT && !path.startsWith('tests/fixtures/')));
/** Files scanned: header kinds, plus HTML pages (checked only for a leftover Apache-2.0 header). */
export const spdxScanned = path => !exempt(path) && (spdxApplies(path) || extname(path) === '.html');

/** A whole line that is only an SPDX comment in this file kind's syntax (line ending already stripped). */
function headerLine(path, line) {
  const [open, close] = wrap(path);
  const text = line.trim();
  return (
    text.startsWith(open.trim()) &&
    /SPDX-License-Identifier:/.test(text) &&
    (!close || text.endsWith(close.trim()))
  );
}
const eolOf = source => (source.includes('\r\n') ? '\r\n' : '\n');
/** Index of the first SPDX comment line within the first lines, and its line number. */
function findHeader(path, lines) {
  for (let i = 0; i < Math.min(lines.length, SEARCH_LINES); i++) if (headerLine(path, lines[i])) return i;
  return -1;
}

/** One finding naming the file and the rule; never echoes source. */
export function spdxFindings(path, source) {
  if (!spdxScanned(path)) return [];
  if (!spdxApplies(path))
    return APACHE.test(source.split('\n', 3).join('\n'))
      ? [
          `${path}:1: Apache-2.0 header; the project licence is ${LICENSE_ID}. Fix: replace it with ${LICENSE_ID} or run node scripts/check-spdx.mjs --fix`,
        ]
      : [];
  const lines = source.split(/\r?\n/);
  // Only the first line, or the line after a shebang, may hold the header, then the copyright line.
  const start = lines[0].startsWith('#!') ? 1 : 0;
  const fix = 'run node scripts/check-spdx.mjs --fix';
  if (lines[start] === spdxLine(path))
    return lines[start + 1] === copyLine(path)
      ? []
      : [`${path}:${start + 2}: line after the SPDX header must be "${copyLine(path)}"; ${fix}`];
  const at = findHeader(path, lines);
  if (at === start && APACHE.test(lines[at]))
    return [
      `${path}:${at + 1}: Apache-2.0 header; the project licence is ${LICENSE_ID}. One-line fix: make line ${at + 1} "${spdxLine(path)}" (or ${fix})`,
    ];
  return [
    at >= 0
      ? `${path}:${at + 1}: SPDX header must be the first line (after any shebang), before imports, as "${spdxLine(path)}"; ${fix}`
      : `${path}:1: missing SPDX header (${spdxLine(path)}); ${fix}`,
  ];
}

/** Returns the source with the AGPL header and copyright line first (after any shebang); other lines stay. */
export function fixSpdx(source, path = 'x.ts') {
  const eol = eolOf(source);
  const lines = source.split(/\r?\n/);
  const at = findHeader(path, lines);
  if (at >= 0) lines.splice(at, 1);
  const copyAt = lines.findIndex((line, i) => i < SEARCH_LINES && line === copyLine(path));
  if (copyAt >= 0) lines.splice(copyAt, 1);
  const start = lines[0].startsWith('#!') ? 1 : 0;
  lines.splice(start, 0, spdxLine(path), copyLine(path));
  return lines.join(eol);
}

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'web-dist',
  'hosted-web-dist',
  'build',
  'coverage',
  '.next',
  '.forge',
  'private-artifacts',
]);
function* sources(root, dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* sources(root, path);
    else if (entry.isFile() && spdxScanned(relative(root, path).split('\\').join('/'))) yield path;
  }
}

function main(args) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fix = args.includes('--fix');
  let count = 0;
  for (const file of sources(root)) {
    const path = relative(root, file),
      source = readFileSync(file, 'utf8');
    const findings = spdxFindings(path, source);
    if (!findings.length) continue;
    count++;
    if (fix)
      writeFileSync(
        file,
        spdxApplies(path.split('\\').join('/'))
          ? fixSpdx(source, path)
          : source.replace(/(SPDX-License-Identifier:\s*)Apache-2\.0/, `$1${LICENSE_ID}`),
      );
    else console.error(`ERROR: ${findings[0]}`);
  }
  console.log(`check-spdx: ${count} file(s) ${fix ? 'fixed' : 'failing'}`);
  return fix || !count ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
