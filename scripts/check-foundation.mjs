// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDependencyLicenses } from './render-dependency-licenses.mjs';
import { localPathFindings } from './check-local-paths.mjs';
import { idleQueryFindings } from './check-idle-queries.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};
const read = path => readFileSync(resolve(root, path), 'utf8');
const json = path => JSON.parse(read(path));
const skip = new Set([
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
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (skip.has(e.name)) return [];
    const path = resolve(dir, e.name);
    return e.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(root);
for (const file of files) {
  errors.push(...localPathFindings(relative(root, file), readFileSync(file)));
  if (['.ts', '.tsx'].includes(extname(file)))
    errors.push(...idleQueryFindings(relative(root, file), readFileSync(file, 'utf8')));
  if (extname(file) === '.json') {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${relative(root, file)}: ${error.message}`);
    }
  }
  if (extname(file) !== '.md') continue;
  const text = readFileSync(file, 'utf8');
  // Current foundation uses inline Markdown links; external URLs/anchors are intentionally not fetched.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    check(existsSync(resolve(dirname(file), path)), `${relative(root, file)}: missing link ${target}`);
  }
  check(text.endsWith('\n'), `${relative(root, file)}: missing final newline`);
}

check(
  read('docs/dependency-licenses.md') === renderDependencyLicenses(json('package-lock.json')),
  'Dependency license inventory is stale; run node scripts/render-dependency-licenses.mjs',
);

for (const path of [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/forge.mdc',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'LICENSE.md',
  'LICENSE-Apache-2.0.txt',
  'LICENSE-AGPL-3.0-only.txt',
]) {
  check(
    existsSync(resolve(root, path)) && statSync(resolve(root, path)).size > 0,
    `Missing foundation file ${path}`,
  );
}
for (const path of ['CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules/forge.mdc']) {
  check(read(path).includes('AGENTS.md'), `${path}: must reference canonical AGENTS.md`);
}

if (errors.length) {
  console.error(errors.map(e => `ERROR: ${e}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Foundation checks passed: ${files.length} files; JSON parses, Markdown links resolve, license inventory is current, no machine-specific home paths.`,
  );
  console.log(
    'Application behavior, external URLs and authenticated/local runtime integration are not tested by this command.',
  );
}
