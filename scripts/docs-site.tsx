// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Build-time HTML only. Source comes from the same explicit public inventory as the LLM and offline docs.
import { readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Plugin } from 'vite';
import { packageDocuments, readDocument } from './package-documents.mjs';
import { generatedReferencePaths } from './docs-output-paths.mjs';
import { docsReference } from './docs-reference.ts';
import { DocsFrame, type DocsGroup } from '../web/src/ds/DocsFrame.tsx';
import { DocsAgentPrompt } from '../web/src/ds/DocsAgentPrompt.tsx';
import { agentGuidePrompt } from './docs-agent-prompts.mjs';

// A newcomer's path: first landing, then everyday tasks, then lookup and trust.
const routes: [string, string[]][] = [
  ['Start here', ['README', 'guides/people', 'guides/agents', 'quickstart', 'concepts']],
  [
    'Guides',
    [
      'guides/plan',
      'guides/review',
      'guides/oversight',
      'guides/access',
      'guides/export',
      'git-serving',
      'workflows',
      'guides/billing',
    ],
  ],
  [
    'Reference',
    [
      'reference/cli',
      'reference/mcp',
      'reference/errors',
      'agents/workflow',
      'parallel-work-defaults',
      'limits',
    ],
  ],
  [
    'Operations and trust',
    ['security', 'data-placement', 'operations/self-hosted-runner', 'operations', 'status', 'why-forge'],
  ],
];
// Tree labels name the task when a page title names a topic.
const navLabels: Record<string, string> = {
  README: 'Overview',
  'guides/access': 'Connect devices and sign in',
  'git-serving': 'Clone and fetch with Git',
  workflows: 'Work through the hosted flow',
  'guides/billing': 'Understand account billing',
};
const href = (path: string) => (path === 'docs/README.md' ? '/docs/' : `/${path.replace(/\.md$/, '')}/`);
const titleOf = (source: string) => /^# (.+)$/m.exec(source)?.[1]?.replace(/[`*]/g, '') ?? 'Documentation';
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
const textOf = (children: ReactNode): string =>
  Array.isArray(children)
    ? children.map(textOf).join('')
    : typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : children && typeof children === 'object' && 'props' in children
        ? textOf((children.props as { children?: ReactNode }).children)
        : '';

export function docsSite(root: string): Plugin {
  function documents() {
    const docs = new Map<string, string>(packageDocuments.map(path => [path, readDocument(root, path)]));
    const reference = docsReference(root);
    for (const [path, key] of Object.entries(generatedReferencePaths))
      docs.set(path, reference[key as 'cli' | 'mcp' | 'errors']);
    return docs;
  }
  function page(template: string, path: string, docs: Map<string, string>) {
    const source = docs.get(path);
    if (!source) return null;
    const current = href(path);
    const used = new Set<string>();
    const groups: DocsGroup[] = routes.map(([label, names]) => ({
      label,
      pages: names.flatMap(name => {
        const key = `docs/${name}.md`;
        if (!docs.has(key)) throw new Error(`Docs navigation source missing: ${key}`);
        used.add(key);
        return [{ title: navLabels[name] ?? titleOf(docs.get(key)!), href: href(key) }];
      }),
    }));
    groups.push({
      label: 'More documentation',
      pages: [...docs]
        .filter(([key]) => !used.has(key))
        .map(([key, body]) => ({ title: titleOf(body), href: href(key) })),
    });
    const link = (url: string) => {
      if (!url || /^(?:[a-z]+:|\/\/|#)/i.test(url)) return url;
      const [target, fragment] = url.split('#');
      const resolved = target!.startsWith('/')
        ? target!.slice(1)
        : posix.normalize(posix.join(posix.dirname(path), target!));
      return docs.has(resolved)
        ? `${href(resolved)}${fragment === undefined ? '' : `#${fragment}`}`
        : url.startsWith('/')
          ? url
          : `https://github.com/NanthAI/nanthai-forge/blob/main/${resolved}${fragment === undefined ? '' : `#${fragment}`}`;
    };
    const ids = new Map<string, number>();
    const heading =
      (tag: 'h1' | 'h2' | 'h3' | 'h4') =>
      ({ children }: { children?: ReactNode }) => {
        const key = slug(textOf(children));
        const count = ids.get(key) ?? 0;
        ids.set(key, count + 1);
        return createElement(tag, { id: count ? `${key}-${count}` : key }, children);
      };
    const prompt = agentGuidePrompt(path);
    const body = renderToStaticMarkup(
      <DocsFrame groups={groups} current={current}>
        {prompt && <DocsAgentPrompt {...prompt} />}
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href: url, children }) => <a href={link(url ?? '')}>{children}</a>,
            h1: heading('h1'),
            h2: heading('h2'),
            h3: heading('h3'),
            h4: heading('h4'),
            table: ({ children }) => (
              <div className="docs-table" role="region" aria-label="Reference table" tabIndex={0}>
                <table>{children}</table>
              </div>
            ),
            pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
          }}
        >
          {source}
        </Markdown>
      </DocsFrame>,
    );
    return template
      .replace('<!--docs-content-->', () => body)
      .replace(
        '<title>Forge documentation</title>',
        () => `<title>${renderToStaticMarkup(<>{titleOf(source)}</>)} · Forge docs</title>`,
      );
  }
  return {
    name: 'forge-docs-site',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://forge.invalid').pathname;
        if (path !== '/docs' && !path.startsWith('/docs/')) return next();
        const docs = documents();
        if (path.endsWith('.md')) {
          const source = docs.get(path.slice(1));
          if (!source) return next();
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.end(source);
          return;
        }
        const sourcePath =
          path === '/docs' || path === '/docs/'
            ? 'docs/README.md'
            : `${path.replace(/^\//, '').replace(/\/$/, '')}.md`;
        const html = page(readFileSync(join(root, 'web/docs.html'), 'utf8'), sourcePath, docs);
        if (!html) {
          res.statusCode = 404;
          res.end('Documentation page not found. Return to /docs/.');
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await server.transformIndexHtml('/docs.html', html));
      });
    },
    generateBundle(_options, bundle) {
      const template = bundle['docs.html'];
      if (!template || template.type !== 'asset') return;
      const docs = documents();
      for (const path of docs.keys()) {
        const source = page(String(template.source), path, docs)!;
        this.emitFile({ type: 'asset', fileName: `${href(path).slice(1)}index.html`, source });
      }
      for (const path of Object.keys(generatedReferencePaths))
        this.emitFile({ type: 'asset', fileName: path, source: docs.get(path)! });
      delete bundle['docs.html'];
    },
  };
}
