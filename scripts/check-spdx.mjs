// SPDX-License-Identifier: Apache-2.0
// SPDX header guard: every tracked JS/TS source starts with its license line, before any
// import (an optional shebang may precede it). Agents adding an import at line 1 pushed the
// header below imports in ~470 files (f44ac5e0). `--fix` moves or adds the header in place.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SPDX_SOURCE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
// Convex writes these; they are regenerated on every codegen.
const GENERATED = /^convex\/_generated\//;
const HEADER = /^(?:\/\/|\/\*)\s*SPDX-License-Identifier:\s*(?:Apache-2\.0|AGPL-3\.0-only)\b/;
const ANY_HEADER = /^[ \t]*(?:\/\/|\/\*)\s*SPDX-License-Identifier:[^\n]*\n?/m;
const DEFAULT_LINE = '// SPDX-License-Identifier: Apache-2.0';

export const spdxApplies = path => SPDX_SOURCE.has(extname(path)) && !GENERATED.test(path);

/** One finding naming the file and the rule; never echoes source. */
export function spdxFindings(path, source) {
  if (!spdxApplies(path)) return [];
  // Only the first line, or the line after a shebang, may hold the header.
  const start = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  if (start >= 0 && HEADER.test(source.slice(start, start + 120))) return [];
  const where = ANY_HEADER.exec(source);
  return [
    where
      ? `${path}:${source.slice(0, where.index).split('\n').length}: SPDX header must be the first line (after any shebang), before imports; run node scripts/check-spdx.mjs --fix`
      : `${path}:1: missing SPDX header (// SPDX-License-Identifier: Apache-2.0); run node scripts/check-spdx.mjs --fix`,
  ];
}

/** Returns the source with its existing header moved to the top, or the default added. */
export function fixSpdx(source) {
  const where = ANY_HEADER.exec(source);
  const header = where ? where[0].trim() : DEFAULT_LINE;
  const rest = where ? source.slice(0, where.index) + source.slice(where.index + where[0].length) : source;
  if (rest.startsWith('#!')) {
    const end = rest.indexOf('\n');
    return end < 0 ? `${rest}\n${header}\n` : `${rest.slice(0, end + 1)}${header}\n${rest.slice(end + 1)}`;
  }
  return `${header}\n${rest}`;
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
    else if (entry.isFile() && spdxApplies(relative(root, path))) yield path;
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
    if (fix) writeFileSync(file, fixSpdx(source));
    else console.error(`ERROR: ${findings[0]}`);
  }
  console.log(`check-spdx: ${count} file(s) ${fix ? 'fixed' : 'failing'}`);
  return fix || !count ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
