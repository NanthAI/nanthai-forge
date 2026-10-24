// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Exercise the real hook with the same Convex query boundary used by the hosted route tests.
test('planning attribution reads named operations under the current project and generation', async t => {
  const server = await createServer({
    root: fileURLToPath(new URL('../web', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: {
      alias: [
        {
          find: /^convex\/react$/,
          replacement: fileURLToPath(new URL('./fixtures/hosted-tree/convex-react.mjs', import.meta.url)),
        },
      ],
    },
    ssr: { noExternal: ['convex'] },
  });
  const previous = globalThis.__forgeTree;
  try {
    const { usePlanningActors } = await server.ssrLoadModule('/src/planning/usePlanningActors.ts');
    const versions = [
      { id: 'item', operationId: 'creation', version: 1 },
      { id: 'item', operationId: 'edit', version: 2 },
    ];
    let output, replies;
    const calls = [];
    globalThis.__forgeTree = {
      queries: {
        'projectWorkIndex:detail': args => {
          calls.push(args);
          return replies[args.id];
        },
      },
    };
    function Fixture() {
      output = usePlanningActors('project', { generationId: 'current' }, versions);
      return null;
    }
    await t.test(
      'known authors come from their own operation; queries are scoped and source stays unchanged',
      () => {
        replies = Object.fromEntries(
          [
            ['creation', 'Dino'],
            ['edit', 'Maya'],
          ].map(([id, name]) => [
            id,
            {
              generationId: 'current',
              value: JSON.stringify({ id, actor: `account-${id}`, actorDisplayName: name }),
            },
          ]),
        );
        renderToStaticMarkup(h(Fixture));
        assert.deepEqual(
          output.map(version => version.actorDisplayName),
          ['Dino', 'Maya'],
        );
        assert.deepEqual(
          calls,
          versions.map(version => ({
            projectId: 'project',
            generationId: 'current',
            collection: 'events',
            id: version.operationId,
          })),
        );
        assert.ok(versions.every(version => !('actorDisplayName' in version)));
      },
    );
    await t.test('unknown raw account ids, missing events and stale names stay absent', () => {
      for (const reply of [
        undefined,
        { generationId: 'current', value: null },
        { generationId: 'current', value: JSON.stringify({ actor: 'raw-account-id' }) },
        { generationId: 'old', value: JSON.stringify({ actorDisplayName: 'Stale actor' }) },
      ]) {
        replies = { creation: reply, edit: reply };
        renderToStaticMarkup(h(Fixture));
        assert.ok(output.every(version => version.actorDisplayName === undefined));
      }
    });
    await t.test('query failures surface instead of pretending the author is unknown', () => {
      replies = { creation: new Error('Current project access changed') };
      assert.throws(() => renderToStaticMarkup(h(Fixture)), /Current project access changed/);
    });
  } finally {
    globalThis.__forgeTree = previous;
    await server.close();
  }
});
