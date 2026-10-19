// SPDX-License-Identifier: Apache-2.0
// Local synthetic Review only. No live Convex calls, credentials, or project mutations.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { hostedTree } from '../tests/fixtures/hosted-tree/tree.mjs';
const tree = hostedTree();
const fixtureData = {
  workspace: JSON.parse(tree.queries['projectWorkIndex:workspace']()),
  project: tree.queries['projectWork:state'](),
  intentId: tree.fixture.intentId,
  collections: Object.fromEntries(
    ['intents', 'lanes', 'views', 'runs', 'channels', 'hostedChannels', 'channelMoves', 'notes'].map(
      collection => [collection, tree.pages['projectWorkIndex:records']({ collection })],
    ),
  ),
};
const root = fileURLToPath(new URL('../web', import.meta.url));
const entry = fileURLToPath(new URL('../tests/fixtures/qa-d.tsx', import.meta.url));
const fixture = fileURLToPath(new URL('../tests/fixtures/s1b-convex-react.mjs', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  resolve: {
    alias: [
      { find: /^convex\/react$/, replacement: fixture },
      {
        find: /^@clerk\/react$/,
        replacement: fileURLToPath(new URL('../tests/fixtures/hosted-tree/clerk-react.mjs', import.meta.url)),
      },
    ],
  },
  plugins: [
    {
      name: 'qa-d-preview',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/qa-d.html') && !req.url?.includes('project-under-test')) return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__qaData=${JSON.stringify(fixtureData).replaceAll('<', '\\u003c')}</script><script type="module" src="/@fs/${entry}"></script></body></html>`,
          );
        });
      },
    },
  ],
});
await server.listen();
console.log('Synthetic QA-d: http://127.0.0.1:5356/qa-d.html?state=requested');
