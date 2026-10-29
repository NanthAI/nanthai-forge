// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { packageDocuments } from '../scripts/package-documents.mjs';
import { llmDocuments, llmsFullPaths, llmsFullBudgetBytes } from '../scripts/llm-documents.mjs';
import { cleanUrl } from '../dist/project-routes.js';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { projectTabs, hostedSections, entryFor } = await import(moduleUrl('../web/src/shell/route.ts'));
const read = path => readFileSync(join(root, path), 'utf8');
const githubBlob = 'https://github.com/NanthAI/nanthai-forge/blob/main/';

// Robots uses longest matching rule; an equally specific Allow wins. Match the full
// path + query so legacy signed-in destinations at / cannot inherit the root Allow.
function crawlable(robots, url) {
  const rules = [...robots.matchAll(/^(Allow|Disallow): (.+)$/gm)].map(([, kind, pattern]) => {
    const terminal = pattern.endsWith('$');
    const text = terminal ? pattern.slice(0, -1) : pattern;
    const regex = text
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return {
      kind,
      length: text.replaceAll('*', '').length,
      matches: new RegExp(`^${regex}${terminal ? '$' : ''}`).test(url),
    };
  });
  const matched = rules
    .filter(rule => rule.matches)
    .sort((a, b) => b.length - a.length || a.kind.localeCompare(b.kind));
  return !matched.length || matched[0].kind === 'Allow';
}

