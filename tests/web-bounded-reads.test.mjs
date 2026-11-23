// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bounded web reads (Item 686ecdde, comment ac886ed1): old web hooks read every 100-row page of planning Items,
// Lanes, Intents, views and runs on a page open, 80 to 800 calls and 26 to 41 MB per open, and the cost of one open
// grew with the project. Every place of the rebuilt app reads one bounded page or a server summary instead
// (docs/agents/lint-rules.md#bounded-web-reads). These tests guard both halves: no rebuilt-app module can reach a
// whole-collection reader, and the bounded page hook reads the same one page at 100 and at 10,000 rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleSource } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'web/src/app');

/** Hooks and helpers that follow every cursor of a collection. Old screens use them until they are removed. */
const wholeCollection =
  /\b(useWorkRecords|useSharedWorkRecords|useProjectedDecisions|readProjectedDecisions)\b\s*(?:[<(]|as\b)/;
/** Asking for the next page as soon as one arrives reads the whole collection on open; a `() =>` handler is fine. */
const autoFollow = /['"]CanLoadMore['"][^;\n=]{0,40}?\bloadMore\s*\(/;
/** Reviewed exceptions, each with why it does not grow with a project or its visitors. */
const allowed = new Map([
  [
    'web/src/app/You.tsx',
    'a person’s own passkeys, 20 per page (convex/authPasskeyPage.ts); no project data and no other visitor',
  ],
]);

function resolve(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ])
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  return null;
}

/** Every web module the rebuilt app can load: the shell and each place's route entries, through static and lazy imports. */
function rebuiltAppModules() {
  const roots = [join(app, 'App.tsx')];
  for (const entry of readdirSync(app, { withFileTypes: true }))
    if (entry.isDirectory() && existsSync(join(app, entry.name, 'route.ts')))
      roots.push(join(app, entry.name, 'route.ts'));
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolve(file, match[1]);
      if (next && next.startsWith(join(root, 'web/src'))) queue.push(next);
    }
  }
  return [...seen].map(file => relative(root, file));
}

test('686ecdde: the guard catches the ways a page could follow every cursor', () => {
  for (const source of [
    'const rows = useWorkRecords(projectId, workspace, "lanes");',
    'const rows = useWorkRecords<Lane>(projectId, workspace, "lanes");',
    "import { useSharedWorkRecords as useRows } from '../../hosted-work-index';",
    'export { useProjectedDecisions as decisions } from "../hosted-work-index";',
  ])
    assert.match(source, wholeCollection, source);
  for (const source of [
    "if (status === 'CanLoadMore') loadMore(100);",
    "if (page.status === 'CanLoadMore') page.loadMore(100);",
    "status === 'CanLoadMore' && loadMore(50);",
  ])
    assert.match(source, autoFollow, source);
  for (const source of [
    'const page = useWorkPage(projectId, workspace, "lanes");',
    "more: status === 'CanLoadMore' ? () => loadMore(100) : undefined,",
  ])
    assert.ok(!wholeCollection.test(source) && !autoFollow.test(source), source);
});

