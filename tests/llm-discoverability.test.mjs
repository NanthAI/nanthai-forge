// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { packageDocuments } from '../scripts/package-documents.mjs';
import { llmDocuments } from '../scripts/llm-documents.mjs';
import { cleanUrl } from '../dist/project-routes.js';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { projectTabs, hostedSections, entryFor } = await import(moduleUrl('../web/src/shell/route.ts'));
const read = path => readFileSync(join(root, path), 'utf8');

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
  t.after(() => rmSync(output, { recursive: true, force: true }));
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
  assert.match(llms, /^# NanthAi:Forge\n\n> Forge/);
  for (const section of ['Start here', 'Documentation', 'Full text'])
    assert.ok(llms.includes(`## ${section}\n\n`));
  const links = [...llms.matchAll(/^- \[[^\n]+\]\(([^)]+)\): (.+)$/gm)];
  assert.equal(links.length, packageDocuments.length + 1);
  for (const [, path, note] of links) {
    assert.ok(note.length > 0);
    assert.ok(readFileSync(join(output, path), 'utf8').length > 0, path);
    assert.ok(crawlable(readFileSync(join(output, 'robots.txt'), 'utf8'), path), path);
  }
  let previous = -1;
  for (const path of packageDocuments) {
    assert.ok(llms.includes(`](/${path}): `), path);
    assert.equal(readFileSync(join(output, path), 'utf8'), read(path));
    const marker = `Source: /${path}\n\n`;
    const position = full.indexOf(marker);
    assert.ok(position > previous, `${path} follows inventory order`);
    assert.ok(full.startsWith(read(path), position + marker.length), `${path} retains full text`);
    previous = position;
  }
  assert.equal((full.match(/^Source: \/docs\//gm) ?? []).length, packageDocuments.length);
  assert.equal(readFileSync(join(output, 'robots.txt'), 'utf8'), read('web/public/robots.txt'));
});

test('generation uses only the explicit inventory and reflects source edits deterministically', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'forge-llm-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  };
  for (const path of packageDocuments) put(path, `# ${path}\n\nPublic text for ${path}.\n`);
  for (const path of ['docs/internal-only.md', 'docs/vendor-notices/private.md', 'private-output.md'])
    put(path, 'EXCLUDED_INTERNAL_CONTENT');
  const first = llmDocuments(fixture);
  assert.deepEqual(llmDocuments(fixture), first);
  assert.ok(!JSON.stringify(first).includes('EXCLUDED_INTERNAL_CONTENT'));
  assert.equal(first.length, packageDocuments.length + 2);
  for (const path of ['docs/status.md', 'docs/backlog.md', 'docs/roadmap.md'])
    assert.ok(first[1].source.includes(`Public text for ${path}.`), `${path} is already public`);
  put('docs/why-forge.md', '# Why Forge now?\n\nChanged public documentation.\n');
  const next = llmDocuments(fixture);
  assert.match(next[0].source, /\[Why Forge now\?\]\(\/docs\/why-forge.md\): Changed public documentation\./);
  assert.match(next[1].source, /Changed public documentation\./);
  rmSync(join(fixture, packageDocuments[0]));
  assert.throws(() => llmDocuments(fixture), { code: 'ENOENT' });
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