test('the hosted Vite build emits linked LLM files, every packaged doc and crawler rules', async t => {
  const output = mkdtempSync(join(tmpdir(), 'forge-llm-build-'));
  t.after(() => rmSync(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await build({
    root: join(root, 'web'),
    configFile: join(root, 'web/vite.config.ts'),
    mode: 'hosted',
    envFile: false,
    logLevel: 'silent',
    build: { outDir: output, emptyOutDir: true },
  });
  const llms = readFileSync(join(output, 'llms.txt'), 'utf8');
  const full = readFileSync(join(output, 'llms-full.txt'), 'utf8');
  const robots = readFileSync(join(output, 'robots.txt'), 'utf8');
  assert.match(llms, /^# NanthAi:Forge\n\n> Forge/);
  for (const section of [
    'Start here',
    'For agents',
    'Measured results',
    'Reference',
    'Optional',
    'Full text',
  ])
    assert.ok(llms.includes(`## ${section}\n\n`), section);
  const links = [...llms.matchAll(/^- \[[^\n]+\]\(([^)]+)\): (.+)$/gm)];
  // Every packaged doc, the README and skill on GitHub, and the full-text file are linked once.
  assert.equal(links.length, packageDocuments.length + 3);
  for (const [, target, note] of links) {
    assert.ok(note.length > 0);
    if (target.startsWith(githubBlob)) {
      assert.ok(read(target.slice(githubBlob.length)).length > 0, target);
      continue;
    }
    assert.ok(target.startsWith('/'), `${target} is a site route or a repository link`);
    assert.ok(readFileSync(join(output, target), 'utf8').length > 0, target);
    assert.ok(crawlable(robots, target), target);
  }
  for (const path of packageDocuments) {
    assert.ok(llms.includes(`](/${path}): `), path);
    assert.equal(readFileSync(join(output, path), 'utf8'), read(path));
  }
  let previous = -1;
  for (const path of llmsFullPaths) {
    const marker = `Source: ${path === 'README.md' ? `${githubBlob}README.md` : `/${path}`}\n\n`;
    const position = full.indexOf(marker);
    assert.ok(position > previous, `${path} follows list order`);
    assert.ok(full.startsWith(read(path), position + marker.length), `${path} retains full text`);
    previous = position;
  }
  assert.equal((full.match(/^Source: /gm) ?? []).length, llmsFullPaths.length);
  assert.ok(Buffer.byteLength(full) <= llmsFullBudgetBytes);
  for (const internal of [
    'docs/phase5-plan.md',
    'docs/status.md',
    'docs/r2-storage-plan.md',
    'docs/research/',
  ])
    assert.ok(!full.includes(`Source: /${internal}`), `${internal} stays out of llms-full`);
  assert.equal(robots, read('web/public/robots.txt'));
});

test('llms-full is curated: listed in the package inventory, within budget and without internal plans', () => {
  assert.ok(llmsFullBudgetBytes <= 400 * 1024);
  for (const path of llmsFullPaths)
    assert.ok(path === 'README.md' || packageDocuments.includes(path), `${path} is a packaged document`);
  for (const internal of [
    'docs/phase5-plan.md',
    'docs/status.md',
    'docs/backlog.md',
    'docs/roadmap.md',
    'docs/r2-storage-plan.md',
    'docs/research/sp1-storage.md',
    'docs/decisions.md',
  ])
    assert.ok(!llmsFullPaths.includes(internal), `${internal} is not concatenated`);
  const bytes = llmsFullPaths.reduce((sum, path) => sum + Buffer.byteLength(read(path)), 0);
  assert.ok(bytes < llmsFullBudgetBytes, `sources total ${bytes} bytes`);
  const first = llmDocuments(root);
  assert.deepEqual(llmDocuments(root), first);
  assert.ok(Buffer.byteLength(first[1].source) <= llmsFullBudgetBytes);
});

test('llms.txt quotes only dated figures that why-forge.md states, and reports the failed bar', () => {
  const llms = llmDocuments(root)[0].source;
  const why = read('docs/why-forge.md');
  const measured = llms.slice(llms.indexOf('## Measured results'), llms.indexOf('## Reference'));
  const figures = measured
    .match(/\d[\d,.]*(?: \/ \d+|\s?s\b|×)?/g)
    .map(figure => figure.replace(/[.,]$/, ''));
  assert.ok(figures.length > 12);
  for (const figure of figures) assert.ok(why.includes(figure), `${figure} appears in docs/why-forge.md`);
  assert.match(measured, /GitHub was faster[^\n]*189 s[^\n]*989 s/);
  assert.match(measured, /2026-10-24 \(E3\)/);
  assert.match(measured, /Not established: a token or time advantage/);
  assert.doesNotMatch(measured, /\b(?:fastest|best|revolutionary|blazing|seamless|powerful|game-chang)/i);
  for (const rule of [
    /affects/,
    /full suite locally/,
    /`finish`/,
    /peers and presence/,
    /contributors propose/,
  ])
    assert.match(llms, rule);
});

test('generation uses only the explicit inventory and reflects source edits deterministically', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'forge-llm-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const put = (path, text) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  };
  for (const path of packageDocuments) put(path, `# ${path}\n\nPublic text for ${path}.\n`);
  for (const path of ['README.md', 'skills/forge-agent/SKILL.md'])
    put(path, `# ${path}\n\nPublic text for ${path}.\n`);
  for (const path of ['docs/internal-only.md', 'docs/vendor-notices/private.md', 'private-output.md'])
    put(path, 'EXCLUDED_INTERNAL_CONTENT');
  const first = llmDocuments(fixture);
  assert.deepEqual(llmDocuments(fixture), first);
  assert.ok(!JSON.stringify(first).includes('EXCLUDED_INTERNAL_CONTENT'));
  assert.equal(first.length, packageDocuments.length + 2);
  for (const path of llmsFullPaths) assert.ok(first[1].source.includes(`Public text for ${path}.`), path);
  for (const path of ['docs/status.md', 'docs/backlog.md', 'docs/roadmap.md', 'docs/phase5-plan.md'])
    assert.ok(!first[1].source.includes(`Public text for ${path}.`), `${path} is linked, not concatenated`);
  put('docs/why-forge.md', '# Why Forge now?\n\nChanged public documentation.\n');
  const next = llmDocuments(fixture);
  assert.match(next[0].source, /\[Why Forge now\?\]\(\/docs\/why-forge.md\): Changed public documentation\./);
  assert.match(next[1].source, /Changed public documentation\./);
  // A listed source that is missing fails the build instead of shipping a partial file.
  for (const path of [packageDocuments[0], llmsFullPaths[0], 'docs/security.md']) {
    const copy = readFileSync(join(fixture, path), 'utf8');
    rmSync(join(fixture, path));
    assert.throws(() => llmDocuments(fixture), { code: 'ENOENT' }, path);
    put(path, copy);
  }
  // The size budget fails the build rather than truncating.
  put('docs/security.md', `# Security\n\n${'x'.repeat(llmsFullBudgetBytes)}\n`);
  assert.throws(() => llmDocuments(fixture), /budget is/);
});

test('robots permits public static resources for all named crawlers without a sitemap', () => {
  const robots = read('web/public/robots.txt');
  for (const bot of [
    '*',
    'GPTBot',
    'ClaudeBot',
    'Claude-SearchBot',
    'PerplexityBot',
    'Google-Extended',
    'CCBot',
  ])
    assert.ok(robots.split('\n').includes(`User-agent: ${bot}`));
  // All named crawlers share one group with `*`, so the same Allow/Disallow rules bind each of them.
  const lines = robots.split('\n').filter(line => line && !line.startsWith('#'));
  const firstRule = lines.findIndex(line => !line.startsWith('User-agent:'));
  assert.equal(lines.slice(0, firstRule).length, 7);
  assert.ok(lines.slice(firstRule).every(line => !line.startsWith('User-agent:')));
  assert.match(robots, /^# .*Convex reads\./m);
  assert.doesNotMatch(robots, /^Sitemap:/m);
  for (const path of [
    '/',
    '/llms.txt',
    '/llms-full.txt',
    '/robots.txt',
    '/assets/app.js',
    ...packageDocuments.map(path => `/${path}`),
  ])
    assert.ok(crawlable(robots, path), path);
  for (const path of [
    '/llms.txt/project',
    '/llms-full.txt/lanes',
    '/docs/project',
    '/docs/internal-only.txt',
  ])
    assert.equal(crawlable(robots, path), false, path);
});

test('robots excludes every account and project route derived from the shell route catalog', () => {
  const robots = read('web/public/robots.txt');
  const source = read('web/src/shell/route.ts');
  const accountType = /export type AccountTab = ([^;]+);/.exec(source)?.[1];
  assert.ok(accountType, 'account route union is present');
  const accountTabs = [...accountType.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(accountTabs.length > 0);
  const denied = new Set([
    '/settings',
    '/settings/you',
    '/device',
    '/api/projects',
    '/local/project',
    '/new-handle/new-project',
  ]);
  for (const tab of accountTabs) {
    denied.add(`/${tab}`);
    denied.add(`/?surface=${tab}`);
  }
  const project = { id: 'test-project', owner: 'test-owner', name: 'test-project' };
  for (const section of [...projectTabs, ...Object.values(hostedSections).flat()]) {
    const query = `/?project=${project.id}&projectTab=${section}`;
    assert.equal(entryFor(true, new URL(query, 'https://forge.test').search), 'project');
    denied.add(query);
    denied.add(`/test-owner/test-project/${section}`);
    denied.add(`/local/test-project/${section}`);
    denied.add(cleanUrl(query, 'https://forge.test', { mode: 'hosted', project }));
  }
  assert.equal(entryFor(false, '?codescape=example'), 'repository');
  denied.add('/?codescape=example');
  // Catch-all coverage also protects future/unknown project sections and query orderings.
  for (const url of ['/?x=1&project=test', '/?tab=code', '/future-owner/future-project/new-section'])
    denied.add(url);
  for (const url of denied) assert.equal(crawlable(robots, url), false, url);
});
