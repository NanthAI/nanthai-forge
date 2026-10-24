// SPDX-License-Identifier: Apache-2.0
// Local synthetic Lane components only. No live Convex calls, credentials, or project mutations.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../web', import.meta.url));
const entry = fileURLToPath(new URL('../tests/fixtures/qa-h-lane.tsx', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 5198,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  plugins: [
    {
      name: 'qa-h-preview',
      configureServer(server) {
        server.middlewares.use('/qa-h.html', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
          );
        });
      },
    },
  ],
});
await server.listen();
console.log('Slice H preview: http://127.0.0.1:5198/qa-h.html?surface=lane');
