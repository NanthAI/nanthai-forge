// SPDX-License-Identifier: Apache-2.0
// Synthetic read-model preview only: no owner or hosted calls.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../web', import.meta.url));
const entry = fileURLToPath(new URL('../tests/fixtures/s16-preview.tsx', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: {
    watch: null,
    host: '127.0.0.1',
    port: 5216,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  plugins: [
    {
      name: 's16-preview',
      configureServer(server) {
        server.middlewares.use('/s16.html', (_req, res) => {
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
console.log('S16 synthetic preview: http://127.0.0.1:5216/s16.html?surface=now&theme=light');
