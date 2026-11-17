// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { packageDocuments, packageDocumentData } from '../scripts/package-documents.mjs';
import {
  llmDocuments,
  llmsFullPaths,
  llmsFullWarnBytes,
  llmsFullSizeReport,
} from '../scripts/llm-documents.mjs';
import { retiredActions } from '../dist/agent-verbs.js';
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
  assert.match(llms, /Keep this turn active on unfinished work/);
  assert.match(llms, /operationIds:\[ORIGINAL_UUID\],until:"acceptance"\}`; it blocks up to its budget/);
  assert.match(llms, /repeat on IN PROGRESS/);
  // Hosted peers and diff exist (docs/agents/workflow.md); the text once said they were unavailable.
  assert.match(llms, /Hosted `peers \{laneId,path\?,detail\?\}` reads the same saved overlap evidence/);
  assert.doesNotMatch(llms, /peers and diff are unavailable/);
  assert.match(llms, /saved-path windows exclude unsaved peer edits/);
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
  // Every packaged doc, the README and skill, full text, docs home and both generated references are linked.
  assert.equal(links.length, packageDocuments.length + 6);
  for (const [, target, note] of links) {
    assert.ok(note.length > 0);
    if (target.startsWith(githubBlob)) {
      assert.ok(read(target.slice(githubBlob.length)).length > 0, target);
      continue;
    }
    assert.ok(target.startsWith('/'), `${target} is a site route or a repository link`);
    assert.ok(
      readFileSync(join(output, target.endsWith('/') ? `${target}index.html` : target), 'utf8').length > 0,
      target,
    );
    assert.ok(crawlable(robots, target), target);
  }
  for (const path of packageDocuments) {
    assert.ok(llms.includes(`](/${path}): `), path);
    assert.equal(readFileSync(join(output, path), 'utf8'), read(path));
  }
  for (const path of packageDocumentData) assert.equal(readFileSync(join(output, path), 'utf8'), read(path));
  let previous = -1;
  for (const path of llmsFullPaths) {
    const marker = `Source: ${path === 'README.md' ? `${githubBlob}README.md` : `/${path}`}\n\n`;
    const position = full.indexOf(marker);
    assert.ok(position > previous, `${path} follows list order`);
    assert.ok(full.startsWith(read(path), position + marker.length), `${path} retains full text`);
    previous = position;
  }
  assert.equal((full.match(/^Source: /gm) ?? []).length, llmsFullPaths.length);
  for (const internal of [
    'docs/phase5-plan.md',
    'docs/status.md',
    'docs/r2-storage-plan.md',
    'docs/research/',
  ])
    assert.ok(!full.includes(`Source: /${internal}`), `${internal} stays out of llms-full`);
  assert.equal(robots, read('web/public/robots.txt'));
});

test('llms-full is curated: listed in the package inventory and without internal plans', () => {
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
  const first = llmDocuments(root);
  assert.deepEqual(llmDocuments(root), first);
});

// 00c3f715: the public page's copied prompt points here and asks the agent to explain first; llms.txt says the same.
test('llms.txt answers the public page prompt explain-first and states the development status', () => {
  const llms = llmDocuments(root)[0].source;
  const page = read('web/index.html');
  const section = llms.split('## If someone sent you here\n\n')[1]?.split('\n\n## Start here')[0] ?? '';
  assert.ok(llms.indexOf('## If someone sent you here') < llms.indexOf('## Start here'));
  assert.match(section, /explain before you act/);
  assert.match(section, /CI minutes/);
  assert.match(section, /one small change/);
  assert.match(section, /Do not install, sign in, import a repository or change any file until they say so/);
  assert.match(
    section,
    /not published to npm and there is no public production service yet, so nothing is charged/,
  );
  assert.match(section, /\(\/docs\/quickstart\.md\)[\s\S]*\(\/docs\/status\.md\)/);
  // The prompt the page copies asks for the same three answers and forbids installing.
  const prompt = /<pre id="prompt" data-prompt>([\s\S]*?)<\/pre>/.exec(page)?.[1] ?? '';
  assert.match(prompt, /^Read \/llms\.txt/);
  assert.match(prompt, /CI minutes/);
  assert.match(prompt, /one small change/);
  assert.match(prompt, /Do not install anything yet\./);
  // Crawlers may read the public page and its files, never the app or legacy app links at /.
  const robots = read('web/public/robots.txt');
  for (const url of ['/', '/llms.txt', '/llms-full.txt', '/docs/status.md', '/assets/index-abc.js'])
    assert.ok(crawlable(robots, url), url);
  for (const url of ['/projects', '/app.html', '/device', '/?project=abc', '/settings', '/owner/repo'])
    assert.ok(!crawlable(robots, url), url);
});

test('agent discovery teaches current contract verbs and shares measured B1.5d/P6 evidence', () => {
  const llms = llmDocuments(root)[0].source;
  const skill = read('skills/forge-agent/SKILL.md');
  const why = read('docs/why-forge.md');
  const block = /<!-- agent-measurements:start -->\n([\s\S]*?)\n<!-- agent-measurements:end -->/;
  const matched = block.exec(why);
  assert(matched, 'agent benchmark summaries must come from current Why Forge evidence');
  const measured = matched[1];
  assert(llms.includes(measured));
  const skillBlock = block.exec(skill);
  assert(skillBlock, 'the agent skill must carry the same current benchmark evidence');
  assert.equal(skillBlock[1], measured);
  for (const text of [llms, skill]) {
    assert.match(text, /B1\.5d[\s\S]*324 \/ 496 s/);
    assert.match(text, /331 \/ 910/);
    assert.match(text, /P6 exit:[\s\S]*descriptive real-agent report/);
    assert.match(text, /762\.705 \/ 1181\.678 s/);
    assert.match(text, /24 \/ 69 min/);
    assert.match(text, /prevent an exit-bar pass/);
    assert.doesNotMatch(text, /Let `finish`|contributors propose and cannot write|R3\) is pending/);
  }
  assert.match(llms, /Lifecycle verbs: `start`, `save`, `land`/);
  assert.match(llms, /preflight \{laneId\}/);
  assert.match(llms, /tests \{candidateId\}/);
  assert.doesNotMatch(llms, /nforge agent ROOT tests`/);
  const retired = skill.split('- Removed with native mode:')[1].split('## Working')[0];
  for (const [, action] of retired.matchAll(/`([a-z][a-z-]*)`/g))
    assert(Object.hasOwn(retiredActions, action), `${action} is supported and must not be called retired`);
});

