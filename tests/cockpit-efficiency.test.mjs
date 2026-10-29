// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleSource, moduleUrl } from './convex-module.mjs';
const { sourceMembership } = await import(moduleUrl('../convex/projectSourceMembership.ts'));

test('cockpit history batches preserve all dogfood rows and issue no disabled reads', async t => {
  const counts = { intents: 600, lanes: 560, views: 2200, runs: 1500, channelMoves: 575 };
  const pages = new Map();
  let calls = 0,
    returned = 0;
  globalThis.__e67React = {
    createContext: () => ({}),
    useContext: () => null,
    useEffect: fn => fn(),
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
  };
  globalThis.__e67Convex = {
    usePaginatedQuery: (_ref, args, { initialNumItems }) => {
      if (args === 'skip')
        return {
          results: [],
          status: 'Exhausted',
          loadMore() {
            assert.fail('disabled');
          },
        };
      const key = args.collection;
      if (!pages.has(key)) {
        pages.set(key, Math.min(initialNumItems, counts[key]));
        calls++;
      }
      const size = pages.get(key);
      return {
        results: Array.from({ length: size }, (_, position) => ({
          id: String(position),
          position,
          value: '{}',
        })),
        status: size === counts[key] ? 'Exhausted' : 'CanLoadMore',
        loadMore: n => {
          pages.set(key, Math.min(size + n, counts[key]));
          calls++;
        },
      };
    },
  };
  try {
    const source = moduleSource('../web/src/hosted-work-index.ts')
      .replace(
        /import \{ createContext, useContext, useEffect, useMemo, useRef, useState \} from [^;]+;/,
        'const { createContext, useContext, useEffect, useMemo, useRef, useState } = globalThis.__e67React;',
      )
      .replace(
        /import \{ useConvex, usePaginatedQuery, useQuery \} from [^;]+;/,
        'const { useConvex, usePaginatedQuery, useQuery } = globalThis.__e67Convex;',
      );
    const { useWorkRecords } = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    );
    for (const collection of Object.keys(counts)) {
      let result;
      for (let i = 0; i < 200; i++) {
        result = useWorkRecords(
          'project',
          { generationId: 'generation', capabilities: { recentSummaryPages: true } },
          collection,
        );
        if (result.complete) break;
      }
      assert.equal(result.records.length, counts[collection]);
      assert.equal(result.complete, true);
      returned += result.records.length;
    }
    const loadedCalls = calls;
    for (let i = 0; i < 60; i++)
      for (const collection of Object.keys(counts))
        useWorkRecords('project', null, collection, undefined, false);
    assert.equal(calls - loadedCalls, 0, 'idle/disabled hooks issue zero queries');
    t.diagnostic(
      JSON.stringify({ queries: calls, summaryRows: returned, writes: 0, idleCalls: calls - loadedCalls }),
    );
    assert.equal(calls, 55);
  } finally {
    delete globalThis.__e67React;
    delete globalThis.__e67Convex;
  }
});

test('a 100-Lane cockpit page shares indexed ancestry reads at dogfood scale', async t => {
  const rows = new Map();
  const ancestors = Array.from({ length: 2500 }, (_, i) => `head-${i}`);
  rows.set('sourceAncestryClosure:main', { value: JSON.stringify({ chunks: 3, complete: true }) });
  for (let i = 0; i < 3; i++)
    rows.set(`sourceAncestryChunk:main:${i}`, {
      value: JSON.stringify({ ancestors: ancestors.slice(i * 1000, (i + 1) * 1000) }),
    });
  let reads = 0;
  const ctx = {
    db: {
      query: () => {
        const fields = {};
        const query = {
          withIndex: (_index, fn) => {
            const q = {
              eq: (key, value) => {
                fields[key] = value;
                return q;
              },
            };
            fn(q);
            return query;
          },
          unique: async () => {
            reads++;
            return rows.get(`${fields.collection}:${fields.key}`) ?? null;
          },
        };
        return query;
      },
    },
  };
  const started = performance.now();
  const included = await Promise.all(
    Array.from({ length: 100 }, (_, i) => sourceMembership(ctx, 'generation', 'main', ancestors[2400 + i])),
  );
  assert(included.every(Boolean));
  t.diagnostic(
    JSON.stringify({
      functionCalls: 1,
      indexedReads: reads,
      writes: 0,
      wallMs: performance.now() - started,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
  assert.equal(reads, 4);
  assert(process.resourceUsage().maxRSS * 1024 < 512 * 1024 * 1024, 'request-local ancestry memory budget');
});
