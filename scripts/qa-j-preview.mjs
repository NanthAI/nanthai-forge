// SPDX-License-Identifier: Apache-2.0
// Local synthetic URL settings; no credentials or hosted writes.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../web', import.meta.url));
const entry = fileURLToPath(new URL('../tests/fixtures/settings-polish.tsx', import.meta.url));
const fixture = fileURLToPath(new URL('../tests/fixtures/s1b-convex-react.mjs', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 5197,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  resolve: { alias: [{ find: /^convex\/react$/, replacement: fixture }] },
  plugins: [
    {
      name: 'settings-polish',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          if (!_req.url?.startsWith('/dino/')) return next();
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
console.log('Synthetic settings: http://127.0.0.1:5197/dino/nanthai-forge/settings/autonomy');