test('generation uses only the explicit inventory and reflects source edits deterministically', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'forge-llm-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const put = (path, text) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  };
  for (const path of packageDocuments) put(path, `# ${path}\n\nPublic text for ${path}.\n`);
  for (const path of packageDocumentData) put(path, '{"publicCompanion":true}\n');
  for (const path of ['README.md', 'skills/forge-agent/SKILL.md'])
    put(path, `# ${path}\n\nPublic text for ${path}.\n`);
  put('docs/why-forge.md', read('docs/why-forge.md'));
  put('skills/forge-agent/SKILL.md', read('skills/forge-agent/SKILL.md'));
  for (const path of ['docs/internal-only.md', 'docs/vendor-notices/private.md', 'private-output.md'])
    put(path, 'EXCLUDED_INTERNAL_CONTENT');
  const first = llmDocuments(fixture);
  assert.deepEqual(llmDocuments(fixture), first);
  assert.ok(!JSON.stringify(first).includes('EXCLUDED_INTERNAL_CONTENT'));
  assert.equal(first.length, packageDocuments.length + packageDocumentData.length + 2);
  assert.doesNotMatch(first[1].source, /publicCompanion/);
  for (const path of llmsFullPaths.filter(path => path !== 'docs/why-forge.md'))
    assert.ok(first[1].source.includes(`Public text for ${path}.`), path);
  for (const path of ['docs/status.md', 'docs/backlog.md', 'docs/roadmap.md', 'docs/phase5-plan.md'])
    assert.ok(!first[1].source.includes(`Public text for ${path}.`), `${path} is linked, not concatenated`);
  put(
    'docs/why-forge.md',
    read('docs/why-forge.md')
      .replace('# Why Forge for agentic development?', '# Why Forge now?')
      .replace(
        'Forge gives people and agents isolated Lanes, combines their changes, checks the result and moves accepted source to main. Agents keep their normal editors and tools. Our [principles](principles.md) guide continuous improvement.',
        'Changed public documentation.',
      ),
  );
  const next = llmDocuments(fixture);
  assert.match(next[0].source, /\[Why Forge now\?\]\(\/docs\/why-forge.md\): Changed public documentation\./);
  assert.match(next[1].source, /Changed public documentation\./);
  // A listed source that is missing fails the build instead of shipping a partial file.
  for (const path of [packageDocuments[0], llmsFullPaths[0], 'docs/security.md', ...packageDocumentData]) {
    const copy = readFileSync(join(fixture, path), 'utf8');
    rmSync(join(fixture, path));
    assert.throws(() => llmDocuments(fixture), { code: 'ENOENT' }, path);
    put(path, copy);
  }
  // Size is reported, never a build failure (combined Lanes would fail landings that pass alone).
  put('docs/security.md', `# Security\n\n${'x'.repeat(llmsFullWarnBytes)}\n`);
  const huge = llmDocuments(fixture)[1].source;
  assert.ok(Buffer.byteLength(huge) > llmsFullWarnBytes);
});

test('llms-full size is a report with a non-failing warning above the line, never a cliff', () => {
  const text = size => 'x'.repeat(size);
  const under = llmsFullSizeReport(text(llmsFullWarnBytes));
  assert.equal(under.warn, false);
  assert.match(under.message, /^llms-full\.txt: 409600 bytes \(100\.0% of the 409600 byte warning line\)\.$/);
  const over = llmsFullSizeReport(text(llmsFullWarnBytes + 1));
  assert.equal(over.warn, true);
  assert.match(over.message, /WARNING: llms-full\.txt is 1 bytes over the warning line/);
  assert.match(over.message, /The build still passes/);
});

test('five Lanes each adding 2 KB of docs on the real files still generate llms-full', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'forge-llm-lanes-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const path of [
    ...packageDocuments,
    ...packageDocumentData,
    'README.md',
    'skills/forge-agent/SKILL.md',
  ]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), read(path));
  }
  const alone = Buffer.byteLength(llmDocuments(fixture)[1].source);
  const addition = `\n## Lane note\n\n${'Lane documentation sentence.\n'.repeat(80).slice(0, 2048)}\n`;
  for (const path of [
    'docs/quickstart.md',
    'docs/security.md',
    'docs/workflows.md',
    'docs/concepts.md',
    'docs/agents.md',
  ])
    writeFileSync(join(fixture, path), read(path) + addition);
  const combined = llmDocuments(fixture)[1].source;
  assert.ok(Buffer.byteLength(combined) >= alone + 5 * 2048, 'every addition is carried in full');
  const report = llmsFullSizeReport(combined);
  assert.equal(report.warn, report.size > llmsFullWarnBytes);
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
