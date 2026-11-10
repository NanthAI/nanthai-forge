// SPDX-License-Identifier: Apache-2.0
import { workStoreAccessFindings } from './check-work-store-access.mjs';
import { networkBoundaryFindings } from './check-network-boundaries.mjs';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDependencyLicenses } from './render-dependency-licenses.mjs';
import { localPathFindings } from './check-local-paths.mjs';
import { landingModelFindings } from './check-landing-model.mjs';
import { idleQueryFindings } from './check-idle-queries.mjs';
import { recoveryAdviceFindings } from './check-recovery-advice.mjs';
import { actionPinFindings, isWorkflowPath } from './check-action-pins.mjs';
import { candidateStepFindings } from './check-candidate-steps.mjs';
import { spdxFindings } from './check-spdx.mjs';
import { envPrintFindings } from './check-env-print.mjs';
import { readBaseline, scanSet, testSignalFindings } from './check-test-signal.mjs';
import { statusListFindings } from './check-status-lists.mjs';
import { currentCounts, growthFindings, readBaseline as readGrowthBaseline } from './check-growth.mjs';
import { errorTeachingFindings } from './check-error-teaching.mjs';

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

errors.push(...landingModelFindings(read));
const files = walk(root);
for (const file of files) {
  errors.push(...localPathFindings(relative(root, file), readFileSync(file)));
  if (isWorkflowPath(relative(root, file))) {
    errors.push(...actionPinFindings(relative(root, file), readFileSync(file, 'utf8')));
    errors.push(...candidateStepFindings(relative(root, file), readFileSync(file, 'utf8')));
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(file))) {
    const path = relative(root, file),
      source = readFileSync(file, 'utf8');
    errors.push(...networkBoundaryFindings(path, source));
    errors.push(...workStoreAccessFindings(path.split(sep).join('/'), source));
    if (['.ts', '.tsx'].includes(extname(file))) errors.push(...idleQueryFindings(path, source));
    errors.push(...recoveryAdviceFindings(path, source));
    errors.push(...spdxFindings(path.split(sep).join('/'), source));
    errors.push(...statusListFindings(path.split(sep).join('/'), source));
  }
  if (
    ['.md', '.sh', '.yml', '.yaml', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(
      extname(file),
    )
  )
    errors.push(...envPrintFindings(relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8')));
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

// Test-signal ratchet (ffbec6ef): only the changed test files are scanned when the check pins its
// changes; a direct run, or a change to the baseline or the scanner, scans them all.
{
  const changed = process.env.FORGE_CHECK_CHANGES
    ? ((await import('./test-impact.mjs')).pinnedPaths() ?? null)
    : null;
  const known = new Map(
    files.map(file => relative(root, file).split(sep).join('/')).map(path => [path, path]),
  );
  const baseline = readBaseline(root);
  for (const path of scanSet(known, changed)) errors.push(...testSignalFindings(path, read(path), baseline));
}
// Growth guard (ed28fc6b): tables, error codes, agent actions, CLI commands and glossary terms may not
// rise above tests/growth-baseline.json without a recorded reason.
errors.push(...growthFindings(currentCounts(root), readGrowthBaseline(root)));
// Every public error code teaches: a learn topic, and next/topic commands that exist (Issue 0a7d6f56).
errors.push(...(await errorTeachingFindings(root)));

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
    `Foundation checks passed: ${files.length} files; JSON parses, Markdown links resolve, license inventory is current, no machine-specific home paths, SPDX headers lead every source file, nothing prints environment values, no test file adds a real sleep, elapsed-time assert or docs read above its baseline, no growth count (tables, error codes, agent actions, CLI commands, glossary terms, machine dependencies, unreferenced exports) differs from its baseline, every public error code has a help topic and names only commands and topics that exist.`,
  );
  console.log(
    'Application behavior, external URLs and authenticated/local runtime integration are not tested by this command.',
  );
}