test('686ecdde: no rebuilt-app place can reach a reader that follows every page of a collection', () => {
  const modules = rebuiltAppModules();
  assert.ok(modules.length > 100, `the walk found the rebuilt app (${modules.length} modules)`);
  for (const place of ['needs', 'lanes', 'plan', 'code', 'stats', 'people'])
    assert.ok(
      modules.some(file => file.startsWith(`web/src/app/${place}/`)),
      `the walk reaches the ${place} place`,
    );
  const offenders = [];
  for (const file of modules) {
    if (file === 'web/src/hosted-work-index.ts' || allowed.has(file)) continue;
    const source = readFileSync(join(root, file), 'utf8');
    const hit = source.match(wholeCollection) ?? source.match(autoFollow);
    if (hit) offenders.push(`${file}: ${hit[0]}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'Read one bounded page (useWorkPage, or a paginated server read with an explicit "more") or a server summary',
  );
  for (const file of allowed.keys())
    assert.ok(modules.includes(file), `${file} is still reachable; drop its exception`);
});

async function loadIndex(rows) {
  let subscriptions = 0;
  const pages = new Map();
  globalThis.__boundedReact = {
    createContext: () => ({}),
    useContext: () => null,
    useEffect: fn => fn(),
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
  };
  const paginated = (_ref, args, { initialNumItems }) => {
    if (args === 'skip') return { results: [], status: 'Exhausted', loadMore: () => assert.fail('disabled') };
    const key = JSON.stringify(args);
    if (!pages.has(key)) {
      pages.set(key, Math.min(initialNumItems, rows));
      subscriptions++;
    }
    const size = pages.get(key);
    const order = args.newestFirst ? n => rows - 1 - n : n => n;
    return {
      results: Array.from({ length: size }, (_, n) => ({
        id: String(order(n)),
        position: order(n),
        value: JSON.stringify({ id: String(order(n)) }),
      })),
      status: size === rows ? 'Exhausted' : 'CanLoadMore',
      loadMore: n => {
        pages.set(key, Math.min(size + n, rows));
        subscriptions++;
      },
    };
  };
  globalThis.__boundedConvex = { usePaginatedQuery: paginated };
  const source = moduleSource('../web/src/hosted-work-index.ts')
    .replace(
      /import \{ createContext, useContext, useEffect, useMemo, useRef, useState \} from [^;]+;/,
      'const { createContext, useContext, useEffect, useMemo, useRef, useState } = globalThis.__boundedReact;',
    )
    .replace(
      /import \{ useConvex, useQuery \} from [^;]+;/,
      'const useConvex = () => null; const useQuery = () => undefined;',
    )
    .replace(
      /import \{ useArchivePaginatedQuery \} from [^;]+;/,
      'const useArchivePaginatedQuery = (...args) => ({ error: undefined, ...globalThis.__boundedConvex.usePaginatedQuery(...args) });',
    )
    .replace(
      /import \{ useSafePaginatedQuery \} from [^;]+;/,
      'const useSafePaginatedQuery = (...args) => ({ error: undefined, ...globalThis.__boundedConvex.usePaginatedQuery(...args) });',
    );
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return { ...module, subscriptions: () => subscriptions };
}

const workspace = { generationId: 'generation', capabilities: { recentSummaryPages: true } };

for (const [collection, parentId] of [
  ['planningComments', 'item'],
  ['planningVersions', 'item'],
  ['lanes', undefined],
])
  test(`686ecdde: a ${collection} page open reads one newest page at 100 and at 10,000 rows`, async t => {
    const measured = {};
    try {
      for (const rows of [100, 10_000]) {
        const index = await loadIndex(rows);
        let page;
        // Re-render as a mounted page would; a bounded page never asks for the next one by itself.
        for (let render = 0; render < 50; render++)
          page = index.useWorkPage('project', workspace, collection, parentId);
        measured[rows] = { subscriptions: index.subscriptions(), records: page.records.length };
        assert.equal(page.initialLoading, false);
        assert.equal(page.loadingMore, false);
        assert.equal(Boolean(page.more), rows > 100, 'more is offered only while rows remain');
        if (rows > 100) {
          assert.deepEqual(
            page.records.map(record => Number(record.id)),
            Array.from({ length: 100 }, (_, n) => rows - 100 + n),
            'the first page holds the newest rows, shown in order',
          );
          page.more();
          assert.equal(index.subscriptions(), 2, 'asking for more reads exactly one more page');
        }
      }
      assert.deepEqual(measured[100], measured[10_000], 'reads per open stay flat as the collection grows');
      assert.deepEqual(measured[10_000], { subscriptions: 1, records: 100 });
      t.diagnostic(JSON.stringify(measured));
    } finally {
      delete globalThis.__boundedReact;
      delete globalThis.__boundedConvex;
    }
  });
